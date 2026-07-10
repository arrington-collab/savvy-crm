import { beforeAll, afterAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, lead, document, job } from "../src/schema/index.js";

let cleanId: string, badId: string;
const WINDOW = { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) };
const MIN = (n: number) => new Date(Date.now() - n * 60_000);
const run = (tenantId: string) => evidenceChecks["canvass.contract_to_job"]!({ tenantId, db: adminPool, params: {}, window: WINDOW } as EvidenceCtx);

async function mkLead(tid: string) {
  const [c] = await adminDb.insert(customer).values({ tenantId: tid, name: "c" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: tid, customerId: c!.id, address: `a-${crypto.randomUUID()}` }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, source: "canvass", status: "new" }).returning();
  return { customerId: c!.id, propertyId: p!.id, leadId: l!.id };
}

beforeAll(async () => {
  const [a] = await adminDb.insert(tenant).values({ name: "CE-clean", publicKey: `cec-${Date.now()}`, clerkOrgId: `org_cec_${Date.now()}` }).returning();
  const [b] = await adminDb.insert(tenant).values({ name: "CE-bad", publicKey: `ceb-${Date.now()}`, clerkOrgId: `org_ceb_${Date.now()}` }).returning();
  cleanId = a!.id; badId = b!.id;

  // CLEAN: a canvass contract whose lead is won + has a job.
  const cl = await mkLead(cleanId);
  await adminDb.update(lead).set({ status: "won" }).where(eq(lead.id, cl.leadId));
  await adminDb.insert(job).values({ tenantId: cleanId, customerId: cl.customerId, propertyId: cl.propertyId, leadId: cl.leadId, type: "retail", stage: "lead" });
  await adminDb.insert(document).values({ tenantId: cleanId, leadId: cl.leadId, propertyId: cl.propertyId, customerId: cl.customerId, kind: "contract", r2Key: `${cleanId}/canvass/contract-abc.json`, createdAt: MIN(30) });

  // BAD: a stored canvass contract >15m old, lead not won, no job.
  const bl = await mkLead(badId);
  await adminDb.insert(document).values({ tenantId: badId, leadId: bl.leadId, propertyId: bl.propertyId, customerId: bl.customerId, kind: "contract", r2Key: `${badId}/canvass/contract-def.json`, createdAt: MIN(30) });
});
afterAll(async () => {
  for (const tid of [cleanId, badId]) {
    await adminDb.delete(document).where(eq(document.tenantId, tid));
    await adminDb.delete(job).where(eq(job.tenantId, tid));
    await adminDb.delete(lead).where(eq(lead.tenantId, tid));
    await adminDb.delete(property).where(eq(property.tenantId, tid));
    await adminDb.delete(customer).where(eq(customer.tenantId, tid));
    await adminDb.delete(tenant).where(eq(tenant.id, tid));
  }
  await adminPool.end();
});

it("passes on the clean tenant (contract → won job)", async () => {
  const r = await run(cleanId);
  expect(r.status).toBe("pass");
});
it("fails on the bad tenant (stored contract, no won job) — RED PATH #2", async () => {
  const r = await run(badId);
  expect(r.status).toBe("fail");
  expect(r.refs.length).toBeGreaterThanOrEqual(1);
});
