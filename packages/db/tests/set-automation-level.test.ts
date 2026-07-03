import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { setJobTaskAutomationLevel } from "../src/lifecycle/job-tasks.js";
import { jobChecklistItem } from "../src/schema/index.js";
import { eq } from "drizzle-orm";
import { makeTenant, makeJobWithCustomer } from "./helpers.js";

async function seedTask(level: "manual" | "partial" | "full") {
  const { tenantId } = await makeTenant();
  const { jobId } = await makeJobWithCustomer(tenantId);
  const taskId = await withTenant(tenantId, async (tx) => {
    const [t] = await tx
      .insert(jobChecklistItem)
      .values({ tenantId, jobId, key: "x.test", title: "Test task", automationLevel: level, status: "pending" })
      .returning({ id: jobChecklistItem.id });
    return t!.id;
  });
  return { tenantId, jobId, taskId };
}

async function levelOf(tenantId: string, taskId: string) {
  const [t] = await withTenant(tenantId, (tx) => tx.select({ automationLevel: jobChecklistItem.automationLevel }).from(jobChecklistItem).where(eq(jobChecklistItem.id, taskId)));
  return t!.automationLevel;
}

describe("setJobTaskAutomationLevel", () => {
  it("promotes a task's automation level", async () => {
    const { tenantId, taskId } = await seedTask("manual");
    const r = await setJobTaskAutomationLevel({ tenantId, taskId, level: "full" });
    expect(r).toEqual({ ok: true });
    expect(await levelOf(tenantId, taskId)).toBe("full");
  });

  it("returns not_found for an unknown task", async () => {
    const { tenantId } = await seedTask("manual");
    const r = await setJobTaskAutomationLevel({ tenantId, taskId: "00000000-0000-0000-0000-000000000000", level: "partial" });
    expect(r).toEqual({ skipped: "not_found" });
  });
});
