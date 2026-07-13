import { and, eq } from "drizzle-orm";
import type { JobStage, LineItem, MaterialOrderLine } from "@savvy/core";
import { signPayloadToken } from "@savvy/core";
import { adminDb } from "../../admin-client";
import { withTenant } from "../../tenant";
import { job, jobChecklistItem } from "../../schema/jobs";
import { customer } from "../../schema/crm";
import { estimate, invoice } from "../../schema/finance";
import { document } from "../../schema/ops";
import { appointment } from "../../schema/comms";
import { bookingLink } from "../../schema/booking-link";
import { materialOrder } from "../../schema/procurement";
import { supplierInvoice } from "../../schema/supplier-invoice";
import { createInvoice, createInvoiceFromEstimate, sendInvoice, recordStripePayment } from "../invoices";
import { bookAppointment, SlotTakenError, convertLeadToJob } from "../appointments";
import { recomputeJobActualCost } from "../supplier-invoice";
import { createStatusLink } from "../booking-link";
import { recordStageChange } from "../record-stage-change";
import { createLeadForTenant } from "../lead-intake";
import { setLeadOwner } from "../leads";
import { saveSketchMeasurement } from "../measurement";
import { draftLeadEstimateIfReady } from "../estimate";
import { ConversionBlockedError } from "../lead-tasks";
import { squareSketch } from "./sketch-fixture";
import { seedApprovedJob, demoStaff, ensureLeadInspectionAppointment, type DemoLeadInput } from "./funnel";

/** Job ids keyed by the pipeline stage each one lands at (all derived from real evidence). */
export interface StageJobIds {
  inspected: string;
  estimate: string;
  approved: string;
  production: string;
  closeout: string;
  billing: string;
  complete: string;
}

/**
 * One demo job per pipeline stage. Deterministic natural keys (fixed phone/email/address)
 * make each idempotent: `ensureApprovedStageJob` reuses a prior run's job by the customer's
 * fixed phone (the funnel helpers do NOT dedupe leads), and every evidence insert below is
 * existence-guarded, so a second run is a no-op.
 */
const STAGE_SEEDS: Record<keyof StageJobIds, { name: string; phone: string; email: string; address: string }> = {
  inspected: { name: "Ingrid Inspected", phone: "+16025550406", email: "ingrid.inspected@demo.test", address: "406 N Central Ave, Phoenix, AZ 85004" },
  estimate: { name: "Ezra Estimate", phone: "+16025550407", email: "ezra.estimate@demo.test", address: "407 N Central Ave, Phoenix, AZ 85004" },
  approved: { name: "Ava Approved", phone: "+16025550410", email: "ava.approved@demo.test", address: "410 N Central Ave, Phoenix, AZ 85004" },
  production: { name: "Pedro Production", phone: "+16025550420", email: "pedro.production@demo.test", address: "420 N Central Ave, Phoenix, AZ 85004" },
  closeout: { name: "Cora Closeout", phone: "+16025550430", email: "cora.closeout@demo.test", address: "430 N Central Ave, Phoenix, AZ 85004" },
  billing: { name: "Bill Billing", phone: "+16025550440", email: "bill.billing@demo.test", address: "440 N Central Ave, Phoenix, AZ 85004" },
  complete: { name: "Cleo Complete", phone: "+16025550450", email: "cleo.complete@demo.test", address: "450 N Central Ave, Phoenix, AZ 85004" },
};

// Crew installs are booked far in the future (well past every other seeder's window) and
// one whole day apart per job, so the shared crew's bookings don't overlap. The shared dev
// Postgres may carry leftover appts from prior runs, so bookings step forward on collision.
const CREW_SLOT_BASE_DAYS = 250;
const MAX_CREW_SLOT_RETRIES = 60;

/** A far-future weekday crew slot, `dayOffset` whole days past the base. 09:00–13:00 Phoenix (UTC-7). */
function crewSlot(dayOffset: number): { startsAt: Date; endsAt: Date } {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + CREW_SLOT_BASE_DAYS + dayOffset);
  start.setUTCHours(16, 0, 0, 0); // 09:00 Phoenix
  const end = new Date(start.getTime() + 4 * 3_600_000);
  return { startsAt: start, endsAt: end };
}

