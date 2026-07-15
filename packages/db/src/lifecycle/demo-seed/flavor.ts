import { and, eq } from "drizzle-orm";
import type { CanvassContract } from "@savvy/core";
import { adminDb } from "../../admin-client";
import { withTenant } from "../../tenant";
import { job } from "../../schema/jobs";
import { customer, lead } from "../../schema/crm";
import { estimate } from "../../schema/finance";
import { document } from "../../schema/ops";
import { createLeadForTenant } from "../lead-intake";
import { setLeadOwner } from "../leads";
import { convertLeadToJob } from "../appointments";
import { convertCanvassContractToJob } from "../canvass-conversion";
import { saveSketchMeasurement } from "../measurement";
import { draftLeadEstimateIfReady, setEstimateStatus } from "../estimate";
import { upsertClaim } from "../claim";
import { draftDepreciationInvoice } from "../depreciation-recovery";
import { ConversionBlockedError } from "../lead-tasks";
import { demoStaff, ensureLeadInspectionAppointment, type DemoLeadInput } from "./funnel";
import { squareSketch } from "./sketch-fixture";

/** Job/lead ids for the four flavor scenarios. `stuck` is a lead-stage sent estimate
 * with no job yet, so it carries the leadId (not a jobId). */
export interface FlavorIds {
  insurance: string;
  canvass: string;
  stuck: string;
  manual: string;
}

const FLAVOR_SEEDS = {
  insurance: { name: "Isla Insurance", phone: "+16025550501", email: "isla.insurance@demo.test", address: "501 E McDowell Rd, Phoenix, AZ 85006" },
  canvass: { name: "Cody Canvass", phone: "+16025550502", email: "cody.canvass@demo.test", address: "502 E McDowell Rd, Phoenix, AZ 85006" },
  stuck: { name: "Sam Stuck", phone: "+16025550503", email: "sam.stuck@demo.test", address: "503 E McDowell Rd, Phoenix, AZ 85006" },
  manual: { name: "Mia Manual", phone: "+16025550504", email: "mia.manual@demo.test", address: "504 E McDowell Rd, Phoenix, AZ 85006" },
} as const;

/** Idempotency: reuse a prior run's job for this natural key (customer phone),
 * mirroring `findExistingStageJob` in jobs.ts — `convertLeadToJob`/`createLeadForTenant`
 * do not dedupe on their own. */
async function findExistingJobByPhone(tenantId: string, phone: string): Promise<string | undefined> {
  const [row] = await adminDb
    .select({ id: job.id })
    .from(job)
    .innerJoin(customer, eq(customer.id, job.customerId))
    .where(and(eq(job.tenantId, tenantId), eq(customer.phone, phone)))
    .orderBy(job.createdAt, job.id)
    .limit(1);
  return row?.id;
}

/** Idempotency for lead-stage-only flavors (stuck): reuse a prior run's lead for this
 * natural key. `createLeadForTenant` does not dedupe leads by itself (only customers). */
async function findExistingLeadByPhone(tenantId: string, phone: string): Promise<string | undefined> {
  const [row] = await adminDb
    .select({ id: lead.id })
    .from(lead)
    .innerJoin(customer, eq(customer.id, lead.customerId))
    .where(and(eq(lead.tenantId, tenantId), eq(customer.phone, phone)))
    .orderBy(lead.createdAt, lead.id)
    .limit(1);
  return row?.id;
}

/** Idempotently attach a document of `kind` to a job (existence-guarded on tenant+job+kind+label). */
async function ensureJobDocument(
  tenantId: string,
  jobId: string,
  customerId: string,
  kind: string,
  label: string,
  extra: { r2Key?: string; filename?: string; mime?: string } = {},
): Promise<void> {
  const [existing] = await adminDb
    .select({ id: document.id })
    .from(document)
    .where(and(eq(document.tenantId, tenantId), eq(document.jobId, jobId), eq(document.kind, kind), eq(document.label, label)));
  if (existing) return;
  await adminDb.insert(document).values({
    tenantId,
    jobId,
    customerId,
    kind,
    label,
    source: "savvy",
    r2Key: extra.r2Key ?? null,
    filename: extra.filename ?? null,
    mime: extra.mime ?? null,
  });
}

