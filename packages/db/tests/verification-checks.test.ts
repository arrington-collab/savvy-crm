import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, lead, job, communication } from "../src/schema/index.js";

// Two tenants: CLEAN has benign data (checks pass); BAD has seeded violations.
let cleanId: string;
let badId: string;

const WINDOW = { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) };
const HOURS = (n: number) => new Date(Date.now() - n * 3_600_000);

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
  await adminDb.insert(lead).values({ tenantId: cleanId, customerId: cc!.id, source: "test", status: "new", score: 80, scoreReason: "hot", createdAt: HOURS(2) });
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
});

afterAll(async () => {
  for (const tid of [cleanId, badId]) {
    await adminDb.delete(communication).where(eq(communication.tenantId, tid));
    await adminDb.delete(job).where(eq(job.tenantId, tid));
    await adminDb.delete(lead).where(eq(lead.tenantId, tid));
    await adminDb.delete(property).where(eq(property.tenantId, tid));
    await adminDb.delete(customer).where(eq(customer.tenantId, tid));
    await adminDb.delete(tenant).where(eq(tenant.id, tid));
  }
  await adminPool.end();
});

describe("evidence invariants (real DB, green + red)", () => {
  const cases = ["comms.no_double_send", "comms.body_quality", "lead.dedupe", "lead.score", "exceptions.roof_type"];

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