/** Idempotency: a prior seed run's job for this natural key (the seed customer's fixed phone).
 *  `seedApprovedJob`/`createLeadForTenant` do NOT dedupe leads, so without this a second run
 *  would mint a fresh lead+job. Reusing the existing job keeps `seedStageJobs` idempotent. */
async function findExistingStageJob(tenantId: string, phone: string): Promise<string | undefined> {
  const [row] = await adminDb
    .select({ id: job.id })
    .from(job)
    .innerJoin(customer, eq(customer.id, job.customerId))
    .where(and(eq(job.tenantId, tenantId), eq(customer.phone, phone)))
    // Oldest-first so re-runs deterministically reuse the SAME job even if the shared dev
    // Postgres carries stray jobs for this phone from earlier (unguarded) seed runs.
    .orderBy(job.createdAt, job.id)
    .limit(1);
  return row?.id;
}

/** Reuse the existing seeded job for this natural key, else run the approved-job funnel. */
async function ensureApprovedStageJob(tenantId: string, input: DemoLeadInput): Promise<string> {
  const existing = await findExistingStageJob(tenantId, input.phone);
  if (existing) return existing;
  const { jobId } = await seedApprovedJob(tenantId, input);
  return jobId;
}

/** Convert a lead to a job, auto-resolving any open MANUAL lead tasks the same way
 * `seedApprovedJob` does (mirrors flavor.ts's identically-named private helper — kept
 * local rather than shared since each file's error-resolution note differs). */
async function convertLeadToJobResolvingBlocks(args: {
  tenantId: string;
  leadId: string;
  manualJob?: boolean;
  reason?: string;
  trigger?: string;
}): Promise<{ jobId: string }> {
  try {
    return await convertLeadToJob(args);
  } catch (err) {
    if (err instanceof ConversionBlockedError) {
      const resolutions: Record<number, { status: "not_applicable"; reason: string }> = {};
      for (const taskId of err.openManualTaskIds) {
        resolutions[taskId] = { status: "not_applicable", reason: "demo seed: stage job superseded" };
      }
      return await convertLeadToJob({ ...args, resolutions });
    }
    throw err;
  }
}

/**
 * Reuse the existing seeded job for this natural key, else drive a lead through a
 * DONE inspection (evidence: `inspection`) with NO estimate, then convert it via the
 * `manualJob` escape hatch (no accepted estimate exists yet). `deriveContiguousStage`
 * gathers evidence fresh on conversion and lands the job at exactly `inspected` — the
 * evidence chain is real, only the funnel skip (no estimate drafted) is deliberate.
 */
async function ensureInspectedStageJob(tenantId: string, input: DemoLeadInput): Promise<string> {
  const existing = await findExistingStageJob(tenantId, input.phone);
  if (existing) return existing;
  const leadId = await createLeadForTenant(tenantId, {
    name: input.name, phone: input.phone, email: input.email, address: input.address, source: "web",
  });
  await withTenant(tenantId, async (tx) => {
    await setLeadOwner(tx, { tenantId, leadId, userId: input.assigneeUserId });
  });
  await ensureLeadInspectionAppointment(tenantId, leadId);
  const { jobId } = await convertLeadToJobResolvingBlocks({
    tenantId, leadId, manualJob: true, reason: "demo seed: inspected-stage evidence snapshot (no estimate drafted yet)",
  });
  return jobId;
}

/**
 * Reuse the existing seeded job for this natural key, else drive a lead through a DONE
 * inspection + a DRAFTED (not accepted) estimate — `gatherStageEvidence`'s `estimate` key
 * only requires an estimate to exist, not be sent/accepted — then convert via `manualJob`
 * (still no *accepted* estimate). Lands at exactly `estimate`.
 */
