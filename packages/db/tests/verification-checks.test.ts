import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import {
  tenant, customer, property, lead, job, communication,
  user, invoice, commission, drip, dripEnrollment, enrichmentAttempt,
} from "../src/schema/index.js";

// Two tenants: CLEAN has benign data (checks pass); BAD has seeded violations.
let cleanId: string;
let badId: string;

const WINDOW = { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) };
const HOURS = (n: number) => new Date(Date.now() - n * 3_600_000);
const MINS = (n: number) => new Date(Date.now() - n * 60_000);
const plus = (d: Date, mins: number) => new Date(d.getTime() + mins * 60_000);

const run = (checkKey: string, tenantId: string) => {
  const ctx: EvidenceCtx = { tenantId, db: adminPool, params: {}, window: WINDOW };
  return evidenceChecks[checkKey]!(ctx);
};

beforeAll(async () => {
  const [a] = await adminDb.insert(tenant).values({ name: "VC-clean", publicKey: "vc-clean", clerkOrgId: "org_vc_clean" }).returning();
  const [b] = await adminDb.insert(tenant).values({ name: "VC-bad", publicKey: "vc-bad", clerkOrgId: "org_vc_bad" }).returning();
  cleanId = a!.id; badId = b!.id;

  // --- comms.no_double_send / comms.body_quality ---
  // CLEAN: two DIFFERENT outbound bodies, clean text.
  await adminDb.insert(communication).values([
    { tenantId: cleanId, channel: "sms", direction: "outbound", to: "+16025550001", body: "Your inspection is Today, 2:00 PM." },
    { tenantId: cleanId, channel: "sms", direction: "outbound", to: "+16025550001", body: "See you soon!" },
  ]);
  // BAD: identical body twice within 24h (double-send) + one leaking GMT / long URL.
  await adminDb.insert(communication).values([
    { tenantId: badId, channel: "sms", direction: "outbound", to: "+16025559999", body: "Reminder: your appt is booked." },
    { tenantId: badId, channel: "sms", direction: "outbound", to: "+16025559999", body: "Reminder: your appt is booked." },
    { tenantId: badId, channel: "sms", direction: "outbound", to: "+16025558888", body: "Your appt is Wed 14:00 GMT" },
    { tenantId: badId, channel: "sms", direction: "outbound", to: "+16025557777", body: "Confirm: https://app.savvy.example/book/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.verylongtoken" },
  ]);

  // --- lead.dedupe --- CLEAN: two leads, different phones. BAD: two active leads sharing a phone.
  const mkLeadWithPhone = async (tid: string, phone: string) => {
    const [c] = await adminDb.insert(customer).values({ tenantId: tid, name: `c-${phone}`, phone }).returning();
    await adminDb.insert(lead).values({ tenantId: tid, customerId: c!.id, source: "test", status: "new" });
  };
  await mkLeadWithPhone(cleanId, "+16025550100");
  await mkLeadWithPhone(cleanId, "+16025550200");
  await mkLeadWithPhone(badId, "(602) 555-1212");
  await mkLeadWithPhone(badId, "602-555-1212"); // same digits, different formatting

  // --- lead.score --- CLEAN: >1h-old lead WITH score+reason. BAD: >1h-old lead missing score.
  const [cc] = await adminDb.insert(customer).values({ tenantId: cleanId, name: "scored", phone: "+16025550300" }).returning();
  await adminDb.insert(lead).values({ tenantId: cleanId, customerId: cc!.id, source: "test", status: "new", score: 80, scoreReason: "hot", createdAt: HOURS(2), firstRepContactAt: plus(HOURS(2), 2) });
  const [bc] = await adminDb.insert(customer).values({ tenantId: badId, name: "unscored", phone: "+16025550400" }).returning();
  await adminDb.insert(lead).values({ tenantId: badId, customerId: bc!.id, source: "test", status: "new", createdAt: HOURS(2) });

  // --- exceptions.roof_type --- CLEAN: post-inspection job WITH roof type. BAD: null roof type past 48h SLA.
  const mkJob = async (tid: string, roofType: string | null, stageEnteredAt: Date) => {
    const [c] = await adminDb.insert(customer).values({ tenantId: tid, name: "rt", phone: null }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId: tid, customerId: c!.id, address: `rt-${tid}-${roofType}`, roofType }).returning();
    await adminDb.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, stage: "inspected", stageEnteredAt });
  };
  await mkJob(cleanId, "asphalt_shingle", HOURS(72));
  await mkJob(badId, null, HOURS(72));

  // --- lead.speed_to_contact (window-scoped) ---
  // CLEAN: lead contacted 3m after creation. BAD: 2h-old lead, never contacted.
  const [csc] = await adminDb.insert(customer).values({ tenantId: cleanId, name: "prompt", phone: "+16025550500" }).returning();
  await adminDb.insert(lead).values({ tenantId: cleanId, customerId: csc!.id, source: "test", status: "new", createdAt: MINS(30), firstRepContactAt: plus(MINS(30), 3) });
  const [bsc] = await adminDb.insert(customer).values({ tenantId: badId, name: "ghosted", phone: "+16025550600" }).returning();
  await adminDb.insert(lead).values({ tenantId: badId, customerId: bsc!.id, source: "test", status: "new", createdAt: HOURS(2) });

  // --- lead.enrich.geocode / lead.enrich.stormproof (state invariants) ---
  // CLEAN: >24h lead whose property is fully enriched (lat/lng + year_built) —
  //   also a good citizen for lead.score + speed (score + prompt contact set).
  // BAD: >24h lead whose property lacks lat/lng AND year_built, with NO closed
  //   enrichment_attempt (the enricher never ran to completion).
  const [ceg] = await adminDb.insert(customer).values({ tenantId: cleanId, name: "enriched", phone: "+16025550700" }).returning();
  const [cegp] = await adminDb.insert(property).values({ tenantId: cleanId, customerId: ceg!.id, address: "enriched-clean", roofType: "asphalt_shingle", lat: 33.45, lng: -112.07, yearBuilt: 1998, county: "Maricopa" }).returning();
  await adminDb.insert(lead).values({ tenantId: cleanId, customerId: ceg!.id, propertyId: cegp!.id, source: "test", status: "new", createdAt: HOURS(48), score: 70, scoreReason: "ok", firstRepContactAt: plus(HOURS(48), 2) });
  const [beg] = await adminDb.insert(customer).values({ tenantId: badId, name: "unenriched", phone: "+16025550800" }).returning();
  const [begp] = await adminDb.insert(property).values({ tenantId: badId, customerId: beg!.id, address: "unenriched-bad" }).returning();
  await adminDb.insert(lead).values({ tenantId: badId, customerId: beg!.id, propertyId: begp!.id, source: "test", status: "new", createdAt: HOURS(48) });

  // --- drip.appended_guard ---
  // A drip with an EMAIL step in each tenant. CLEAN: enrolled customer's email is
  // self_reported (marketing OK). BAD: enrolled customer's email is 'appended'.
  const emailSteps = [{ stepNum: 1, delayHours: 0, channel: "email", templateKey: "welcome" }];
  const [cd] = await adminDb.insert(drip).values({ tenantId: cleanId, key: "nurture", name: "Nurture", steps: emailSteps as never }).returning();
  const [cdc] = await adminDb.insert(customer).values({ tenantId: cleanId, name: "selfrep", email: "self@x.com", emailSource: "self_reported" }).returning();
  await adminDb.insert(dripEnrollment).values({ tenantId: cleanId, dripId: cd!.id, customerId: cdc!.id, status: "active" });
  const [bd] = await adminDb.insert(drip).values({ tenantId: badId, key: "nurture", name: "Nurture", steps: emailSteps as never }).returning();
  const [bdc] = await adminDb.insert(customer).values({ tenantId: badId, name: "appended", email: "append@x.com", emailSource: "appended" }).returning();
  await adminDb.insert(dripEnrollment).values({ tenantId: badId, dripId: bd!.id, customerId: bdc!.id, status: "active" });

  // --- finance.invoice_math + finance.commissions ---
  // One billing job per tenant (roof_type set so it doesn't trip roof_type SLA).
  const mkFinanceJob = async (tid: string) => {
    const [c] = await adminDb.insert(customer).values({ tenantId: tid, name: "fin" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId: tid, customerId: c!.id, address: `fin-${tid}`, roofType: "asphalt_shingle" }).returning();
    const [j] = await adminDb.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, stage: "billing", stageEnteredAt: HOURS(1) }).returning();
    const [u] = await adminDb.insert(user).values({ tenantId: tid, name: "rep", email: `rep-${tid}@x.com`, role: "rep" }).returning();
    return { customerId: c!.id, jobId: j!.id, userId: u!.id };
  };
  const cf = await mkFinanceJob(cleanId);
  const bf = await mkFinanceJob(badId);
  const li = [{ description: "Roof", qty: 2, unitAmountCents: 100 }]; // sum = 200

  // invoice_math: CLEAN amount_due == sum(qty*unit); BAD amount_due != sum.
  await adminDb.insert(invoice).values({ tenantId: cleanId, jobId: cf.jobId, customerId: cf.customerId, lineItems: li as never, amountDue: 200, status: "sent" });
  await adminDb.insert(invoice).values({ tenantId: badId, jobId: bf.jobId, customerId: bf.customerId, lineItems: li as never, amountDue: 999, status: "sent" });

  // commissions: each needs an invoice (with correct math so it doesn't taint
  // invoice_math) + a rep. CLEAN amount == round(basis*rate/1e4); BAD mismatched.
  const [ci] = await adminDb.insert(invoice).values({ tenantId: cleanId, jobId: cf.jobId, customerId: cf.customerId, lineItems: [] as never, amountDue: 0, status: "paid" }).returning();
  await adminDb.insert(commission).values({ tenantId: cleanId, invoiceId: ci!.id, userId: cf.userId, model: "flat", basisCents: 100000, rate: 1000, amountCents: 10000, periodKey: "2026-07" });
  const [bi] = await adminDb.insert(invoice).values({ tenantId: badId, jobId: bf.jobId, customerId: bf.customerId, lineItems: [] as never, amountDue: 0, status: "paid" }).returning();
  await adminDb.insert(commission).values({ tenantId: badId, invoiceId: bi!.id, userId: bf.userId, model: "flat", basisCents: 100000, rate: 1000, amountCents: 12345, periodKey: "2026-07" });
});

