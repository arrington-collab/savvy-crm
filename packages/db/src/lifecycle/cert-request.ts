import { createHmac } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { parsePartnerLedgerConfig, parseCityFromAddress, requireSecret, roofAgeRange, type RoofAgeRange } from "@savvy/core";
import { withTenant } from "../tenant";
import { adminDb } from "../admin-client";
import { certRequest } from "../schema/cert";
import { partner } from "../schema/partner";
import { customer, property } from "../schema/crm";
import { inspection, inspectionZone, inspectionFinding, inspectionMedia } from "../schema/inspection";
import { document } from "../schema/ops";
import { license } from "../schema/compliance";
import { job } from "../schema/jobs";
import { bookingLink } from "../schema/booking-link";
import { tenant as tenantTbl } from "../schema/tenancy";
import { user } from "../schema/tenancy";
import { bookAppointment } from "./appointments";
import { createInvoice, sendInvoice, StripeNotConnectedError } from "./invoices";
import { accrueLedgerEntryTx } from "./partner-ledger";

// The cert page link is permanent and deterministic, same recipe as the Roof
// Record link (record-page.ts) with its own namespace prefix.
function certSig(tenantId: string, certRequestId: string): string {
  const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
  return createHmac("sha256", secret).update(`cert:${tenantId}:${certRequestId}`).digest("base64url").slice(0, 24);
}

export function certLinkToken(tenantId: string, certRequestId: string): string {
  return `${certRequestId}.${certSig(tenantId, certRequestId)}`;
}

/** code → verified {tenantId, certRequestId}; null on bad signature/unknown code. */
export async function resolveCertLink(code: string): Promise<{ tenantId: string; certRequestId: string } | null> {
  const [row] = await adminDb.select({ tenantId: bookingLink.tenantId, token: bookingLink.token, kind: bookingLink.kind })
    .from(bookingLink).where(eq(bookingLink.code, code));
  if (!row || row.kind !== "cert") return null;
  const [certRequestId, sig] = row.token.split(".");
  if (!certRequestId || sig !== certSig(row.tenantId, certRequestId)) return null;
  return { tenantId: row.tenantId, certRequestId };
}

async function loadConfig(tenantId: string) {
  const [t] = await adminDb.select({ settings: tenantTbl.settings }).from(tenantTbl).where(eq(tenantTbl.id, tenantId));
  return parsePartnerLedgerConfig((t?.settings as { partnerLedger?: unknown } | null)?.partnerLedger);
}

export type CreateCertRequestInput = {
  partnerId: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  address: string;
  requestedAt?: Date;
};

/** Office/partner creates a cert request. NO lead — certs never enter the funnel. */
export async function createCertRequest(
  tenantId: string,
  input: CreateCertRequestInput,
): Promise<{ certRequestId: string } | { error: string }> {
  const cfg = await loadConfig(tenantId);
  if (!cfg.certLaneEnabled) return { error: "cert_lane_disabled" };
  return withTenant(tenantId, async (tx) => {
    const [p] = await tx.select({ id: partner.id }).from(partner)
      .where(and(eq(partner.tenantId, tenantId), eq(partner.id, input.partnerId)));
    if (!p) return { error: "unknown_partner" };

    const [c] = await tx.insert(customer).values({
      tenantId, name: input.customerName, email: input.customerEmail ?? null, phone: input.customerPhone ?? null,
      // Implied consent (business-relationship basis) — a partner-referred cert
      // request customer. See packages/db/src/scripts/backfill-implied-consent.ts.
      smsConsentAt: input.customerPhone ? sql`now()` : null,
    }).returning();
    const [prop] = await tx.insert(property).values({
      tenantId, customerId: c!.id, address: input.address, city: parseCityFromAddress(input.address),
    }).returning();
    const [row] = await tx.insert(certRequest).values({
      tenantId, partnerId: input.partnerId, customerId: c!.id, propertyId: prop!.id,
      priceCents: cfg.certPriceCents, customerEmail: input.customerEmail ?? null,
      requestedAt: input.requestedAt ?? new Date(),
    }).returning();
    return { certRequestId: row!.id };
  });
}

