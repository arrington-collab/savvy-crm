import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client.js";
import { user, invoice } from "../src/schema/index.js";
import { makeTenant, makeUser, makeJobWithCustomer } from "./helpers.js";
import {
  startPhoneVerification,
  confirmPhoneVerification,
  userByPhone,
  saveSageDigest,
  getActiveSageDigest,
  recordSageRemoteAction,
  findResolvedAction,
  getPendingConfirm,
  resolvePendingConfirm,
  loadSageActionables,
} from "../src/lifecycle/sage.js";

async function makeOwner(tenantId: string, phone: string): Promise<string> {
  const { userId } = await makeUser(tenantId);
  await adminDb.update(user).set({ phone, role: "owner" }).where(eq(user.id, userId));
  return userId;
}

describe("phone verification", () => {
  it("verifies a correct, unexpired code and rejects a wrong one", async () => {
    const { tenantId } = await makeTenant();
    const phone = `+1555${Date.now().toString().slice(-7)}`;
    const userId = await makeOwner(tenantId, phone);
    await startPhoneVerification(tenantId, userId, "111111", new Date(Date.now() + 600000));

    expect(await confirmPhoneVerification(tenantId, phone, "999999", new Date())).toBeNull();

    const ok = await confirmPhoneVerification(tenantId, phone, "111111", new Date());
    expect(ok).toEqual({ userId });

    const matched = await userByPhone(tenantId, phone, { verifiedOnly: true });
    expect(matched?.id).toBe(userId);
  });

  it("rejects an expired code", async () => {
    const { tenantId } = await makeTenant();
    const phone = `+1556${Date.now().toString().slice(-7)}`;
    const userId = await makeOwner(tenantId, phone);
    await startPhoneVerification(tenantId, userId, "222222", new Date(Date.now() - 1000));
    expect(await confirmPhoneVerification(tenantId, phone, "222222", new Date())).toBeNull();
    expect(await userByPhone(tenantId, phone, { verifiedOnly: true })).toBeNull();
  });
});

describe("digest mapping + idempotency", () => {
  it("supersedes the prior active digest on each send", async () => {
    const { tenantId } = await makeTenant();
    const userId = await makeOwner(tenantId, `+1557${Date.now().toString().slice(-7)}`);
    const item = (entityId: string) => [{ n: 1, kind: "invoice_overdue", entityId, jobId: null, title: "A", detail: "d", action: "send_invoice", confirmAmountCents: 100 }];
    await saveSageDigest(tenantId, userId, item("e1"));
    const d2 = await saveSageDigest(tenantId, userId, item("e2"));
    const active = await getActiveSageDigest(tenantId, userId);
    expect(active?.id).toBe(d2);
    expect(active?.items[0]?.entityId).toBe("e2");
  });

  it("finds a resolved action for replay and returns null for an unresolved slot", async () => {
    const { tenantId } = await makeTenant();
    const userId = await makeOwner(tenantId, `+1558${Date.now().toString().slice(-7)}`);
    const d = await saveSageDigest(tenantId, userId, [{ n: 1, kind: "invoice_overdue", entityId: "e1", jobId: null, title: "A", detail: "d", action: "send_invoice", confirmAmountCents: 100 }]);
    await recordSageRemoteAction({ tenantId, userId, phone: "+15550000000", digestId: d, n: 1, kind: "invoice_overdue", action: "send_invoice", confirmationState: "immediate", verified: true, result: "executed", resolvedAt: new Date() });
    const found = await findResolvedAction(tenantId, d, 1);
    expect(found?.result).toBe("executed");
    expect(await findResolvedAction(tenantId, d, 2)).toBeNull();
  });

  it("returns and resolves a pending money confirm", async () => {
    const { tenantId } = await makeTenant();
    const userId = await makeOwner(tenantId, `+1559${Date.now().toString().slice(-7)}`);
    const d = await saveSageDigest(tenantId, userId, [{ n: 1, kind: "estimate_approval", entityId: "est1", jobId: "job1", title: "K", detail: "d", action: "approve_estimate", confirmAmountCents: 3275000 }]);
    const id = await recordSageRemoteAction({ tenantId, userId, phone: "+15550000000", digestId: d, n: 1, kind: "estimate_approval", action: "approve_estimate", exceptionRef: "est1", confirmationState: "pending", verified: true });
    const pend = await getPendingConfirm(tenantId, userId);
    expect(pend?.id).toBe(id);
    expect(pend?.action).toBe("approve_estimate");
    await resolvePendingConfirm(tenantId, id, "confirmed", "executed", new Date());
    expect(await getPendingConfirm(tenantId, userId)).toBeNull();
  });
});

describe("loadSageActionables", () => {
  it("surfaces an overdue invoice as a send_invoice item with its amount", async () => {
    const { tenantId } = await makeTenant();
    const { jobId, customerId } = await makeJobWithCustomer(tenantId);
    await adminDb.insert(invoice).values({ tenantId, jobId, customerId, status: "overdue", amountDue: 840000, dueAt: new Date(Date.now() - 86400000) });
    const items = await loadSageActionables(tenantId);
    const inv = items.find((i) => i.action === "send_invoice");
    expect(inv).toBeTruthy();
    expect(inv?.confirmAmountCents).toBe(840000);
    expect(inv?.jobId).toBe(jobId);
  });
});