async function ensureEstimateStageJob(tenantId: string, input: DemoLeadInput): Promise<string> {
  const existing = await findExistingStageJob(tenantId, input.phone);
  if (existing) return existing;
  const leadId = await createLeadForTenant(tenantId, {
    name: input.name, phone: input.phone, email: input.email, address: input.address, source: "web",
  });
  await withTenant(tenantId, async (tx) => {
    await setLeadOwner(tx, { tenantId, leadId, userId: input.assigneeUserId });
  });
  await ensureLeadInspectionAppointment(tenantId, leadId);
  const saved = await saveSketchMeasurement({ tenantId, scope: { kind: "lead", id: leadId }, sketch: squareSketch() });
  if ("error" in saved) throw new Error(`saveSketchMeasurement failed: ${saved.error}`);
  const drafted = await draftLeadEstimateIfReady({ tenantId, leadId });
  if (!("estimateId" in drafted)) throw new Error(`draftLeadEstimateIfReady skipped (${drafted.skipped})`);
  const { jobId } = await convertLeadToJobResolvingBlocks({
    tenantId, leadId, manualJob: true, reason: "demo seed: estimate-stage evidence snapshot (estimate drafted but not accepted)",
  });
  return jobId;
}

/** The accepted, job-stamped estimate for a job (created lead-stage, stamped on conversion). */
async function jobEstimateId(tenantId: string, jobId: string): Promise<string> {
  const [row] = await adminDb.select({ id: estimate.id }).from(estimate).where(and(eq(estimate.tenantId, tenantId), eq(estimate.jobId, jobId)));
  if (!row) throw new Error(`no job-stamped estimate for job ${jobId}`);
  return row.id;
}

async function jobRefs(jobId: string): Promise<{ customerId: string; propertyId: string }> {
  const [row] = await adminDb.select({ customerId: job.customerId, propertyId: job.propertyId }).from(job).where(eq(job.id, jobId));
  if (!row) throw new Error(`job ${jobId} not found`);
  return { customerId: row.customerId, propertyId: row.propertyId };
}

/** Idempotently attach ONE material order to a job (unique per estimate).
 *  NOTE: a `draft` order is NOT production evidence (gatherStageEvidence only counts
 *  status IN ('ordered','delivered')), so the approved-stage job carries PENDING (draft)
 *  materials and stably stays at `approved` — never drifting to production on re-derive. */
async function ensureMaterialOrder(tenantId: string, jobId: string, estimateId: string, status: "draft" | "ordered" | "delivered"): Promise<void> {
  const [existing] = await adminDb.select({ id: materialOrder.id }).from(materialOrder).where(eq(materialOrder.estimateId, estimateId));
  const lines: MaterialOrderLine[] = [
    { key: "shingle-arch", name: "Architectural shingles (sq)", quantity: 20, unit: "square", unitPriceCents: 12_000, amountCents: 240_000, unitCostCents: 8_500, lineCostCents: 170_000 },
    { key: "underlayment", name: "Synthetic underlayment (roll)", quantity: 6, unit: "each", unitPriceCents: 9_000, amountCents: 54_000, unitCostCents: 6_000, lineCostCents: 36_000 },
  ];
  const costSubtotal = lines.reduce((s, l) => s + (l.lineCostCents ?? 0), 0);
  const subtotal = lines.reduce((s, l) => s + l.amountCents, 0);
  const now = new Date();
  // A draft is not yet ordered (so no orderedAt); ordered/delivered carry an ordered timestamp.
  const orderedAt = status === "draft" ? null : now;
  const deliveredAt = status === "delivered" ? now : null;
  if (existing) {
    await adminDb.update(materialOrder).set({ status, orderedAt, deliveredAt }).where(eq(materialOrder.id, existing.id));
    return;
  }
  await adminDb.insert(materialOrder).values({
    tenantId, jobId, estimateId, status, lineItems: lines,
    subtotalCents: subtotal, costSubtotalCents: costSubtotal,
    orderedAt, deliveredAt,
  });
}

/** Idempotently attach a parsed supplier invoice (landed-cost actual) so recomputeJobActualCost
 *  has real actuals to compare against the material-order estimate. */
