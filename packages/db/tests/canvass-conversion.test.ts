import { beforeAll, afterAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { convertCanvassContractToJob } from "../src/index.js";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, lead, job } from "../src/schema/index.js";
import type { CanvassContract } from "@savvy/core";

let tid: string, leadId: string;
const contract = {
  kind: "retail", document: "Roofing Agreement", fields: {}, scopeItems: [],
  rep: "Marcus R.", signedAt: "2026-07-04T21:00:00.000Z",
  signaturePng: "data:image/png;base64,AAAA", integrityHash: "b".repeat(64),
} as unknown as CanvassContract;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "CC", publicKey: `cc-${Date.now()}`, clerkOrgId: `org_cc_${Date.now()}`, timezone: "America/Phoenix" }).returning();
  tid = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tid, name: "c" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: tid, customerId: c!.id, address: `a-${crypto.randomUUID()}`, state: "AZ" }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, source: "canvass", status: "new" }).returning();
  leadId = l!.id;
});
afterAll(async () => {
  // convertLeadToJob seeds job children (checklist items, stage events); like the other
  // convert-lead-to-job tests we leave the tenant-scoped rows in the shared dev DB rather
  // than chase the FK teardown chain.
  await adminPool.end();
});

it("converts to a WON job with rescission hold + rep name; replay makes ONE job (RED PATH #1)", async () => {
  const first = await convertCanvassContractToJob({ tenantId: tid, leadId, contract });
  const second = await convertCanvassContractToJob({ tenantId: tid, leadId, contract }); // replay
  expect(second.jobId).toBe(first.jobId);
  const jobs = await adminDb.select().from(job).where(eq(job.leadId, leadId));
  expect(jobs).toHaveLength(1);
  const [l] = await adminDb.select().from(lead).where(eq(lead.id, leadId));
  expect(l!.status).toBe("won");
  const j = jobs[0]!;
  expect(j.canvassRepName).toBe("Marcus R.");
  // AZ = 3 days; signed 2026-07-04 14:00 Phoenix → release 2026-07-07 00:00 Phoenix = 07:00Z
  expect(j.rescissionHoldUntil?.toISOString()).toBe("2026-07-07T07:00:00.000Z");
});
