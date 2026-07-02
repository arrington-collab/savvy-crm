import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  adminDb, adminPool, eq, and, inArray,
  tenant, user, taskRegistry, taskHealth, verificationRun, agentRun,
} from "@savvy/db";
import { sendTenantDigest } from "./ops-digest";

const T = 9701; // a task that is red -> an exception exists
let withEx: string; // tenant with an exception
let noEx: string; // tenant with no exceptions

const reg = { id: T, slug: `dg.${T}`, name: "Invoice generation", phase: 9, defaultOwner: "HUMAN" as const, defaultMode: "full_auto" as const, scope: "per_job" as const, checkKey: `test.${T}`, estFounderMinutes: "15" };

beforeAll(async () => {
  const [a] = await adminDb.insert(tenant).values({ name: "DG-ex", publicKey: `dgx-${Date.now()}`, clerkOrgId: `org_dgx_${Date.now()}` }).returning();
  const [b] = await adminDb.insert(tenant).values({ name: "DG-clean", publicKey: `dgc-${Date.now()}`, clerkOrgId: `org_dgc_${Date.now()}` }).returning();
  withEx = a!.id; noEx = b!.id;
  await adminDb.insert(taskRegistry).values(reg).onConflictDoNothing({ target: taskRegistry.id });
  // Owners (recipients).
  await adminDb.insert(user).values([
    { tenantId: withEx, role: "owner", name: "Owner A", email: `owner-a-${Date.now()}@x.com`, phone: "+16025551111" },
    { tenantId: noEx, role: "owner", name: "Owner B", email: `owner-b-${Date.now()}@x.com`, phone: "+16025552222" },
  ]);
  // withEx has a red task -> one exception; noEx has none.
  await adminDb.insert(taskHealth).values({ tenantId: withEx, taskId: T, status: "red", effectiveMode: "full_auto", openExceptionCount: 1 });
  await adminDb.insert(verificationRun).values({ tenantId: withEx, taskId: T, checkKey: reg.checkKey, status: "fail" });
});

afterAll(async () => {
  for (const tid of [withEx, noEx]) {
    await adminDb.delete(verificationRun).where(eq(verificationRun.tenantId, tid));
    await adminDb.delete(taskHealth).where(eq(taskHealth.tenantId, tid));
    await adminDb.delete(agentRun).where(eq(agentRun.tenantId, tid));
    await adminDb.delete(user).where(eq(user.tenantId, tid));
    await adminDb.delete(tenant).where(eq(tenant.id, tid));
  }
  await adminDb.delete(taskRegistry).where(inArray(taskRegistry.id, [T]));
  await adminPool.end();
});

describe("sendTenantDigest", () => {
  it("sends the owner a summary SMS and records an agent_run when there are exceptions", async () => {
    const sms = { sender: { sendSms: vi.fn().mockResolvedValue({ sid: "sm-dg" }) }, from: "+15550000000" };
    const r = await sendTenantDigest(withEx, { sms, email: { sendEmail: vi.fn() } });
    expect(r.count).toBe(1);
    expect(sms.sender.sendSms).toHaveBeenCalledOnce();
    expect(sms.sender.sendSms.mock.calls[0]![0].to).toBe("+16025551111");
    expect(sms.sender.sendSms.mock.calls[0]![0].body).toContain("task");
    const runs = await adminDb.select().from(agentRun).where(and(eq(agentRun.tenantId, withEx), eq(agentRun.taskKey, "ops.digest")));
    expect(runs.length).toBe(1);
  });

  it("sends nothing when the tenant has no exceptions", async () => {
    const sms = { sender: { sendSms: vi.fn() }, from: "+15550000000" };
    const r = await sendTenantDigest(noEx, { sms, email: { sendEmail: vi.fn() } });
    expect(r.sent).toBe(0);
    expect(sms.sender.sendSms).not.toHaveBeenCalled();
  });
});
