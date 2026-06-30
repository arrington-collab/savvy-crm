import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTenant } from "../src/tenant.js";
import { agentRun } from "../src/schema/index.js";
import { recordAgentRun, listAgentActivity } from "../src/lifecycle/agent-run.js";
import { makeTenant, makeJobWithCustomer, makeLeadWithCustomer } from "./helpers.js";

describe("recordAgentRun leadId", () => {
  it("persists the leadId on the run", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithCustomer(tenantId);
    await recordAgentRun({ tenantId, agent: "comms", taskKey: "lead.qualify", status: "ok", leadId });
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(agentRun).where(eq(agentRun.tenantId, tenantId)));
    expect(rows[0]!.leadId).toBe(leadId);
  });
});

describe("listAgentActivity", () => {
  it("shows the customer name for a lead-linked run", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithCustomer(tenantId);
    await recordAgentRun({ tenantId, agent: "comms", taskKey: "lead.qualify", status: "ok", leadId });
    const rows = await listAgentActivity(tenantId, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target).toBe("Test Customer");
    expect(rows[0]!.taskKey).toBe("lead.qualify");
  });

  it("shows the customer name for a job-linked run", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(tenantId);
    await recordAgentRun({ tenantId, agent: "scheduling", taskKey: "job.x", status: "ok", jobId });
    const rows = await listAgentActivity(tenantId, 10);
    expect(rows[0]!.target).toBe("Test Customer");
  });

  it("returns a null target when the run links to neither a lead nor a job", async () => {
    const { tenantId } = await makeTenant();
    await recordAgentRun({ tenantId, agent: "finance", taskKey: "noop", status: "skipped" });
    const rows = await listAgentActivity(tenantId, 10);
    expect(rows[0]!.target).toBeNull();
  });

  it("does not leak another tenant's activity", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const { leadId } = await makeLeadWithCustomer(b.tenantId);
    await recordAgentRun({ tenantId: b.tenantId, agent: "comms", taskKey: "b.only", status: "ok", leadId });
    const rows = await listAgentActivity(a.tenantId, 10);
    expect(rows).toHaveLength(0);
  });
});
