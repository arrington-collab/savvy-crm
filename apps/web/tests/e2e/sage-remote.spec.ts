import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, tenant, user, sageDigest, sageRemoteAction, eq, and } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

// The full inbound Sage round-trip through the REAL Twilio webhook route.
// Green path: a verified owner's "1" resolves the digest item. Red path
// (the slice-1 security deliverable): an unverified number's "1" is logged
// as rejected and NEVER executed — the sage.remote_actions invariant holds.
test("sage: verified owner '1' executes; unverified '1' is blocked (red-path)", async ({ request }) => {
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
  const inboundPhone = t!.inboundPhone!;
  const stamp = Date.now();
  const ownerPhone = `+1544${String(stamp).slice(-7)}`;
  const unverifiedPhone = `+1533${String(stamp).slice(-7)}`;

  // A verified org-admin + an active numbered digest with one no-confirm action
  // (approve_estimate emits an event — no Stripe/DB dependency in dispatch).
  const [owner] = await adminDb
    .insert(user)
    .values({ tenantId, name: "Sage Owner", email: `sage-${stamp}@x.com`, phone: ownerPhone, role: "owner", phoneVerifiedAt: new Date() })
    .returning();
  await adminDb.insert(sageDigest).values({
    tenantId,
    userId: owner!.id,
    items: [{ n: 1, kind: "estimate_approval", entityId: `est-${stamp}`, jobId: null, title: "E2E Co", detail: "estimate", action: "approve_estimate", confirmAmountCents: null }],
  });

  // GREEN — verified owner replies "1": the command is accepted and the action
  // dispatched, logged as a verified immediate action. (Downstream delivery is
  // smoke-verified live; the e2e asserts the security gate — that a verified
  // number's command is accepted and executed as such.)
  const green = await request.post("/api/twilio/inbound", { form: { To: inboundPhone, From: ownerPhone, Body: "1", MessageSid: `SMg${stamp}` } });
  expect(green.ok()).toBeTruthy();
  const executed = await adminDb.select().from(sageRemoteAction).where(and(eq(sageRemoteAction.tenantId, tenantId), eq(sageRemoteAction.phone, ownerPhone)));
  expect(executed.length).toBe(1);
  expect(executed[0]!.verified).toBe(true);
  expect(executed[0]!.confirmationState).toBe("immediate");

  // RED — an unverified number replies "1": logged rejected, never executed.
  const red = await request.post("/api/twilio/inbound", { form: { To: inboundPhone, From: unverifiedPhone, Body: "1", MessageSid: `SMr${stamp}` } });
  expect(red.ok()).toBeTruthy();
  const blocked = await adminDb.select().from(sageRemoteAction).where(and(eq(sageRemoteAction.tenantId, tenantId), eq(sageRemoteAction.phone, unverifiedPhone)));
  expect(blocked.length).toBe(1);
  expect(blocked[0]!.verified).toBe(false);
  expect(blocked[0]!.confirmationState).toBe("rejected");
  expect(blocked[0]!.result).toBe("blocked_unverified");
});