async function ensureSupplierInvoice(tenantId: string, jobId: string): Promise<void> {
  const msgId = `demo-supplier-${jobId}`;
  const [existing] = await adminDb.select({ id: supplierInvoice.id }).from(supplierInvoice)
    .where(and(eq(supplierInvoice.tenantId, tenantId), eq(supplierInvoice.externalMessageId, msgId)));
  if (existing) return;
  await adminDb.insert(supplierInvoice).values({
    tenantId, jobId, status: "parsed", supplierName: "ABC Supply", invoiceNumber: `SUP-${jobId.slice(0, 8)}`,
    totalCents: 208_000, parseConfidence: 0.98, externalMessageId: msgId,
    lines: [
      { key: "shingle-arch", name: "Architectural shingles (sq)", quantity: 20, unitCostCents: 8_600, lineCostCents: 172_000 },
      { key: "underlayment", name: "Synthetic underlayment (roll)", quantity: 6, unitCostCents: 6_000, lineCostCents: 36_000 },
    ] as never,
  });
}

/** Idempotently attach a kind='photo' document with the given label. */
async function ensurePhoto(tenantId: string, jobId: string, customerId: string, label: string): Promise<void> {
  const [existing] = await adminDb.select({ id: document.id }).from(document)
    .where(and(eq(document.tenantId, tenantId), eq(document.jobId, jobId), eq(document.kind, "photo"), eq(document.label, label)));
  if (existing) return;
  await adminDb.insert(document).values({
    tenantId, jobId, customerId, kind: "photo", label,
    source: "savvy", filename: `${label.replace(/\s+/g, "-")}.jpg`, mime: "image/jpeg",
  });
}

/** Idempotently book a scheduled crew (install) appointment for a job. */
async function ensureCrewAppointment(tenantId: string, jobId: string, crewUserId: string, slotIndex: number): Promise<void> {
  const [existing] = await adminDb.select({ id: appointment.id }).from(appointment)
    .where(and(eq(appointment.tenantId, tenantId), eq(appointment.jobId, jobId), eq(appointment.type, "crew")));
  if (existing) return;
  // Step forward past any leftover/colliding crew booking on the shared crew user.
  for (let attempt = 0; attempt < MAX_CREW_SLOT_RETRIES; attempt++) {
    const { startsAt, endsAt } = crewSlot(slotIndex + attempt);
    try {
      await bookAppointment({ tenantId, jobId, type: "crew", assigneeUserId: crewUserId, startsAt, endsAt });
      return;
    } catch (err) {
      if (err instanceof SlotTakenError) continue;
      throw err;
    }
  }
  throw new Error(`ensureCrewAppointment: exhausted ${MAX_CREW_SLOT_RETRIES} slot retries for job ${jobId}`);
}

/** Idempotently insert a job checklist item (punch / warranty / review row). */
async function ensureChecklistItem(
  tenantId: string,
  jobId: string,
  key: string,
  title: string,
  status: "pending" | "done",
  stage?: JobStage,
): Promise<void> {
  const [existing] = await adminDb.select({ id: jobChecklistItem.id }).from(jobChecklistItem)
    .where(and(eq(jobChecklistItem.tenantId, tenantId), eq(jobChecklistItem.jobId, jobId), eq(jobChecklistItem.key, key)));
  if (existing) return;
  await adminDb.insert(jobChecklistItem).values({
    tenantId, jobId, key, title, status,
    payload: stage ? { stage } : {},
  });
}

