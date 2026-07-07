import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, lead, document, estimate, measurement } from "../src/schema/index.js";

let cleanId: string;
let badId: string;
const WINDOW = { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) };
const HOURS = (n: number) => new Date(Date.now() - n * 3_600_000);
const run = (checkKey: string, tenantId: string) => {
  const ctx: EvidenceCtx = { tenantId, db: adminPool, params: {}, window: WINDOW };
  return evidenceChecks[checkKey]!(ctx);
};

async function mkLead(tid: string) {
  const [c] = await adminDb.insert(customer).values({ tenantId: tid, name: "c" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: tid, customerId: c!.id, address: `a-${crypto.randomUUID()}` }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, source: "test", status: "new" }).returning();
  return { customerId: c!.id, propertyId: p!.id, leadId: l!.id };
}

beforeAll(async () => {
  const [a] = await adminDb.insert(tenant).values({ name: "DP-clean", publicKey: `dp-clean-${Date.now()}`, clerkOrgId: `org_dp_clean_${Date.now()}` }).returning();
  const [b] = await adminDb.insert(tenant).values({ name: "DP-bad", publicKey: `dp-bad-${Date.now()}`, clerkOrgId: `org_dp_bad_${Date.now()}` }).returning();
  cleanId = a!.id; badId = b!.id;

  // --- lead.doc_parse ---
  // CLEAN: an old typed doc that reached a terminal state (parsed), plus a recent still-pending one (<1h, OK).
  const cl = await mkLead(cleanId);
  await adminDb.insert(document).values([
    { tenantId: cleanId, leadId: cl.leadId, propertyId: cl.propertyId, kind: "measurement_report", parseStatus: "parsed", createdAt: HOURS(2) },
    { tenantId: cleanId, leadId: cl.leadId, propertyId: cl.propertyId, kind: "insurance_estimate", parseStatus: "unparsed_low_confidence", createdAt: HOURS(3) },
    { tenantId: cleanId, leadId: cl.leadId, propertyId: cl.propertyId, kind: "insurance_estimate", parseStatus: "pending", createdAt: new Date() },
  ]);
  // BAD: an old (>1h) typed doc stuck in pending.
  const bl = await mkLead(badId);
  await adminDb.insert(document).values({ tenantId: badId, leadId: bl.leadId, propertyId: bl.propertyId, kind: "insurance_estimate", parseStatus: "pending", createdAt: HOURS(2) });

  // --- estimate.lead_stage ---
  // CLEAN: a lead estimate that cites its measurement source.
  const cl2 = await mkLead(cleanId);
  const [cm] = await adminDb.insert(measurement).values({ tenantId: cleanId, propertyId: cl2.propertyId, provider: "roofr", source: "ordered", areas: {} }).returning();
  await adminDb.insert(estimate).values({ tenantId: cleanId, leadId: cl2.leadId, propertyId: cl2.propertyId, measurementId: cm!.id, measurementSource: "ordered" });
  // BAD: a lead estimate with a measurement but NO cited source.
  const bl2 = await mkLead(badId);
  const [bm] = await adminDb.insert(measurement).values({ tenantId: badId, propertyId: bl2.propertyId, provider: "roofr", source: "ordered", areas: {} }).returning();
  await adminDb.insert(estimate).values({ tenantId: badId, leadId: bl2.leadId, propertyId: bl2.propertyId, measurementId: bm!.id, measurementSource: null });
});

afterAll(async () => {
  for (const tid of [cleanId, badId]) {
    await adminDb.delete(estimate).where(eq(estimate.tenantId, tid));
    await adminDb.delete(document).where(eq(document.tenantId, tid));
    await adminDb.delete(measurement).where(eq(measurement.tenantId, tid));
    await adminDb.delete(lead).where(eq(lead.tenantId, tid));
    await adminDb.delete(property).where(eq(property.tenantId, tid));
    await adminDb.delete(customer).where(eq(customer.tenantId, tid));
    await adminDb.delete(tenant).where(eq(tenant.id, tid));
  }
  await adminPool.end();
});

describe("lead-doc evidence invariants (real DB, green + red)", () => {
  for (const key of ["lead.doc_parse", "estimate.lead_stage"]) {
    it(`${key}: passes on the clean tenant`, async () => {
      const r = await run(key, cleanId);
      expect(r.status).toBe("pass");
      expect(r.refs).toEqual([]);
    });
    it(`${key}: fails and cites refs on the violating tenant`, async () => {
      const r = await run(key, badId);
      expect(r.status).toBe("fail");
      expect(r.refs.length).toBeGreaterThanOrEqual(1);
    });
  }
});