async function jobRefs(jobId: string): Promise<{ customerId: string; propertyId: string }> {
  const [row] = await adminDb.select({ customerId: job.customerId, propertyId: job.propertyId }).from(job).where(eq(job.id, jobId));
  if (!row) throw new Error(`job ${jobId} not found`);
  return { customerId: row.customerId, propertyId: row.propertyId };
}

/** Convert a lead to a job, auto-resolving any open MANUAL lead tasks the same way
 * `seedApprovedJob` does (defensive — the current task registry has no `manual`-mode
 * per_lead tasks, so this branch is not expected to trigger, but conversion should
 * never hard-fail the seeder if tenant config changes). */
async function convertLeadToJobResolvingBlocks(args: {
  tenantId: string;
  leadId: string;
  manualJob?: boolean;
  reason?: string;
  trigger?: string;
}): Promise<{ jobId: string }> {
  try {
    const { jobId } = await convertLeadToJob(args);
    return { jobId };
  } catch (err) {
    if (err instanceof ConversionBlockedError) {
      const resolutions: Record<number, { status: "not_applicable"; reason: string }> = {};
      for (const taskId of err.openManualTaskIds) {
        resolutions[taskId] = { status: "not_applicable", reason: "demo seed: flavor job superseded" };
      }
      const { jobId } = await convertLeadToJob({ ...args, resolutions });
      return { jobId };
    }
    throw err;
  }
}

/**
 * INSURANCE flavor: an insurance-type job (via `lead.lane = 'storm'`, which
 * `leadToJobType` maps to job type 'insurance' — there is no lifecycle setter for
 * `lane`, same as the `score`/`status` direct writes in leads.ts's 'qualified' state)
 * with a real claim ledger, a drafted depreciation-recovery invoice, and an attached
 * insurance-estimate document.
 */
async function ensureInsuranceJob(tenantId: string, input: DemoLeadInput): Promise<string> {
  const existing = await findExistingJobByPhone(tenantId, input.phone);
  let jobId: string;
  if (existing) {
    jobId = existing;
  } else {
    const leadId = await createLeadForTenant(tenantId, {
      name: input.name,
      phone: input.phone,
      email: input.email,
      address: input.address,
      source: "insurance_agent",
      // Partner-class sources carry attribution (partner.attribution invariant);
      // create-once folds repeat seeds onto the same demo partner.
      partner: { name: "Dana Whitfield", org: "Summit Mutual Insurance" },
    });
    await withTenant(tenantId, async (tx) => {
      await setLeadOwner(tx, { tenantId, leadId, userId: input.assigneeUserId });
    });
    // No lifecycle setter exists for lead.lane — direct write, mirroring the
    // 'qualified' lead's direct score/status write in leads.ts.
    await adminDb.update(lead).set({ lane: "storm" }).where(and(eq(lead.id, leadId), eq(lead.tenantId, tenantId)));

    await ensureLeadInspectionAppointment(tenantId, leadId);

    const saved = await saveSketchMeasurement({ tenantId, scope: { kind: "lead", id: leadId }, sketch: input.sketch ?? squareSketch() });
    if ("error" in saved) throw new Error(`saveSketchMeasurement failed: ${saved.error}`);

    const drafted = await draftLeadEstimateIfReady({ tenantId, leadId });
    let estimateId: string;
    if ("estimateId" in drafted) {
      estimateId = drafted.estimateId;
    } else {
      const [row] = await adminDb.select({ id: estimate.id }).from(estimate).where(and(eq(estimate.tenantId, tenantId), eq(estimate.leadId, leadId)));
      if (!row) throw new Error(`draftLeadEstimateIfReady skipped (${drafted.skipped}) and no estimate found`);
      estimateId = row.id;
    }
    await setEstimateStatus({ tenantId, estimateId, status: "sent" });
    await setEstimateStatus({ tenantId, estimateId, status: "accepted" });

    const converted = await convertLeadToJobResolvingBlocks({ tenantId, leadId, trigger: "estimate-sign" });
    jobId = converted.jobId;
  }

  await upsertClaim({
    tenantId,
    jobId,
    carrierName: "Demo Mutual",
    claimNumber: "CLM-DEMO-1",
    acvCents: 1_450_000,
    rcvCents: 1_820_000,
    deductibleCents: 250_000,
    status: "approved",
  });

  await draftDepreciationInvoice({ tenantId, jobId });

  const { customerId } = await jobRefs(jobId);
  await ensureJobDocument(tenantId, jobId, customerId, "insurance_estimate", "Carrier estimate (Demo Mutual)", {
    r2Key: `${tenantId}/demo/insurance-estimate-${jobId}.pdf`,
    filename: "carrier-estimate.pdf",
    mime: "application/pdf",
  });

  return jobId;
}