/** Book the inspection appointment and start a kind:cert inspection (leadless). */
export async function bookCertRequest(
  tenantId: string,
  input: { certRequestId: string; assigneeUserId: string; startsAt: Date; endsAt: Date },
): Promise<{ appointmentId: string; inspectionId: string } | { error: string }> {
  const req = await withTenant(tenantId, async (tx) => {
    const [r] = await tx.select().from(certRequest)
      .where(and(eq(certRequest.tenantId, tenantId), eq(certRequest.id, input.certRequestId)));
    return r;
  });
  if (!req) return { error: "not_found" };
  if (req.status !== "requested") return { error: "not_requestable" };

  const { id: appointmentId } = await bookAppointment({
    tenantId, propertyId: req.propertyId, customerId: req.customerId,
    type: "inspection", assigneeUserId: input.assigneeUserId,
    startsAt: input.startsAt, endsAt: input.endsAt,
  });

  return withTenant(tenantId, async (tx) => {
    const [insp] = await tx.insert(inspection).values({
      tenantId, propertyId: req.propertyId, inspectorUserId: input.assigneeUserId,
      kind: "cert", status: "in_progress",
    }).returning();
    await tx.update(certRequest)
      .set({ status: "booked", appointmentId, inspectionId: insp!.id })
      .where(eq(certRequest.id, req.id));
    return { appointmentId, inspectionId: insp!.id };
  });
}

/**
 * Deliver: leadless billing job + invoice (sent when Stripe is connected,
 * draft otherwise — delivery never blocks on billing config) + permanent cert
 * link + cert_sale REVENUE ledger entry. Every step is stamp-guarded, so a
 * replay or crash-resume is free.
 */
export async function deliverCertRequest(
  tenantId: string,
  input: { certRequestId: string; now?: Date },
): Promise<{ delivered: true; certCode: string } | { error: string }> {
  const now = input.now ?? new Date();
  const state = await withTenant(tenantId, async (tx) => {
    const [r] = await tx.select().from(certRequest)
      .where(and(eq(certRequest.tenantId, tenantId), eq(certRequest.id, input.certRequestId)));
    if (!r) return { error: "not_found" as const };
    if (r.status === "declined") return { error: "declined" as const };
    if (!r.inspectionId) return { error: "inspection_not_approved" as const };
    const [insp] = await tx.select({ approvedAt: inspection.approvedAt }).from(inspection).where(eq(inspection.id, r.inspectionId));
    if (!insp?.approvedAt) return { error: "inspection_not_approved" as const };
    return { req: r };
  });
  const errorCode = "error" in state ? state.error : null;
  if (errorCode) {
    // A delivered request replays as success (idempotent public contract).
    const done = await withTenant(tenantId, async (tx) => {
      const [r] = await tx.select({ status: certRequest.status, certCode: certRequest.certCode }).from(certRequest)
        .where(and(eq(certRequest.tenantId, tenantId), eq(certRequest.id, input.certRequestId)));
      return r?.status === "delivered" && r.certCode ? r.certCode : null;
    });
    if (done) return { delivered: true, certCode: done };
    return { error: errorCode };
  }
  const req = (state as { req: typeof certRequest.$inferSelect }).req;

  // 1. Billing job (lead_id NULL — never a funnel win).
  let jobId = req.jobId;
  if (!jobId) {
    jobId = await withTenant(tenantId, async (tx) => {
      const [j] = await tx.insert(job).values({
        tenantId, customerId: req.customerId, propertyId: req.propertyId,
        type: "repair", stage: "billing", valueFinal: req.priceCents,
      }).returning({ id: job.id });
      await tx.update(certRequest).set({ jobId: j!.id }).where(eq(certRequest.id, req.id));
      return j!.id;
    });
  }

  // 2. Invoice via the existing rails; Stripe-less tenants keep a draft.
  if (!req.invoiceId) {
    const inv = await createInvoice({
      tenantId, jobId,
      lineItems: [{ description: "Roof certification (pre-sale inspection report)", qty: 1, unitAmountCents: req.priceCents }],
    });
    await withTenant(tenantId, (tx) => tx.update(certRequest).set({ invoiceId: inv.id }).where(eq(certRequest.id, req.id)));
    try {
      await sendInvoice({ tenantId, invoiceId: inv.id });
    } catch (e) {
      if (!(e instanceof StripeNotConnectedError)) throw e;
    }
  }

  // 3. Permanent tokenized cert page link (booking_link kind 'cert').
  let certCode = req.certCode;
  if (!certCode) {
    const token = certLinkToken(tenantId, req.id);
    const [existing] = await adminDb.select({ code: bookingLink.code }).from(bookingLink)
      .where(and(eq(bookingLink.tenantId, tenantId), eq(bookingLink.token, token)));
    certCode = existing?.code ?? null;
    if (!certCode) {
      for (let attempt = 0; attempt < 5 && !certCode; attempt++) {
        const code = Math.random().toString(36).slice(2, 9);
        try {
          await adminDb.insert(bookingLink).values({ tenantId, code, token, kind: "cert", expiresAt: null });
          certCode = code;
        } catch (err: unknown) {
          if (!(err instanceof Error && err.message.includes("23505"))) throw err;
        }
      }
      if (!certCode) return { error: "link_generation_failed" };
    }
    await withTenant(tenantId, (tx) => tx.update(certRequest).set({ certCode }).where(eq(certRequest.id, req.id)));
  }

  // 4. The sale is partner-attributed REVENUE (idempotent by source_ref).
  await withTenant(tenantId, (tx) =>
    accrueLedgerEntryTx(tx, tenantId, {
      partnerId: req.partnerId, kind: "cert_sale", direction: "revenue",
      amountCents: req.priceCents, sourceRef: `cert_request:${req.id}`, occurredAt: now,
    }),
  );

  await withTenant(tenantId, (tx) =>
    tx.update(certRequest).set({ status: "delivered", deliveredAt: req.deliveredAt ?? now }).where(eq(certRequest.id, req.id)),
  );
  return { delivered: true, certCode };
}

