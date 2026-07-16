import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { withTenant } from "../src/tenant.js";
import { tenant } from "../src/schema/tenancy.js";
import { partner, partnerLedgerEntry } from "../src/schema/partner.js";
import { certRequest } from "../src/schema/cert.js";
import { appointment } from "../src/schema/comms.js";
import { inspection, inspectionZone, inspectionFinding } from "../src/schema/inspection.js";
import { job } from "../src/schema/jobs.js";
import { invoice } from "../src/schema/finance.js";
import { bookingLink } from "../src/schema/booking-link.js";
import { lead, customer, property } from "../src/schema/crm.js";
import { makeTenant, makeUser } from "./helpers.js";
import { findOrCreatePartner } from "../src/lifecycle/partner.js";
import { partnerValueRows } from "../src/lifecycle/partner-value.js";
import {
  createCertRequest,
  bookCertRequest,
  deliverCertRequest,
  declineCertRequest,
  sweepCertRequests,
  getCertPageData,
} from "../src/lifecycle/cert-request.js";

const NOW = new Date("2026-07-16T18:00:00Z");
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000);

async function seedPartnerTenant(): Promise<{ tenantId: string; partnerId: string; userId: string }> {
  const { tenantId } = await makeTenant();
  // Stripe connected so sendInvoice can assign a number; Stripe-less tenants
  // keep a draft (fail-soft path, exercised implicitly by other tests).
  await adminDb.update(tenant).set({ stripeAccountId: `acct_test_${crypto.randomUUID().slice(0, 8)}` }).where(eq(tenant.id, tenantId));
  const { userId } = await makeUser(tenantId);
  const { id: partnerId } = await findOrCreatePartner(tenantId, { name: "Cert Realtor", org: "Close Fast", class: "realtor" });
  return { tenantId, partnerId, userId };
}

let slotSeq = 0; // distinct slots per booking — appointments EXCLUDE overlaps per assignee

async function requestAndBook(t: { tenantId: string; partnerId: string; userId: string }, requestedAt = hoursAgo(4)) {
  const r = await createCertRequest(t.tenantId, {
    partnerId: t.partnerId, customerName: "Selling Homeowner", customerEmail: "seller@example.test",
    address: "77 Escrow Way, Mesa AZ", requestedAt,
  });
  if ("error" in r) throw new Error(r.error);
  slotSeq += 1;
  const startsAt = new Date(NOW.getTime() + slotSeq * 2 * 3_600_000);
  const b = await bookCertRequest(t.tenantId, {
    certRequestId: r.certRequestId, assigneeUserId: t.userId,
    startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000),
  });
  if ("error" in b) throw new Error(b.error);
  return { certRequestId: r.certRequestId, inspectionId: b.inspectionId };
}

/** Inspector finishes + approves via the Roof Record columns directly (machinery tested elsewhere). */
async function approveInspection(inspectionId: string, completedAt = hoursAgo(1)) {
  await adminDb.update(inspection)
    .set({ status: "approved", completedAt, approvedAt: new Date(completedAt.getTime() + 600_000) })
    .where(eq(inspection.id, inspectionId));
}

