import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "../admin-client.js";
import { withTenant } from "../tenant.js";
import { agentRun, tenant } from "../schema/index.js";
import { recordAgentRun, beginAgentRun, completeAgentRun } from "./agent-run.js";

describe("recordAgentRun", () => {
  it("writes an agent_run row with taskKey, skipped status, finishedAt set", async () => {
    const [t] = await adminDb.insert(tenant).values({
      name: "AR", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
    }).returning();
    await recordAgentRun({
      tenantId: t!.id, agent: "finance", taskKey: "test.task", status: "skipped", error: "x",
    });
    const rows = await withTenant(t!.id, (tx) =>
      tx.select().from(agentRun).where(eq(agentRun.tenantId, t!.id)));
    expect(rows.length).toBe(1);
    expect(rows[0]!.agent).toBe("finance");
    expect(rows[0]!.taskKey).toBe("test.task");
    expect(rows[0]!.status).toBe("skipped");
    expect(rows[0]!.finishedAt).not.toBeNull();
  });
});

describe("two-phase agent run lifecycle", () => {
  it("beginAgentRun inserts a running row with null finishedAt", async () => {
    const [t] = await adminDb.insert(tenant).values({
      name: "AR", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
    }).returning();
    const tenantId = t!.id;
    const runId = await beginAgentRun({ tenantId, agent: "orchestrator", taskKey: "test.begin" });
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select().from(agentRun).where(eq(agentRun.id, runId)));
    expect(row!.status).toBe("running");
    expect(row!.finishedAt).toBeNull();
  });

  it("completeAgentRun transitions the row to terminal and stamps finishedAt", async () => {
    const [t] = await adminDb.insert(tenant).values({
      name: "AR", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
    }).returning();
    const tenantId = t!.id;
    const runId = await beginAgentRun({ tenantId, agent: "orchestrator", taskKey: "test.complete" });
    await completeAgentRun({ tenantId, runId, status: "ok", tokens: 10, costCents: 2 });
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select().from(agentRun).where(eq(agentRun.id, runId)));
    expect(row!.status).toBe("ok");
    expect(row!.finishedAt).not.toBeNull();
    expect(row!.tokens).toBe(10);
  });

  it("recordAgentRun still writes one terminal row (wrapper unchanged for callers)", async () => {
    const [t] = await adminDb.insert(tenant).values({
      name: "AR", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
    }).returning();
    const tenantId = t!.id;
    await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "test.record", status: "ok" });
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select().from(agentRun).where(eq(agentRun.taskKey, "test.record")));
    expect(row!.status).toBe("ok");
    expect(row!.finishedAt).not.toBeNull();
  });
});