/** Human decline. A cert that was produced (inspection completed) but not sold accrues the nominal generation cost. */
export async function declineCertRequest(
  tenantId: string,
  input: { certRequestId: string; reason: string; now?: Date },
): Promise<{ declined: boolean }> {
  const now = input.now ?? new Date();
  const cfg = await loadConfig(tenantId);
  return withTenant(tenantId, async (tx) => {
    const [r] = await tx.select().from(certRequest)
      .where(and(eq(certRequest.tenantId, tenantId), eq(certRequest.id, input.certRequestId)));
    if (!r || r.status === "delivered" || r.status === "declined") return { declined: false };

    if (r.inspectionId) {
      const [insp] = await tx.select({ completedAt: inspection.completedAt }).from(inspection).where(eq(inspection.id, r.inspectionId));
      if (insp?.completedAt) {
        await accrueLedgerEntryTx(tx, tenantId, {
          partnerId: r.partnerId, kind: "cert_cost", amountCents: cfg.certGenerationCostCents,
          sourceRef: `cert_request:${r.id}:declined`, occurredAt: now,
        });
      }
    }
    await tx.update(certRequest)
      .set({ status: "declined", declinedAt: now, declineReason: input.reason })
      .where(eq(certRequest.id, r.id));
    return { declined: true };
  });
}

export type CertPageZone = {
  zoneKey: string;
  zoneLabel: string;
  grade: string | null;
  summary: string | null;
  photos: { documentId: string; r2Key: string | null }[];
};

export type CertPageData = {
  certRequestId: string;
  deliveredAt: Date;
  address: string;
  narrative: string | null;
  zones: CertPageZone[];
  // Confirmed findings rendered as NEUTRAL condition notes — what it is, what
  // ignoring it means, the timeframe. Deliberately NO dispositions, NO repair
  // pricing, NO free-repair framing: a paid deliverable never sells.
  conditionNotes: { whatItIs: string; ifIgnored: string | null; timeframe: string | null }[];
  ageRange: RoofAgeRange | null;
  companyName: string;
  licenses: { state: string; licenseNumber: string }[];
  inspectorFirstName: string | null;
};

