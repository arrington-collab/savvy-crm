import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { spotVerifyDoneTasks } from "../src/index.js";
import { tenant, customer, property, job, lead, taskRegistry, jobTask, leadTask } from "../src/schema/index.js";

// One synthetic task per scenario so each set of done rows is independent.
const PASS = 9501, HIT = 9502, MISS = 9503, STALE = 9504, LEAD = 9505;
const SYN = [PASS, HIT, MISS, STALE, LEAD];

let tenantId: string;
let jobId: string;
let leadId: string;

const reg = (id: number) => ({ id, slug: `sv.${id}`, name: `sv-${id}`, phase: 9, defaultOwner: "HUMAN" as const, defaultMode: "full_auto" as const, scope: "per_job" as const, checkKey: `test.${id}` });
const jtRow = (taskId: number) => adminDb.select().from(jobTask).where(and(eq(jobTask.tenantId, tenantId), eq(jobTask.taskId, taskId))).then((r) => r[0]);

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "SV Co", publicKey: `sv-${Date.now()}`, clerkOrgId: `org_sv_${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "HO" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Main" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "billing" }).returning();
  jobId = j!.id;
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, status: "contacted" }).returning();
  leadId = l!.id;

  await adminDb.insert(taskRegistry).values(SYN.map(reg));
  // A done job_task per scenario, each with an evidence ref.
  await adminDb.insert(jobTask).values([
    { tenantId, jobId, taskId: PASS, status: "done", evidence: { type: "invoice", ref: "A" } },
    { tenantId, jobId, taskId: HIT, status: "done", evidence: { type: "invoice", ref: "B" } },
    { tenantId, jobId, taskId: MISS, status: "done", evidence: { type: "invoice", ref: "C" } },
    { tenantId, jobId, taskId: STALE, status: "done", evidence: { type: "invoice", ref: "D" } },
  ]);
  await adminDb.insert(leadTask).values({ tenantId, leadId, taskId: LEAD, status: "done", evidence: { type: "communication", ref: "E" } });
});

afterAll(async () => {
  await adminDb.delete(jobTask).where(eq(jobTask.tenantId, tenantId));
  await adminDb.delete(leadTask).where(eq(leadTask.tenantId, tenantId));
  await adminDb.delete(taskRegistry).where(inArray(taskRegistry.id, SYN));
  await adminDb.delete(job).where(eq(job.tenantId, tenantId));
  await adminDb.delete(lead).where(eq(lead.tenantId, tenantId));
  await adminDb.delete(property).where(eq(property.tenantId, tenantId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminPool.end();
});

describe("spotVerifyDoneTasks", () => {
  it("a passing check verifies every done row", async () => {
    const r = await spotVerifyDoneTasks(tenantId, PASS, { status: "pass", refs: [] });
    expect(r.verified).toBe(1);
    const row = await jtRow(PASS);
    expect(row!.status).toBe("verified");
    expect(row!.verifiedAt).not.toBeNull();
  });

  it("a failing check flips a done row whose evidence ref IS a violation to exception", async () => {
    const r = await spotVerifyDoneTasks(tenantId, HIT, { status: "fail", refs: [{ type: "invoice", ref: "B" }] });
    expect(r.exceptions).toBe(1);
    expect((await jtRow(HIT))!.status).toBe("exception");
  });

  it("a failing check verifies a done row whose evidence ref is NOT among the violations", async () => {
    await spotVerifyDoneTasks(tenantId, MISS, { status: "fail", refs: [{ type: "invoice", ref: "Z" }] });
    expect((await jtRow(MISS))!.status).toBe("verified");
  });

  it("a stale/skip check leaves done rows unchanged (can't verify)", async () => {
    await spotVerifyDoneTasks(tenantId, STALE, { status: "stale", refs: [] });
    expect((await jtRow(STALE))!.status).toBe("done");
  });

  it("verifies the lead ledger too", async () => {
    await spotVerifyDoneTasks(tenantId, LEAD, { status: "pass", refs: [] });
    const [row] = await adminDb.select().from(leadTask).where(and(eq(leadTask.tenantId, tenantId), eq(leadTask.taskId, LEAD)));
    expect(row!.status).toBe("verified");
  });
});
