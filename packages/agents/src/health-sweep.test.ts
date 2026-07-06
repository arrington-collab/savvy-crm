import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { EvidenceCtx, EvidenceResult } from "@savvy/core";
import {
  adminDb, adminPool, eq, and, inArray, isNull,
  tenant, user, customer, property, job, invoice, lead, communication, taskRegistry, verificationRun, taskHealth, agentRun, jobTask, leadTask, tenantOpsRollup, taskException,
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
const BG = 9405; // a done job_task on a large mismatched invoice -> break-glass page
const NL = 9406; // onboarding.no_lockout on a tenant with a job + null flag -> fail
const SYN = [CLEAN, BAD, UNKNOWN, WRONG, BG, NL];
let tenantId: string;
let leadId: string;
const reg = (id: number, checkKey: string) => ({ id, slug: `sw.${id}`, name: `sw-${id}`, phase: 2, defaultOwner: "HUMAN" as const, defaultMode: "full_auto" as const, scope: "per_lead" as const, checkKey });
const vr = (taskId: number) => adminDb.select().from(verificationRun).where(and(eq(verificationRun.tenantId, tenantId), eq(verificationRun.taskId, taskId))).then((r) => r[0]);

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "SW Co", publicKey: `sw-${Date.now()}`, clerkOrgId: `org_sw_${Date.now()}`, breakGlass: { min_dollars: 1000, deadline_hours: 48 } }).returning();
  tenantId = t!.id;
  await adminDb.insert(user).values({ tenantId, role: "owner", name: "Owner", email: `owner-sw-${Date.now()}@x.com`, phone: "+16025557777" });
  await adminDb.insert(taskRegistry).values([
    reg(CLEAN, "lead.dedupe"), reg(BAD, "comms.no_double_send"), reg(UNKNOWN, "does.not.exist"), reg(WRONG, "comms.no_double_send"),
    { ...reg(BG, "finance.invoice_math"), scope: "per_job" as const, name: "Invoice generation" },
    { ...reg(NL, "onboarding.no_lockout"), scope: "per_tenant_recurring" as const, name: "Onboarding completion monitoring" },
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

  // A done invoice-generation task on a $2,500 invoice that fails finance.invoice_math
  // (amount_due != sum of line items) -> done-but-wrong worth $2,500 -> break-glass.
  const [jb] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "billing" }).returning();
  const [inv] = await adminDb.insert(invoice).values({ tenantId, jobId: jb!.id, amountDue: 2_500_00, lineItems: [] }).returning();
  await adminDb.insert(jobTask).values({ tenantId, jobId: jb!.id, taskId: BG, status: "done", evidence: { type: "invoice", ref: inv!.id } });
});

afterAll(async () => {
  await adminDb.delete(tenantOpsRollup).where(eq(tenantOpsRollup.tenantId, tenantId));
  await adminDb.delete(taskException).where(eq(taskException.tenantId, tenantId));
  await adminDb.delete(verificationRun).where(eq(verificationRun.tenantId, tenantId));
  await adminDb.delete(taskHealth).where(eq(taskHealth.tenantId, tenantId));
  await adminDb.delete(agentRun).where(eq(agentRun.tenantId, tenantId));
  await adminDb.delete(jobTask).where(eq(jobTask.tenantId, tenantId));
  await adminDb.delete(leadTask).where(eq(leadTask.tenantId, tenantId));
  await adminDb.delete(invoice).where(eq(invoice.tenantId, tenantId));
  await adminDb.delete(communication).where(eq(communication.tenantId, tenantId));
  await adminDb.delete(job).where(eq(job.tenantId, tenantId));
  await adminDb.delete(lead).where(eq(lead.tenantId, tenantId));
  await adminDb.delete(property).where(eq(property.tenantId, tenantId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantId));
  await adminDb.delete(user).where(eq(user.tenantId, tenantId));
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

  it("prices a done-but-wrong invoice and pages break-glass within the sweep", async () => {
    await sweepTenantHealth(tenantId);
    const [ex] = await adminDb
      .select()
      .from(taskException)
      .where(and(eq(taskException.tenantId, tenantId), eq(taskException.taskId, BG), isNull(taskException.resolvedAt)));
    expect(ex!.kind).toBe("verification_mismatch");
    expect(ex!.dollarImpactCents).toBe(2_500_00); // the invoice's amount_due
    expect(ex!.breakGlass).toBe(true); // $2,500 >= $1,000 threshold
    expect(ex!.breakGlassNotifiedAt).not.toBeNull(); // paged during the sweep

    const runs = await adminDb.select().from(agentRun).where(and(eq(agentRun.tenantId, tenantId), eq(agentRun.taskKey, "ops.break_glass")));
    expect(runs.length).toBeGreaterThanOrEqual(1); // paged (idempotent across the two sweeps above)
  });

  // Proves onboarding.no_lockout is actually RUN by the sweep via a registry binding
  // (not merely present in evidenceChecks). SW Co has a job + a null requiredCompletedAt
  // (the P0 lockout shape), so the guard must red its task. Uses a synthetic task id
  // like the other sweep fixtures — the REAL 214 binding is verified in the db package's
  // master-task-list.test.ts (binding a synthetic id here avoids racing that seed on the
  // shared test DB when packages run concurrently).
  it("reds the onboarding.no_lockout task for a tenant with a job and a null requiredCompletedAt", async () => {
    await sweepTenantHealth(tenantId);
    // The check ran and failed (deterministic per sweep) ...
    expect((await vr(NL))!.status).toBe("fail");
    // ... and the failure feeds the scoreboard (unhealthy, never green/gray). The
    // exact amber/red depends on how many sweeps this suite has run, so assert the
    // failing band rather than a specific rung.
    const [h] = await adminDb.select().from(taskHealth).where(and(eq(taskHealth.tenantId, tenantId), eq(taskHealth.taskId, NL)));
    expect(["amber", "red"]).toContain(h!.status);
  });
});