/**
 * CANVASS flavor: a signed door-sale contract converts the lead to a job via the
 * REAL `convertCanvassContractToJob` (manualJob escape hatch — no accepted estimate
 * on a door sale). That function stamps `rescissionHoldUntil` (computed from
 * `contract.signedAt` — AZ = 3 statutory cooling-off days, see `rescissionReleaseAt`
 * in `@savvy/core`) + `canvassRepName`, but does NOT itself persist the contract as a
 * `document` — that's a separate step (`storeCanvassContract`) that lives in
 * `packages/agents` (R2-backed) and packages/db must not depend on packages/agents.
 * So the contract document is inserted directly here (same raw-insert pattern jobs.ts
 * uses for photos) rather than faked through the conversion.
 */
async function ensureCanvassJob(tenantId: string, input: DemoLeadInput, repName: string): Promise<string> {
  const existing = await findExistingJobByPhone(tenantId, input.phone);
  if (existing) return existing;

  const leadId = await createLeadForTenant(tenantId, {
    name: input.name,
    phone: input.phone,
    email: input.email,
    address: input.address,
    source: "canvass",
  });
  await withTenant(tenantId, async (tx) => {
    await setLeadOwner(tx, { tenantId, leadId, userId: input.assigneeUserId });
  });

  const contract: CanvassContract = {
    kind: "retail",
    document: "Roofing Install Agreement",
    fields: { Scope: "Full roof replacement — architectural shingles" },
    scopeItems: ["Tear-off existing roof", "Install synthetic underlayment", "Install architectural shingles", "New drip edge + flashing"],
    rep: repName,
    signedAt: new Date().toISOString(), // recent → rescission hold lands in the future
    consentElectronic: true,
    signaturePng: "data:image/png;base64,AAAA",
    termsText: "Standard door-to-door roofing agreement terms.",
  };

  const { jobId } = await convertCanvassContractToJob({ tenantId, leadId, contract });

  const [l] = await adminDb.select({ customerId: lead.customerId, propertyId: lead.propertyId }).from(lead).where(eq(lead.id, leadId));
  await ensureJobDocument(tenantId, jobId, l!.customerId!, "contract", contract.document, {
    filename: "canvass-contract.json",
    mime: "application/json",
  });

  return jobId;
}

/**
 * STUCK flavor: a lead-stage `sent` estimate with no homeowner response, backdated
 * ~12 days (sanctioned direct write — aging simulation, not a faked lifecycle
 * transition). Owned by Rep B.
 */