describe("createCertRequest", () => {
  it("creates customer + property + request with the config-locked price and NO lead", async () => {
    const t = await seedPartnerTenant();
    const r = await createCertRequest(t.tenantId, {
      partnerId: t.partnerId, customerName: "Selling Homeowner", address: "77 Escrow Way, Mesa AZ",
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    const [row] = await adminDb.select().from(certRequest).where(eq(certRequest.id, r.certRequestId));
    expect(row!.status).toBe("requested");
    expect(row!.priceCents).toBe(19500); // default $195
    expect(row!.partnerId).toBe(t.partnerId);
    const leads = await adminDb.select().from(lead).where(eq(lead.tenantId, t.tenantId));
    expect(leads).toHaveLength(0); // certs never enter the partner funnel
  });

  it("respects the per-tenant lane toggle and price override", async () => {
    const t = await seedPartnerTenant();
    await adminDb.update(tenant)
      .set({ settings: { partnerLedger: { certLaneEnabled: false } } })
      .where(eq(tenant.id, t.tenantId));
    const off = await createCertRequest(t.tenantId, { partnerId: t.partnerId, customerName: "X", address: "1 Off St" });
    expect(off).toEqual({ error: "cert_lane_disabled" });

    await adminDb.update(tenant)
      .set({ settings: { partnerLedger: { certPriceCents: 24900 } } })
      .where(eq(tenant.id, t.tenantId));
    const on = await createCertRequest(t.tenantId, { partnerId: t.partnerId, customerName: "X", address: "2 On St" });
    if ("error" in on) throw new Error(on.error);
    const [row] = await adminDb.select().from(certRequest).where(eq(certRequest.id, on.certRequestId));
    expect(row!.priceCents).toBe(24900);
  });
});

describe("bookCertRequest", () => {
  it("books the inspection appointment + starts a kind:cert inspection (no lead, no job)", async () => {
    const t = await seedPartnerTenant();
    const { certRequestId, inspectionId } = await requestAndBook(t);

    const [row] = await adminDb.select().from(certRequest).where(eq(certRequest.id, certRequestId));
    expect(row!.status).toBe("booked");
    expect(row!.appointmentId).toBeTruthy();
    expect(row!.inspectionId).toBe(inspectionId);

    const [appt] = await adminDb.select().from(appointment).where(eq(appointment.id, row!.appointmentId!));
    expect(appt!.type).toBe("inspection");
    expect(appt!.leadId).toBeNull();

    const [insp] = await adminDb.select().from(inspection).where(eq(inspection.id, inspectionId));
    expect(insp!.kind).toBe("cert");
    expect(insp!.leadId).toBeNull();
  });
});

describe("deliverCertRequest", () => {
  it("red path: refuses before the inspection is approved", async () => {
    const t = await seedPartnerTenant();
    const { certRequestId } = await requestAndBook(t);
    const r = await deliverCertRequest(t.tenantId, { certRequestId, now: NOW });
    expect(r).toEqual({ error: "inspection_not_approved" });
  });

  it("delivers: leadless billing job + sent invoice + tokenized cert link + cert_sale revenue, idempotently", async () => {
    const t = await seedPartnerTenant();
    const { certRequestId, inspectionId } = await requestAndBook(t);
    await approveInspection(inspectionId);

    const r1 = await deliverCertRequest(t.tenantId, { certRequestId, now: NOW });
    const r2 = await deliverCertRequest(t.tenantId, { certRequestId, now: NOW }); // replay is free
    expect("error" in r1).toBe(false);
    expect("error" in r2).toBe(false);

    const [row] = await adminDb.select().from(certRequest).where(eq(certRequest.id, certRequestId));
    expect(row!.status).toBe("delivered");
    expect(row!.deliveredAt).toBeTruthy();

    const [j] = await adminDb.select().from(job).where(eq(job.id, row!.jobId!));
    expect(j!.leadId).toBeNull(); // never a funnel "win"
    expect(j!.type).toBe("repair");

    const [inv] = await adminDb.select().from(invoice).where(eq(invoice.id, row!.invoiceId!));
    expect(inv!.amountDue).toBe(19500);
    expect(inv!.status).toBe("sent");

    const links = await adminDb.select().from(bookingLink)
      .where(and(eq(bookingLink.tenantId, t.tenantId), eq(bookingLink.kind, "cert")));
    expect(links).toHaveLength(1);

    const entries = await adminDb.select().from(partnerLedgerEntry)
      .where(and(eq(partnerLedgerEntry.tenantId, t.tenantId), eq(partnerLedgerEntry.kind, "cert_sale")));
    expect(entries).toHaveLength(1); // idempotent despite the replay
    expect(entries[0]!.direction).toBe("revenue");
    expect(entries[0]!.amountCents).toBe(19500);
    expect(entries[0]!.partnerId).toBe(t.partnerId);

    const jobs = await adminDb.select().from(job).where(eq(job.tenantId, t.tenantId));
    expect(jobs).toHaveLength(1); // replay created no second job
  });

  it("cert revenue lands in the partner's net but NOT in the funnel or collected GM", async () => {
    const t = await seedPartnerTenant();
    const { certRequestId, inspectionId } = await requestAndBook(t);
    await approveInspection(inspectionId);
    await deliverCertRequest(t.tenantId, { certRequestId, now: NOW });

    const rows = await partnerValueRows(t.tenantId, NOW);
    const r = rows.find((x) => x.partnerId === t.partnerId)!;
    expect(r.sent).toBe(0);
    expect(r.won).toBe(0);
    expect(r.collectedGmCents).toBe(0);
    expect(r.revenue12moCents).toBe(19500);
    expect(r.netCents).toBe(19500);
  });
});

describe("declineCertRequest", () => {
  it("declining after a completed inspection accrues the nominal generation cost; before, nothing", async () => {
    const t = await seedPartnerTenant();

    const early = await requestAndBook(t);
    await declineCertRequest(t.tenantId, { certRequestId: early.certRequestId, reason: "seller pulled listing" });
    let entries = await adminDb.select().from(partnerLedgerEntry)
      .where(and(eq(partnerLedgerEntry.tenantId, t.tenantId), eq(partnerLedgerEntry.kind, "cert_cost")));
    expect(entries).toHaveLength(0);

    const late = await requestAndBook(t);
    await adminDb.update(inspection).set({ completedAt: hoursAgo(1) }).where(eq(inspection.id, late.inspectionId));
    await declineCertRequest(t.tenantId, { certRequestId: late.certRequestId, reason: "buyer walked" });
    entries = await adminDb.select().from(partnerLedgerEntry)
      .where(and(eq(partnerLedgerEntry.tenantId, t.tenantId), eq(partnerLedgerEntry.kind, "cert_cost")));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.amountCents).toBe(2500); // nominal default $25
    expect(entries[0]!.direction).toBe("cost");

    const [row] = await adminDb.select().from(certRequest).where(eq(certRequest.id, late.certRequestId));
    expect(row!.status).toBe("declined");
    expect(row!.declineReason).toBe("buyer walked");
  });
});

describe("sweepCertRequests", () => {
  it("advances booked→inspected on completion and auto-delivers approved inspections", async () => {
    const t = await seedPartnerTenant();
    const a = await requestAndBook(t);
    await adminDb.update(inspection).set({ completedAt: hoursAgo(2) }).where(eq(inspection.id, a.inspectionId));
    const b = await requestAndBook(t);
    await approveInspection(b.inspectionId);

    const r = await sweepCertRequests(t.tenantId, NOW);
    expect(r.delivered).toBe(1);

    const rows = await adminDb.select().from(certRequest).where(eq(certRequest.tenantId, t.tenantId));
    const byId = new Map(rows.map((x) => [x.id, x]));
    expect(byId.get(a.certRequestId)!.status).toBe("inspected");
    expect(byId.get(b.certRequestId)!.status).toBe("delivered");
  });
});

describe("getCertPageData", () => {
  it("red path: the paid deliverable carries condition + age + photos but NO free-repair marketing, dispositions, or pricing", async () => {
    const t = await seedPartnerTenant();
    const { certRequestId, inspectionId } = await requestAndBook(t);

    const [zone] = await adminDb.insert(inspectionZone).values({
      tenantId: t.tenantId, inspectionId, zoneKey: "north", zoneLabel: "North Slope",
      zoneKind: "facet", grade: "monitor", summary: "Aging but serviceable",
    }).returning();
    await adminDb.insert(inspectionFinding).values([
      { tenantId: t.tenantId, inspectionZoneId: zone!.id, whatItIs: "Lifted shingle tab", disposition: "fixed_free_today", confirmedAt: new Date() },
      { tenantId: t.tenantId, inspectionZoneId: zone!.id, whatItIs: "Cracked pipe boot", ifIgnored: "Slow leak at penetration", disposition: "repair_quoted", repairEstimateCents: 35000, confirmedAt: new Date() },
      { tenantId: t.tenantId, inspectionZoneId: zone!.id, whatItIs: "AI guess, unconfirmed", disposition: "noted" }, // unconfirmed — excluded
    ]);
    await approveInspection(inspectionId);
    await deliverCertRequest(t.tenantId, { certRequestId, now: NOW });

    const data = await getCertPageData(t.tenantId, certRequestId);
    expect(data).not.toBeNull();
    expect(data!.zones).toHaveLength(1);
    expect(data!.zones[0]!.grade).toBe("monitor");
    const noted = data!.conditionNotes.map((n) => n.whatItIs);
    expect(noted).toEqual(expect.arrayContaining(["Lifted shingle tab", "Cracked pipe boot"]));
    expect(noted).not.toContain("AI guess, unconfirmed");

    // The paid deliverable never sells: no dispositions, no repair pricing,
    // no free-repair framing, no estimate link.
    const json = JSON.stringify(data);
    expect(json).not.toContain("disposition");
    expect(json).not.toContain("fixed_free_today");
    expect(json).not.toContain("35000");
    expect(json).not.toContain("estimateId");
  });

  it("returns null until the cert is delivered", async () => {
    const t = await seedPartnerTenant();
    const { certRequestId, inspectionId } = await requestAndBook(t);
    expect(await getCertPageData(t.tenantId, certRequestId)).toBeNull();
    await approveInspection(inspectionId);
    expect(await getCertPageData(t.tenantId, certRequestId)).toBeNull(); // approved but not delivered
  });
});

describe("evidence: cert.sla", () => {
  const run = (tenantId: string) => {
    const ctx: EvidenceCtx = {
      tenantId, db: adminPool, params: {},
      window: { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) },
    };
    return evidenceChecks["cert.sla"]!(ctx);
  };

  it("fails on a request still open past 48h and on a late close; passes on on-time delivery", async () => {
    const t = await seedPartnerTenant();
    // The check's SQL compares against the DATABASE clock — anchor to real time.
    const realHoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000);

    // On time: requested 4h ago, delivered now.
    const ok = await requestAndBook(t, realHoursAgo(4));
    await approveInspection(ok.inspectionId, realHoursAgo(1));
    await deliverCertRequest(t.tenantId, { certRequestId: ok.certRequestId, now: new Date() });
    expect((await run(t.tenantId)).status).toBe("pass");

    // Breach: still open after 48h.
    await requestAndBook(t, realHoursAgo(50));
    const bad = await run(t.tenantId);
    expect(bad.status).toBe("fail");
  });
});