/** Idempotently mint a homeowner status link (short code over a signed status token). */
async function ensureStatusLink(tenantId: string, jobId: string): Promise<void> {
  // Reuse: a status link's token is deterministic per (tenant, job); if one already resolves, skip.
  const token = signPayloadToken({ tenantId, jobId }, process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret");
  const [existing] = await adminDb.select({ id: bookingLink.id }).from(bookingLink)
    .where(and(eq(bookingLink.tenantId, tenantId), eq(bookingLink.token, token)));
  if (existing) return;
  await createStatusLink({ tenantId, token });
}

/** Idempotently create + send a job-scoped deposit invoice (draft → sent). */
async function ensureDepositInvoice(tenantId: string, jobId: string): Promise<void> {
  const marker = "Deposit (demo)";
  const existing = await findInvoiceByMarker(tenantId, jobId, marker);
  if (existing) return;
  const lineItems: LineItem[] = [{ description: marker, qty: 1, unitAmountCents: 100_000 }];
  const inv = await createInvoice({ tenantId, jobId, lineItems });
  await sendInvoice({ tenantId, invoiceId: inv.id });
}

async function findInvoiceByMarker(tenantId: string, jobId: string, marker: string): Promise<string | undefined> {
  const rows = await adminDb.select({ id: invoice.id, lineItems: invoice.lineItems }).from(invoice)
    .where(and(eq(invoice.tenantId, tenantId), eq(invoice.jobId, jobId)));
  for (const r of rows) {
    const items = (r.lineItems as { description?: string }[] | null) ?? [];
    if (items.some((li) => li.description === marker)) return r.id;
  }
  return undefined;
}

/** Idempotently create the final invoice from the accepted estimate and send it. Returns its id + amountDue. */
async function ensureFinalInvoice(tenantId: string, jobId: string, estimateId: string): Promise<{ invoiceId: string; amountDue: number }> {
  // Reuse an existing sent/paid final invoice keyed off the estimate's line-items (no deposit marker).
  const rows = await adminDb.select({ id: invoice.id, amountDue: invoice.amountDue, status: invoice.status, lineItems: invoice.lineItems }).from(invoice)
    .where(and(eq(invoice.tenantId, tenantId), eq(invoice.jobId, jobId)));
  const final = rows.find((r) => {
    const items = (r.lineItems as { description?: string }[] | null) ?? [];
    return !items.some((li) => li.description === "Deposit (demo)" || li.description === "Balance — overdue (demo)");
  });
  if (final) {
    if (final.status === "draft") await sendInvoice({ tenantId, invoiceId: final.id });
    return { invoiceId: final.id, amountDue: final.amountDue ?? 0 };
  }
  const inv = await createInvoiceFromEstimate({ tenantId, estimateId });
  const sent = await sendInvoice({ tenantId, invoiceId: inv.id });
  return { invoiceId: sent.id, amountDue: sent.amountDue ?? inv.amountDue ?? 0 };
}

/** Idempotently create a separate ~50-day-old OVERDUE receivable (the one sanctioned post-hoc write). */
async function ensureOverdueReceivable(tenantId: string, jobId: string): Promise<void> {
  const marker = "Balance — overdue (demo)";
  const existingId = await findInvoiceByMarker(tenantId, jobId, marker);
  if (existingId) return;
  const lineItems: LineItem[] = [{ description: marker, qty: 1, unitAmountCents: 350_000 }];
  const inv = await createInvoice({ tenantId, jobId, lineItems });
  await sendInvoice({ tenantId, invoiceId: inv.id });
  // Post-hoc aging: backdate created_at/due_at ~50 days and flip to overdue.
  const fiftyDaysAgo = new Date(Date.now() - 50 * 86_400_000);
  await adminDb.update(invoice).set({ status: "overdue", createdAt: fiftyDaysAgo, dueAt: fiftyDaysAgo }).where(eq(invoice.id, inv.id));
}

/** Drive a job to `toStage` via the evidence gate (throws loudly if evidence is missing). */
async function advanceTo(tenantId: string, jobId: string, toStage: JobStage): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await recordStageChange(tx, { tenantId, jobId, toStage, byAgent: "orchestrator" });
  });
}

