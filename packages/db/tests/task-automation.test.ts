import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { resolveTaskAutomation, gateAgentAutomation } from "../src/lifecycle/task-automation.js";
import { jobTask, agentRun } from "../src/schema/index.js";
import { adminDb } from "../src/admin-client.js";
import { eq, and } from "drizzle-orm";
import { makeTenant, makeJobWithCustomer } from "./helpers.js";

const KEY = "estimating-049";

async function seedTaskedJob(level: string): Promise<{ tenantId: string; jobId: string }> {
  const { tenantId } = await makeTenant();
  const { jobId } = await makeJobWithCustomer(tenantId);
  await adminDb.insert(jobTask).values({ tenantId, jobId, key: KEY, title: "Estimate import", automationLevel: level as never, status: "pending" });
  return { tenantId, jobId };
}

describe("resolveTaskAutomation", () => {
  it("returns the task's level, or 'full' when no matching task", async () => {
    const { tenantId, jobId } = await seedTaskedJob("manual");
    const lvl = await withTenant(tenantId, (tx) => resolveTaskAutomation(tx, jobId, KEY));
    expect(lvl).toBe("manual");
    const missing = await withTenant(tenantId, (tx) => resolveTaskAutomation(tx, jobId, "nope-999"));
    expect(missing).toBe("full");
  });
});

describe("gateAgentAutomation", () => {
  it("proceeds for a full task and writes no defer marker / no skip log", async () => {
    const { tenantId, jobId } = await seedTaskedJob("full");
    const res = await gateAgentAutomation({ tenantId, jobId, taskKey: KEY, agent: "claims" });
    expect(res).toEqual({ proceed: true, level: "full" });
    const [t] = await withTenant(tenantId, (tx) => tx.select({ d: jobTask.deferredAt }).from(jobTask).where(and(eq(jobTask.jobId, jobId), eq(jobTask.key, KEY))));
    expect(t!.d).toBeNull();
    const runs = await withTenant(tenantId, (tx) => tx.select().from(agentRun).where(eq(agentRun.jobId, jobId)));
    expect(runs).toHaveLength(0);
  });

  it("defers a manual task: sets deferred_at + writes a skipped agent_run", async () => {
    const { tenantId, jobId } = await seedTaskedJob("manual");
    const res = await gateAgentAutomation({ tenantId, jobId, taskKey: KEY, agent: "claims" });
    expect(res).toEqual({ proceed: false, level: "manual" });
    const [t] = await withTenant(tenantId, (tx) => tx.select({ d: jobTask.deferredAt }).from(jobTask).where(and(eq(jobTask.jobId, jobId), eq(jobTask.key, KEY))));
    expect(t!.d).not.toBeNull();
    const runs = await withTenant(tenantId, (tx) => tx.select().from(agentRun).where(and(eq(agentRun.jobId, jobId), eq(agentRun.status, "skipped"))));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.taskKey).toBe(KEY);
  });

  it("defers a partial task too (only full auto-acts)", async () => {
    const { tenantId, jobId } = await seedTaskedJob("partial");
    const res = await gateAgentAutomation({ tenantId, jobId, taskKey: KEY, agent: "claims" });
    expect(res.proceed).toBe(false);
  });
});
