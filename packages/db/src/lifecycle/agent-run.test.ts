import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "../admin-client.js";
import { withTenant } from "../tenant.js";
import { agentRun, tenant } from "../schema/index.js";
import {
  recordAgentRun,
  beginAgentRun,
  completeAgentRun,
  markStaleRunsTimedOut,
  listAgentActivity,
} from "./agent-run.js";

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

describe("markStaleRunsTimedOut", () => {
  it("closes orphaned running rows past the cutoff", async () => {
    const [t] = await adminDb.insert(tenant).values({
      name: "AR", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
    }).returning();
    const tenantId = t!.id;

    const stale = await beginAgentRun({ tenantId, agent: "orchestrator", taskKey: "test.stale" });
    // force startedAt into the past
    await withTenant(tenantId, (tx) =>
      tx.update(agentRun).set({ startedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(agentRun.id, stale)));
    const fresh = await beginAgentRun({ tenantId, agent: "orchestrator", taskKey: "test.fresh" });

    const n = await markStaleRunsTimedOut(tenantId, new Date(Date.now() - 10 * 60_000));
    expect(n).toBe(1);

    const [staleRow] = await withTenant(tenantId, (tx) => tx.select().from(agentRun).where(eq(agentRun.id, stale)));
    const [freshRow] = await withTenant(tenantId, (tx) => tx.select().from(agentRun).where(eq(agentRun.id, fresh)));
    expect(staleRow!.status).toBe("error");
    expect(staleRow!.error).toBe("timed_out");
    expect(freshRow!.status).toBe("running"); // young run untouched
  });
});

describe("listAgentActivity", () => {
  it("filters by status and paginates with before-cursor", async () => {
    const [t] = await adminDb.insert(tenant).values({
      name: "AR", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
    }).returning();
    const tenantId = t!.id;

    await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "f.ok", status: "ok" });
    await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "f.err", status: "error" });
    const errs = await listAgentActivity(tenantId, { limit: 50, status: "error" });
    expect(errs.every((r) => r.status === "error")).toBe(true);
    expect(errs.length).toBeGreaterThan(0);

    const page1 = await listAgentActivity(tenantId, { limit: 1 });
    const page2 = await listAgentActivity(tenantId, { limit: 1, before: page1[0]!.startedAt });
    expect(page2[0]?.id).not.toBe(page1[0]!.id); // cursor advanced
  });
});
