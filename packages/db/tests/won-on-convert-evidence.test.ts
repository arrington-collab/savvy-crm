import { beforeAll, describe, expect, it } from "vitest";
import { evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, lead, job } from "../src/schema/index.js";

const WINDOW = { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) };
const run = (checkKey: string, tenantId: string) => {
  const ctx: EvidenceCtx = { tenantId, db: adminPool, params: {}, window: WINDOW };
  return evidenceChecks[checkKey]!(ctx);
};

let cleanId: string;
let badId: string;

/** A lead that has been converted (a job references it) with the given status. */
async function mkConvertedLead(tid: string, status: "won" | "booked") {
  const [c] = await adminDb.insert(customer).values({ tenantId: tid, name: "c" }).returning();
  const [p] = await adminDb
    .insert(property)
    .values({ tenantId: tid, customerId: c!.id, address: `a-${crypto.randomUUID()}` })
    .returning();
  const [l] = await adminDb
    .insert(lead)
    .values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, source: "test", status })
    .returning();
  await adminDb
    .insert(job)
    .values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead", leadId: l!.id });
  return l!.id;
}

beforeAll(async () => {
  const [a] = await adminDb.insert(tenant).values({ name: "won-clean", publicKey: `wc-${Date.now()}`, clerkOrgId: `org_wc_${Date.now()}` }).returning();
  const [b] = await adminDb.insert(tenant).values({ name: "won-bad", publicKey: `wb-${Date.now()}`, clerkOrgId: `org_wb_${Date.now()}` }).returning();
  cleanId = a!.id;
  badId = b!.id;
  await mkConvertedLead(cleanId, "won"); // referenced by a job AND won → OK
  await mkConvertedLead(badId, "booked"); // referenced by a job but still booked → violation
});

describe("lead.won_on_convert evidence", () => {
  it("passes when every job-referenced lead is won", async () => {
    const r = await run("lead.won_on_convert", cleanId);
    expect(r.status).toBe("pass");
    expect(r.refs).toEqual([]);
  });

  it("fails when a job-referenced lead is still booked", async () => {
    const r = await run("lead.won_on_convert", badId);
    expect(r.status).toBe("fail");
    expect(r.refs.length).toBeGreaterThanOrEqual(1);
  });
});
