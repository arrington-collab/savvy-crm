import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { getTaskDetail } from "../src/index.js";
import { tenant, customer, property, job, lead, taskRegistry, taskHealth, verificationRun, taskException, jobTask, leadTask } from "../src/schema/index.js";

const FULL = 9631, BARE = 9632;
const SYN = [FULL, BARE];
let tenantId: string;
let jobId: string;
let leadId: string;
const reg = (id: number, phase: number, name: string) => ({ id, slug: `td.${id}`, name, phase, defaultOwner: "HUMAN" as const, defaultMode: "full_auto" as const, scope: "per_job" as const });

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "TD Co", publicKey: `td-${Date.now()}`, clerkOrgId: `org_td_${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "HO" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Main" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "billing" }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, status: "contacted" }).returning();
  jobId = j!.id; leadId = l!.id;

  await adminDb.insert(taskRegistry).values([reg(FULL, 9, "Invoice generation"), reg(BARE, 3, "Empty task")]);
  await adminDb.insert(taskHealth).values({ tenantId, taskId: FULL, status: "red", effectiveMode: "full_auto", cleanStreakDays: 0, failCount7d: 2, openExceptionCount: 1, lastVerifiedAt: new Date("2026-06-30T04:00:00Z") });
  await adminDb.insert(verificationRun).values([
    { tenantId, taskId: FULL, checkKey: "finance.invoice_math", status: "pass", ranAt: new Date("2026-07-01T04:00:00Z") },
    { tenantId, taskId: FULL, checkKey: "finance.invoice_math", status: "fail", ranAt: new Date("2026-07-02T04:00:00Z") },
  ]);
  await adminDb.insert(taskException).values({ tenantId, taskId: FULL, kind: "verification_mismatch", severity: "high", dollarImpactCents: 250_000, breakGlass: true, openedAt: new Date("2026-07-02T04:00:00Z") });
  await adminDb.insert(jobTask).values({ tenantId, jobId, taskId: FULL, status: "exception", owner: "finance", evidence: { type: "invoice", ref: "inv-1" } });
  await adminDb.insert(leadTask).values({ tenantId, leadId, taskId: FULL, status: "done", owner: "comms", evidence: { type: "communication", ref: "comm-1" } });
});

afterAll(async () => {
  await adminDb.delete(jobTask).where(eq(jobTask.tenantId, tenantId));
  await adminDb.delete(leadTask).where(eq(leadTask.tenantId, tenantId));
  await adminDb.delete(taskException).where(eq(taskException.tenantId, tenantId));
  await adminDb.delete(verificationRun).where(eq(verificationRun.tenantId, tenantId));
  await adminDb.delete(taskHealth).where(eq(taskHealth.tenantId, tenantId));
  await adminDb.delete(taskRegistry).where(inArray(taskRegistry.id, SYN));
  await adminDb.delete(job).where(eq(job.tenantId, tenantId));
  await adminDb.delete(lead).where(eq(lead.tenantId, tenantId));
  await adminDb.delete(property).where(eq(property.tenantId, tenantId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminPool.end();
});

describe("getTaskDetail", () => {
  it("assembles registry + health + open exception + recent verifications + ledger instances", async () => {
    const d = (await getTaskDetail(tenantId, FULL))!;
    expect(d).not.toBeNull();
    expect(d.name).toBe("Invoice generation");
    expect(d.phase).toBe(9);

    expect(d.health!.status).toBe("red");
    expect(d.health!.failCount7d).toBe(2);
    expect(d.health!.openExceptionCount).toBe(1);

    expect(d.exception!.kind).toBe("verification_mismatch");
    expect(d.exception!.dollarImpactCents).toBe(250_000);
    expect(d.exception!.breakGlass).toBe(true);
    expect(d.exception!.firstViewedAt).toBeNull();

    expect(d.verifications).toHaveLength(2);
    expect(d.verifications[0]!.status).toBe("fail"); // most recent first
    expect(d.verifications[0]!.ranAt).toEqual(new Date("2026-07-02T04:00:00Z"));

    // Ledger instances across both job and lead ledgers.
    const entities = d.instances.map((i) => i.entity).sort();
    expect(entities).toEqual(["job", "lead"]);
    const jobInst = d.instances.find((i) => i.entity === "job")!;
    expect(jobInst.entityId).toBe(jobId);
    expect(jobInst.status).toBe("exception");
    expect(jobInst.evidence).toEqual({ type: "invoice", ref: "inv-1" });
  });

  it("returns a task with no health/exception/instances as empty, not null", async () => {
    const d = (await getTaskDetail(tenantId, BARE))!;
    expect(d.name).toBe("Empty task");
    expect(d.health).toBeNull();
    expect(d.exception).toBeNull();
    expect(d.verifications).toEqual([]);
    expect(d.instances).toEqual([]);
  });

  it("returns null for a task id that isn't in the registry", async () => {
    expect(await getTaskDetail(tenantId, 999_999)).toBeNull();
  });
});