export async function seedStageJobs(tenantId: string): Promise<StageJobIds> {
  const repA = await demoStaff(tenantId, "usr_demo_repA");
  const crew = await demoStaff(tenantId, "usr_demo_crew");
  const mk = (state: keyof StageJobIds): DemoLeadInput => ({ ...STAGE_SEEDS[state], assigneeUserId: repA });

  // ---- inspected: done inspection, no estimate drafted yet.
  const inspectedJob = await ensureInspectedStageJob(tenantId, mk("inspected"));

  // ---- estimate: done inspection + a drafted (unsent, unaccepted) estimate.
  const estimateJob = await ensureEstimateStageJob(tenantId, mk("estimate"));

  // ---- approved: as seedApprovedJob lands it, plus deposit invoice + PENDING (draft) material
  // order + landed cost. Materials are draft (not ordered) so they are NOT production evidence —
  // the approved job holds no evidence above its stage and stays at `approved` across re-runs.
  const approvedJob = await ensureApprovedStageJob(tenantId, mk("approved"));
  {
    const estimateId = await jobEstimateId(tenantId, approvedJob);
    await ensureDepositInvoice(tenantId, approvedJob);
    await ensureMaterialOrder(tenantId, approvedJob, estimateId, "draft");
    // Landed cost still resolves: recomputeJobActualCost prefers the parsed supplier-invoice
    // actuals (selectJobCost), which don't depend on the material order's status.
    await ensureSupplierInvoice(tenantId, approvedJob);
    await recomputeJobActualCost(tenantId, approvedJob);
  }

  // ---- production: crew appt + delivered materials + mid-job photos + open punch item + status link.
  const productionJob = await ensureApprovedStageJob(tenantId, mk("production"));
  {
    const estimateId = await jobEstimateId(tenantId, productionJob);
    const { customerId } = await jobRefs(productionJob);
    await ensureCrewAppointment(tenantId, productionJob, crew, 0);
    await ensureMaterialOrder(tenantId, productionJob, estimateId, "delivered");
    await ensurePhoto(tenantId, productionJob, customerId, "tear-off");
    await ensurePhoto(tenantId, productionJob, customerId, "dry-in");
    await ensureChecklistItem(tenantId, productionJob, "punch-flashing", "Reflash chimney counter-flashing", "pending", "production");
    await ensureStatusLink(tenantId, productionJob);
    await advanceTo(tenantId, productionJob, "production");
  }

  // ---- closeout: production evidence + before/after completion photos (closeoutPhotos satisfied).
  const closeoutJob = await ensureApprovedStageJob(tenantId, mk("closeout"));
  {
    const { customerId } = await jobRefs(closeoutJob);
    await ensureCrewAppointment(tenantId, closeoutJob, crew, 1);
    await ensurePhoto(tenantId, closeoutJob, customerId, "before");
    await ensurePhoto(tenantId, closeoutJob, customerId, "after");
    await advanceTo(tenantId, closeoutJob, "closeout");
  }

  // ---- billing: closeout evidence + final invoice (PARTIAL payment) + separate 50-day overdue receivable.
  const billingJob = await ensureApprovedStageJob(tenantId, mk("billing"));
  {
    const estimateId = await jobEstimateId(tenantId, billingJob);
    const { customerId } = await jobRefs(billingJob);
    await ensureCrewAppointment(tenantId, billingJob, crew, 2);
    await ensurePhoto(tenantId, billingJob, customerId, "before");
    await ensurePhoto(tenantId, billingJob, customerId, "after");
    const { invoiceId, amountDue } = await ensureFinalInvoice(tenantId, billingJob, estimateId);
    await recordStripePayment({ tenantId, invoiceId, stripePaymentId: `demo-partial-${billingJob}`, method: "card", amountCents: Math.floor(amountDue / 2) });
    await ensureOverdueReceivable(tenantId, billingJob);
    await advanceTo(tenantId, billingJob, "billing");
  }

  // ---- complete: closeout evidence + before/after photos + final invoice FULLY paid + warranty/review rows.
  const completeJob = await ensureApprovedStageJob(tenantId, mk("complete"));
  {
    const estimateId = await jobEstimateId(tenantId, completeJob);
    const { customerId } = await jobRefs(completeJob);
    await ensureCrewAppointment(tenantId, completeJob, crew, 3);
    await ensurePhoto(tenantId, completeJob, customerId, "before");
    await ensurePhoto(tenantId, completeJob, customerId, "after");
    const { invoiceId, amountDue } = await ensureFinalInvoice(tenantId, completeJob, estimateId);
    await recordStripePayment({ tenantId, invoiceId, stripePaymentId: `demo-final-${completeJob}`, method: "card", amountCents: amountDue });
    await ensureChecklistItem(tenantId, completeJob, "warranty-register", "Register manufacturer workmanship warranty", "done", "complete");
    await ensureChecklistItem(tenantId, completeJob, "review-request", "Send homeowner review request", "done", "complete");
    await advanceTo(tenantId, completeJob, "complete");
  }

  return {
    inspected: inspectedJob, estimate: estimateJob,
    approved: approvedJob, production: productionJob, closeout: closeoutJob, billing: billingJob, complete: completeJob,
  };
}
