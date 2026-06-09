import { describe, it, expect } from "vitest";
import { TASK_TEMPLATES, PHASE_TO_STAGE } from "../src/seed-data/templates";
import { JOB_STAGE } from "@savvy/core";
import { eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { withTenant } from "../src/tenant";
import { tenant, customer, property, job, jobTask } from "../src/schema/index";
import { seedJobTasks } from "../src/lifecycle/seed-job-tasks";

describe("task lifecycle templates", () => {
  it("has all 212 tasks", () => {
    expect(TASK_TEMPLATES.length).toBe(212);
  });
  it("every phase maps to a stage or ORG", () => {
    const phases = new Set(TASK_TEMPLATES.map((t) => t.phase));
    for (const p of phases) expect(PHASE_TO_STAGE[p]).toBeDefined();
  });
  it("non-org tasks have a valid job_stage; org tasks have stage null", () => {
    for (const t of TASK_TEMPLATES) {
      if (t.orgLevel) expect(t.stage).toBeNull();
      else expect(JOB_STAGE).toContain(t.stage);
    }
  });
  it("keys are unique and stable", () => {
    const keys = TASK_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("All-type tasks expand to 4 job types", () => {
    const allTask = TASK_TEMPLATES.find((t) => t.jobTypes.length === 4);
    expect(allTask).toBeTruthy();
  });
});

describe("seedJobTasks", () => {
  it("seeds retail+All non-org tasks for a retail job, none org-level", async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "SEED-T", publicKey: `seed-${Date.now()}`, clerkOrgId: `org-seed-${Date.now()}` }).returning();
    const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "1 St" }).returning();
    const [j] = await adminDb.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead" }).returning();
    const n = await withTenant(t!.id, (tx) => seedJobTasks(tx as never, { id: j!.id, tenantId: t!.id, type: "retail" }));
    expect(n).toBeGreaterThan(0);
    const rows = await withTenant(t!.id, (tx) => tx.select().from(jobTask).where(eq(jobTask.jobId, j!.id)));
    expect(rows.length).toBe(n);
    expect(rows.every((r) => r.phase !== "Operations & Compliance" && r.phase !== "Reporting & Analytics")).toBe(true);
    await adminDb.delete(jobTask).where(eq(jobTask.tenantId, t!.id));
    await adminDb.delete(job).where(eq(job.tenantId, t!.id));
    await adminDb.delete(property).where(eq(property.tenantId, t!.id));
    await adminDb.delete(customer).where(eq(customer.tenantId, t!.id));
    await adminDb.delete(tenant).where(eq(tenant.id, t!.id));
  });
});
