import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "../admin-client.js";
import { withTenant } from "../tenant.js";
import { agentRun, tenant, customer, property, lead } from "../schema/index.js";
import {
  recordAgentRun,
  beginAgentRun,
  completeAgentRun,
  markStaleRunsTimedOut,
  listAgentActivity,
  withAgentRun,
  listRunningRuns,
} from "./agent-run.js";

let sharedTenantId: string;
let sharedLeadId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({
    name: "AR Running", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
  }).returning();
  sharedTenantId = t!.id;
  await withTenant(sharedTenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId: sharedTenantId, name: "Homeowner", phone: "+16025550001" }).returning();
    const [p] = await tx.insert(property).values({ tenantId: sharedTenantId, customerId: c!.id, address: "1 Main" }).returning();
    const [l] = await tx.insert(lead).values({ tenantId: sharedTenantId, customerId: c!.id, propertyId: p!.id, status: "new" }).returning();
    sharedLeadId = l!.id;
  });
});

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

describe("withAgentRun", () => {
  it("withAgentRun opens a running row during work and completes ok", async () => {
    const [t] = await adminDb.insert(tenant).values({
      name: "AR", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
    }).returning();
    const tenantId = t!.id;

    let sawRunning = false;
    const result = await withAgentRun(
      { tenantId, agent: "orchestrator", taskKey: "test.wrap", leadId: null },
      async () => {
        const [row] = await withTenant(tenantId, (tx) =>
          tx.select().from(agentRun).where(eq(agentRun.taskKey, "test.wrap")));
        sawRunning = row?.status === "running" && row?.finishedAt === null;
        return 42;
      },
    );
    expect(result).toBe(42);
    expect(sawRunning).toBe(true);
    const [done] = await withTenant(tenantId, (tx) =>
      tx.select().from(agentRun).where(eq(agentRun.taskKey, "test.wrap")));
    expect(done!.status).toBe("ok");
    expect(done!.finishedAt).not.toBeNull();
  });

  it("withAgentRun maps a result to skipped via resolve", async () => {
    const [t] = await adminDb.insert(tenant).values({
      name: "AR", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
    }).returning();
    const tenantId = t!.id;

    await withAgentRun(
      { tenantId, agent: "orchestrator", taskKey: "test.skip" },
      async () => ({ outcome: "skipped" as const }),
      { resolve: (r) => (r.outcome === "skipped" ? { status: "skipped", error: "nothing to do" } : { status: "ok" }) },
    );
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select().from(agentRun).where(eq(agentRun.taskKey, "test.skip")));
    expect(row!.status).toBe("skipped");
    expect(row!.error).toBe("nothing to do");
  });

  it("withAgentRun completes error and rethrows on throw", async () => {
    const [t] = await adminDb.insert(tenant).values({
      name: "AR", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
    }).returning();
    const tenantId = t!.id;

    await expect(withAgentRun(
      { tenantId, agent: "orchestrator", taskKey: "test.throw" },
      async () => { throw new Error("boom"); },
    )).rejects.toThrow("boom");
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select().from(agentRun).where(eq(agentRun.taskKey, "test.throw")));
    expect(row!.status).toBe("error");
    expect(row!.error).toContain("boom");
  });
});

describe("listRunningRuns", () => {
  it("listRunningRuns returns open runs attributed to a job or lead", async () => {
    const tenantId = sharedTenantId;
    const leadId = sharedLeadId;
    const leadRun = await beginAgentRun({ tenantId, agent: "orchestrator", taskKey: "test.run.lead", leadId });
    await beginAgentRun({ tenantId, agent: "orchestrator", taskKey: "test.run.none" }); // no entity → excluded
    await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "test.run.done", leadId, status: "ok" }); // terminal → excluded
    const rows = await listRunningRuns(tenantId);
    const keys = rows.map((r) => r.taskKey);
    expect(keys).toContain("test.run.lead");
    expect(keys).not.toContain("test.run.none");
    expect(keys).not.toContain("test.run.done");
    expect(rows.find((r) => r.id === leadRun)?.leadId).toBe(leadId);
  });
});
