import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { EvidenceCtx, EvidenceResult } from "@savvy/core";
import {
  adminDb, adminPool, eq, and, inArray,
  tenant, customer, property, lead, communication, taskRegistry, verificationRun, taskHealth, agentRun, leadTask, tenantOpsRollup,
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
const WRONG = 9404; // a done lead_task whose evidence IS a violation -> spot-verify exception
const SYN = [CLEAN, BAD, UNKNOWN, WRONG];
let tenantId: string;
let leadId: string;
const reg = (id: number, checkKey: string) => ({ id, slug: `sw.${id}`, name: `sw-${id}`, phase: 2, defaultOwner: "HUMAN" as const, defaultMode: "full_auto" as const, scope: "per_lead" as const, checkKey });
const vr = (taskId: number) => adminDb.select().from(verificationRun).where(and(eq(verificationRun.tenantId, tenantId), eq(verificationRun.taskId, taskId))).then((r) => r[0]);

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "SW Co", publicKey: `sw-${Date.now()}`, clerkOrgId: `org_sw_${Date.now()}` }).returning();
  tenantId = t!.id;
  await adminDb.insert(taskRegistry).values([
    reg(CLEAN, "lead.dedupe"), reg(BAD, "comms.no_double_send"), reg(UNKNOWN, "does.not.exist"), reg(WRONG, "comms.no_double_send"),
  ]);
  // Seed a double-send so comms.no_double_send fails; capture the offending ids.
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "HO", phone: "+16025550000" }).returning();
  const dup = await adminDb.insert(communication).values([
    { tenantId, channel: "sms", direction: "outbound", to: "+16025559999", body: "dup body" },
    { tenantId, channel: "sms", direction: "outbound", to: "+16025559999", body: "dup body" },
  ]).returning({ id: communication.id });

  // A lead whose follow-up task claims done with evidence pointing at a message
  // the checker independently flags — done-but-wrong.
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Main" }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, status: "contacted" }).returning();
  leadId = l!.id;
  await adminDb.insert(leadTask).values({ tenantId, leadId, taskId: WRONG, status: "done", evidence: { type: "communication", ref: dup[0]!.id } });
});

afterAll(async () => {
  await adminDb.delete(tenantOpsRollup).where(eq(tenantOpsRollup.tenantId, tenantId));
  await adminDb.delete(verificationRun).where(eq(verificationRun.tenantId, tenantId));
  await adminDb.delete(taskHealth).where(eq(taskHealth.tenantId, tenantId));
  await adminDb.delete(agentRun).where(eq(agentRun.tenantId, tenantId));
  await adminDb.delete(leadTask).where(eq(leadTask.tenantId, tenantId));
  await adminDb.delete(communication).where(eq(communication.tenantId, tenantId));
  await adminDb.delete(lead).where(eq(lead.tenantId, tenantId));
  await adminDb.delete(property).where(eq(property.tenantId, tenantId));
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

  it("spot-verifies a done ledger row: done-but-wrong -> exception -> red health", async () => {
    await sweepTenantHealth(tenantId);
    const [lt] = await adminDb.select().from(leadTask).where(and(eq(leadTask.leadId, leadId), eq(leadTask.taskId, WRONG)));
    expect(lt!.status).toBe("exception");
    const [h] = await adminDb.select().from(taskHealth).where(and(eq(taskHealth.tenantId, tenantId), eq(taskHealth.taskId, WRONG)));
    expect(h!.status).toBe("red");
  });
});