/** Everything the cert page renders — ONLY for a delivered cert (approval + delivery gates upstream). */
export async function getCertPageData(tenantId: string, certRequestId: string): Promise<CertPageData | null> {
  return withTenant(tenantId, async (tx) => {
    const [req] = await tx.select().from(certRequest)
      .where(and(eq(certRequest.tenantId, tenantId), eq(certRequest.id, certRequestId)));
    if (!req || req.status !== "delivered" || !req.deliveredAt || !req.inspectionId) return null;

    const [insp] = await tx.select().from(inspection).where(eq(inspection.id, req.inspectionId));
    if (!insp?.approvedAt) return null;

    const [prop] = await tx.select().from(property).where(eq(property.id, req.propertyId));
    const inspector = insp.inspectorUserId
      ? (await tx.select({ name: user.name }).from(user).where(eq(user.id, insp.inspectorUserId)))[0]
      : undefined;

    const zoneRows = await tx.select().from(inspectionZone)
      .where(eq(inspectionZone.inspectionId, req.inspectionId))
      .orderBy(asc(inspectionZone.sortOrder), asc(inspectionZone.createdAt));
    const zoneIds = zoneRows.map((z) => z.id);

    const findingRows = zoneIds.length
      ? await tx.select().from(inspectionFinding)
          .where(and(inArray(inspectionFinding.inspectionZoneId, zoneIds), isNotNull(inspectionFinding.confirmedAt)))
      : [];
    const mediaRows = zoneIds.length
      ? await tx.select({
          zoneId: inspectionMedia.inspectionZoneId, documentId: inspectionMedia.documentId,
          r2Key: document.r2Key, qcStatus: document.qcStatus,
        }).from(inspectionMedia)
          .innerJoin(document, eq(inspectionMedia.documentId, document.id))
          .where(inArray(inspectionMedia.inspectionZoneId, zoneIds))
      : [];

    const [t] = await tx.select({ name: tenantTbl.name }).from(tenantTbl).where(eq(tenantTbl.id, tenantId));
    const licenses = prop?.state
      ? await tx.select({ state: license.state, licenseNumber: license.licenseNumber }).from(license)
          .where(eq(license.state, prop.state))
      : [];

    return {
      certRequestId: req.id,
      deliveredAt: req.deliveredAt,
      address: prop?.address ?? "",
      narrative: insp.narrative,
      zones: zoneRows.map((z) => ({
        zoneKey: z.zoneKey, zoneLabel: z.zoneLabel, grade: z.grade, summary: z.summary,
        photos: mediaRows.filter((m) => m.zoneId === z.id && m.qcStatus === "passed")
          .map((m) => ({ documentId: m.documentId, r2Key: m.r2Key })),
      })),
      conditionNotes: findingRows.map((f) => ({ whatItIs: f.whatItIs, ifIgnored: f.ifIgnored, timeframe: f.timeframe })),
      ageRange: prop ? roofAgeRange({
        lastRoofReplacementAt: prop.lastRoofReplacementAt,
        lastRoofReplacementSource: prop.lastRoofReplacementSource,
        yearBuilt: prop.yearBuilt,
      }, new Date()) : null,
      companyName: t?.name ?? "",
      licenses,
      inspectorFirstName: inspector?.name?.split(/\s+/)[0] ?? null,
    };
  });
}

/**
 * Hourly sweep: advance booked→inspected when fieldwork completes, and
 * auto-deliver as soon as the inspector approves — delivery is automatic,
 * never a button someone forgets (cert.sla evidence keeps this honest).
 */
export async function sweepCertRequests(tenantId: string, now: Date): Promise<{ inspected: number; delivered: number }> {
  const open = await withTenant(tenantId, (tx) =>
    tx.select({
      id: certRequest.id, status: certRequest.status, inspectionId: certRequest.inspectionId,
    }).from(certRequest)
      .where(and(eq(certRequest.tenantId, tenantId), inArray(certRequest.status, ["booked", "inspected"]), isNotNull(certRequest.inspectionId))),
  );
  if (open.length === 0) return { inspected: 0, delivered: 0 };

  const inspIds = open.map((o) => o.inspectionId!);
  const insps = await withTenant(tenantId, (tx) =>
    tx.select({ id: inspection.id, completedAt: inspection.completedAt, approvedAt: inspection.approvedAt })
      .from(inspection).where(inArray(inspection.id, inspIds)),
  );
  const byInsp = new Map(insps.map((i) => [i.id, i]));

  let inspected = 0;
  let delivered = 0;
  for (const o of open) {
    const insp = byInsp.get(o.inspectionId!);
    if (!insp) continue;
    if (insp.approvedAt) {
      const r = await deliverCertRequest(tenantId, { certRequestId: o.id, now });
      if ("delivered" in r) delivered++;
    } else if (insp.completedAt && o.status === "booked") {
      await withTenant(tenantId, (tx) =>
        tx.update(certRequest).set({ status: "inspected" }).where(eq(certRequest.id, o.id)),
      );
      inspected++;
    }
  }
  return { inspected, delivered };
}