afterAll(async () => {
  for (const tid of [cleanId, badId]) {
    // Children first to satisfy FKs.
    await adminDb.delete(commission).where(eq(commission.tenantId, tid));
    await adminDb.delete(dripEnrollment).where(eq(dripEnrollment.tenantId, tid));
    await adminDb.delete(drip).where(eq(drip.tenantId, tid));
    await adminDb.delete(enrichmentAttempt).where(eq(enrichmentAttempt.tenantId, tid));
    await adminDb.delete(communication).where(eq(communication.tenantId, tid));
    await adminDb.delete(invoice).where(eq(invoice.tenantId, tid));
    await adminDb.delete(job).where(eq(job.tenantId, tid));
    await adminDb.delete(lead).where(eq(lead.tenantId, tid));
    await adminDb.delete(property).where(eq(property.tenantId, tid));
    await adminDb.delete(customer).where(eq(customer.tenantId, tid));
    await adminDb.delete(user).where(eq(user.tenantId, tid));
    await adminDb.delete(tenant).where(eq(tenant.id, tid));
  }
  await adminPool.end();
});

describe("evidence invariants (real DB, green + red)", () => {
  const cases = [
    "comms.no_double_send", "comms.body_quality", "lead.dedupe", "lead.score", "exceptions.roof_type",
    "lead.speed_to_contact", "lead.enrich.geocode", "lead.enrich.stormproof",
    "drip.appended_guard", "finance.invoice_math", "finance.commissions",
  ];

  for (const key of cases) {
    it(`${key}: passes on clean tenant`, async () => {
      const r = await run(key, cleanId);
      expect(r.status).toBe("pass");
      expect(r.refs).toEqual([]);
    });

    it(`${key}: fails and cites refs on violating tenant`, async () => {
      const r = await run(key, badId);
      expect(r.status).toBe("fail");
      expect(r.refs.length).toBeGreaterThanOrEqual(1);
    });
  }

  it("body_quality flags BOTH the GMT and the long-URL messages", async () => {
    const r = await run("comms.body_quality", badId);
    expect(r.refs.length).toBe(2);
  });

  it("checks are tenant-scoped (bad tenant's violations never surface for clean)", async () => {
    const r = await run("comms.no_double_send", cleanId);
    expect(r.status).toBe("pass");
  });
});
