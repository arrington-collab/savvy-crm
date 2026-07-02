import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { recomputeTaskHealth } from "../src/index.js";
import { tenant, customer, property, job, taskRegistry, tenantTaskConfig, taskHealth, verificationRun, jobTask } from "../src/schema/index.js";

// Isolated synthetic registry tasks so each scenario's health is independent.
const GREEN = 9301, FAILS = 9302, WRONG = 9303, MODE = 9304, OFF = 9305;
const SYN = [GREEN, FAILS, WRONG, MODE, OFF];

let tenantId: string;
let jobId: string;

const reg = (id: number) => ({ id, slug: `synh.${id}`, name: `h-${id}`, phase: 7, defaultOwner: "HUMAN" as const, defaultMode: "full_auto" as const, scope: "per_job" as const, checkKey: `test.${id}`, slaHours: 24 });
const health = (taskId: number) => adminDb.select().from(taskHealth).where(and(eq(taskHealth.tenantId, tenantId), eq(taskHealth.taskId, taskId))).then((r) => r[0]);
const HRS = (n: number) => new Date(Date.now() - n * 3_600_000);

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "TH Co", publicKey: `th-${Date.now()}`, clerkOrgId: `org_th_${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "HO" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Main" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "billing" }).returning();
  jobId = j!.id;

  await adminDb.insert(taskRegistry).values(SYN.map(reg));

  // GREEN: prior 13-day streak + a fresh pass -> earns green (14).
  await adminDb.insert(taskHealth).values({ tenantId, taskId: GREEN, status: "amber", effectiveMode: "full_auto", cleanStreakDays: 13 });
  await adminDb.insert(verificationRun).values({ tenantId, taskId: GREEN, checkKey: reg(GREEN).checkKey, status: "pass", ranAt: HRS(1) });

  // FAILS: two consecutive fails -> red.
  await adminDb.insert(verificationRun).values([
    { tenantId, taskId: FAILS, checkKey: reg(FAILS).checkKey, status: "fail", ranAt: HRS(25) },
    { tenantId, taskId: FAILS, checkKey: reg(FAILS).checkKey, status: "fail", ranAt: HRS(1) },
  ]);

  // WRONG: long streak + a passing check, but a done job_task flipped to exception -> red.
  await adminDb.insert(taskHealth).values({ tenantId, taskId: WRONG, status: "green", effectiveMode: "full_auto", cleanStreakDays: 30 });
  await adminDb.insert(verificationRun).values({ tenantId, taskId: WRONG, checkKey: reg(WRONG).checkKey, status: "pass", ranAt: HRS(1) });
  await adminDb.insert(jobTask).values({ tenantId, jobId, taskId: WRONG, status: "exception" });

  // MODE: tenant overrides mode to assisted.
  await adminDb.insert(tenantTaskConfig).values({ tenantId, taskId: MODE, mode: "assisted" });
  await adminDb.insert(verificationRun).values({ tenantId, taskId: MODE, checkKey: reg(MODE).checkKey, status: "pass", ranAt: HRS(1) });

  // OFF: disabled for the tenant -> gray.
  await adminDb.insert(tenantTaskConfig).values({ tenantId, taskId: OFF, enabled: false });
});

afterAll(async () => {
  await adminDb.delete(taskHealth).where(eq(taskHealth.tenantId, tenantId));
  await adminDb.delete(verificationRun).where(eq(verificationRun.tenantId, tenantId));
  await adminDb.delete(jobTask).where(eq(jobTask.tenantId, tenantId));
  await adminDb.delete(tenantTaskConfig).where(eq(tenantTaskConfig.tenantId, tenantId));
  await adminDb.delete(taskRegistry).where(inArray(taskRegistry.id, SYN));
  await adminDb.delete(job).where(eq(job.tenantId, tenantId));
  await adminDb.delete(property).where(eq(property.tenantId, tenantId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminPool.end();
});

describe("recomputeTaskHealth", () => {
  it("earns green at a 14-day streak and stamps last_verified_at", async () => {
    const r = await recomputeTaskHealth(tenantId, GREEN);
    expect(r.status).toBe("green");
    expect(r.cleanStreakDays).toBe(14);
    const row = await health(GREEN);
    expect(row!.status).toBe("green");
    expect(row!.cleanStreakDays).toBe(14);
    expect(row!.lastVerifiedAt).not.toBeNull();
  });

  it("goes red on two consecutive fails and counts fails in the 7d window", async () => {
    await recomputeTaskHealth(tenantId, FAILS);
    const row = await health(FAILS);
    expect(row!.status).toBe("red");
    expect(row!.cleanStreakDays).toBe(0);
    expect(row!.failCount7d).toBe(2);
  });

  it("goes red on done-but-wrong (an exception ledger row) and emits a regression from green", async () => {
    const r = await recomputeTaskHealth(tenantId, WRONG);
    expect(r.status).toBe("red");
    expect(r.emitsRegression).toBe(true); // was green
    const row = await health(WRONG);
    expect(row!.openExceptionCount).toBe(1);
  });

  it("persists the tenant's effective_mode override", async () => {
    await recomputeTaskHealth(tenantId, MODE);
    expect((await health(MODE))!.effectiveMode).toBe("assisted");
  });

  it("is gray when the task is disabled for the tenant", async () => {
    const r = await recomputeTaskHealth(tenantId, OFF);
    expect(r.status).toBe("gray");
    expect((await health(OFF))!.status).toBe("gray");
  });
});