async function ensureStuckLead(tenantId: string, input: DemoLeadInput): Promise<string> {
  const existingLeadId = await findExistingLeadByPhone(tenantId, input.phone);
  let leadId: string;
  let estimateId: string;
  if (existingLeadId) {
    leadId = existingLeadId;
    const [row] = await adminDb.select({ id: estimate.id }).from(estimate).where(and(eq(estimate.tenantId, tenantId), eq(estimate.leadId, leadId)));
    if (!row) throw new Error(`stuck lead ${leadId} has no estimate on re-run`);
    estimateId = row.id;
  } else {
    leadId = await createLeadForTenant(tenantId, {
      name: input.name,
      phone: input.phone,
      email: input.email,
      address: input.address,
      source: "web",
    });
    await withTenant(tenantId, async (tx) => {
      await setLeadOwner(tx, { tenantId, leadId, userId: input.assigneeUserId });
    });
    await ensureLeadInspectionAppointment(tenantId, leadId);
    const saved = await saveSketchMeasurement({ tenantId, scope: { kind: "lead", id: leadId }, sketch: input.sketch ?? squareSketch() });
    if ("error" in saved) throw new Error(`saveSketchMeasurement failed: ${saved.error}`);
    const drafted = await draftLeadEstimateIfReady({ tenantId, leadId });
    if (!("estimateId" in drafted)) throw new Error(`draftLeadEstimateIfReady skipped (${drafted.skipped})`);
    estimateId = drafted.estimateId;
    await setEstimateStatus({ tenantId, estimateId, status: "sent" });
  }

  // Sanctioned direct write: backdate the aging clock ~12 days (no lifecycle fn
  // exists to simulate elapsed time — this isn't a faked transition, the estimate
  // really is 'sent'; only its age is post-hoc).
  const twelveDaysAgo = new Date(Date.now() - 12 * 86_400_000);
  await adminDb.update(estimate).set({ sentAt: twelveDaysAgo, createdAt: twelveDaysAgo }).where(eq(estimate.id, estimateId));

  return leadId;
}

/**
 * MANUAL-HATCH flavor: an owner walk-in cash job with no accepted estimate,
 * created via the REAL `convertLeadToJob({ manualJob: true, reason })` escape
 * hatch, plus an attached contract document on the resulting job.
 */
async function ensureManualJob(tenantId: string, input: DemoLeadInput): Promise<string> {
  const existing = await findExistingJobByPhone(tenantId, input.phone);
  if (existing) return existing;

  const leadId = await createLeadForTenant(tenantId, {
    name: input.name,
    phone: input.phone,
    email: input.email,
    address: input.address,
    source: "other",
  });
  await withTenant(tenantId, async (tx) => {
    await setLeadOwner(tx, { tenantId, leadId, userId: input.assigneeUserId });
  });

  const { jobId } = await convertLeadToJobResolvingBlocks({
    tenantId,
    leadId,
    manualJob: true,
    reason: "Owner hatch — walk-in cash job",
    trigger: "manual-hatch",
  });

  const { customerId } = await jobRefs(jobId);
  await ensureJobDocument(tenantId, jobId, customerId, "contract", "Walk-in Cash Contract");

  return jobId;
}

/**
 * Seed the four "flavor" jobs demonstrating real lifecycle special cases:
 * insurance (claim ledger + depreciation recovery), canvass (signed contract +
 * rescission hold), stuck (aged no-response lead estimate), and manual-hatch
 * (owner walk-in with no accepted estimate). Every job/estimate is produced via
 * real lifecycle functions; the only direct-column writes are `lead.lane`
 * (no lifecycle setter exists — same precedent as leads.ts) and the stuck
 * estimate's backdated aging clock (explicitly sanctioned by the task brief).
 */
export async function seedFlavorJobs(tenantId: string): Promise<FlavorIds> {
  const repA = await demoStaff(tenantId, "usr_demo_repA");
  const repB = await demoStaff(tenantId, "usr_demo_repB");

  const insurance = await ensureInsuranceJob(tenantId, { ...FLAVOR_SEEDS.insurance, assigneeUserId: repA });
  const canvass = await ensureCanvassJob(tenantId, { ...FLAVOR_SEEDS.canvass, assigneeUserId: repB }, "Rita RepB");
  const stuck = await ensureStuckLead(tenantId, { ...FLAVOR_SEEDS.stuck, assigneeUserId: repB });
  const manual = await ensureManualJob(tenantId, { ...FLAVOR_SEEDS.manual, assigneeUserId: repA });

  return { insurance, canvass, stuck, manual };
}
