import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { EvidenceCtx, EvidenceResult } from "@savvy/core";
import {
  adminDb, adminPool, eq, and, inArray,
  tenant, customer, communication, taskRegistry, verificationRun, taskHealth, agentRun,
} from "@savvy/db";
import { runCheck, sweepTenantHealth } from "./health-sweep";

const ctx = (): EvidenceCtx => ({ tenantId: "t", db: adminPool, params: {}, window: { start: new Date(), end: new Date() } });

describe("runCheck (fail-soft)", () => {
  it("passes a check result through", async () => {
    const ok: EvidenceResult = { status: "pass", details: "ok", refs: [] };
    expect((await runCheck(async () => ok, ctx())).status).toBe("pass");
  });
  it("turns a thrown error into stale (never fail)", async () => {
    const r = await runCheck(async () => { throw new Error("boom"); }, ctx());
    expect(r.status).toBe("stale");
  });
  it("turns a timeout into stale", async () => {
    const r = await runCheck(() => new Promise<EvidenceResult>(() => {}), ctx(), 20);
    expect(r.status).toBe("stale");
  });
});

// Synthetic registry tasks bound to REAL checks, so the sweep runs real logic.
const CLEAN = 9401; // lead.dedupe on a tenant with no dup leads -> pass
const BAD = 9402; // comms.no_double_send with a seeded double-send -> fail
const UNKNOWN = 9403; // check_key with no implementation -> skipped
const SYN = [CLEAN, BAD, UNKNOWN];
let tenantId: string;
const reg = (id: number, checkKey: string) => ({ id, slug: `sw.${id}`, name: `sw-${id}`, phase: 2, defaultOwner: "HUMAN" as const, defaultMode: "full_auto" as const, scope: "per_lead" as const, checkKey });
const vr = (taskId: number) => adminDb.select().from(verificationRun).where(and(eq(verificationRun.tenantId, tenantId), eq(verificationRun.taskId, taskId))).then((r) => r[0]);

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "SW Co", publicKey: `sw-${Date.now()}`, clerkOrgId: `org_sw_${Date.now()}` }).returning();
  tenantId = t!.id;
  await adminDb.insert(taskRegistry).values([reg(CLEAN, "lead.dedupe"), reg(BAD, "comms.no_double_send"), reg(UNKNOWN, "does.not.exist")]);
  // Seed a double-send so comms.no_double_send fails.
  await adminDb.insert(customer).values({ tenantId, name: "HO", phone: "+16025550000" });
  await adminDb.insert(communication).values([
    { tenantId, channel: "sms", direction: "outbound", to: "+16025559999", body: "dup body" },
    { tenantId, channel: "sms", direction: "outbound", to: "+16025559999", body: "dup body" },
  ]);
});

afterAll(async () => {
  await adminDb.delete(verificationRun).where(eq(verificationRun.tenantId, tenantId));
  await adminDb.delete(taskHealth).where(eq(taskHealth.tenantId, tenantId));
  await adminDb.delete(agentRun).where(eq(agentRun.tenantId, tenantId));
  await adminDb.delete(communication).where(eq(communication.tenantId, tenantId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantId));
  await adminDb.delete(taskRegistry).where(inArray(taskRegistry.id, SYN));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminPool.end();
});

describe("sweepTenantHealth", () => {
  it("runs bound checks, writes verification_run + task_health, records its own agent_run, and skips unknown checks", async () => {
    await sweepTenantHealth(tenantId);

    expect((await vr(CLEAN))!.status).toBe("pass");
    expect((await vr(BAD))!.status).toBe("fail");
    expect(await vr(UNKNOWN)).toBeUndefined(); // no impl -> skipped, no run written

    const cleanHealth = await adminDb.select().from(taskHealth).where(and(eq(taskHealth.tenantId, tenantId), eq(taskHealth.taskId, CLEAN)));
    expect(cleanHealth).toHaveLength(1);
    const badHealth = await adminDb.select().from(taskHealth).where(and(eq(taskHealth.tenantId, tenantId), eq(taskHealth.taskId, BAD)));
    expect(badHealth[0]!.status).toBe("amber"); // single fail

    const runs = await adminDb.select().from(agentRun).where(and(eq(agentRun.tenantId, tenantId), eq(agentRun.taskKey, "ops.health_sweep")));
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });
});
