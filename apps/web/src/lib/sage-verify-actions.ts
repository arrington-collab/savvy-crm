"use server";
import { randomInt } from "node:crypto";
import { adminDb, user, eq, startPhoneVerification } from "@savvy/db";
import { getTenantSms } from "@savvy/agents";
import { getCurrentUser } from "./current-user";

/**
 * Send the calling org-admin a one-time code to their registered phone. They
 * reply with the code (handled by the inbound Sage command router) to verify
 * the number, which unlocks reply-to-act. Code expires in 10 minutes.
 */
export async function startSagePhoneVerification(): Promise<
  { ok: true } | { error: "not_admin" | "no_phone" | "sms_failed" }
> {
  const { tenantId, userId, role } = await getCurrentUser();
  if (role !== "owner" && role !== "admin") return { error: "not_admin" };

  const [me] = await adminDb.select({ phone: user.phone }).from(user).where(eq(user.id, userId));
  if (!me?.phone) return { error: "no_phone" };

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await startPhoneVerification(tenantId, userId, code, new Date(Date.now() + 10 * 60 * 1000));

  try {
    const { sender, from } = await getTenantSms(tenantId);
    await sender.sendSms({ to: me.phone, from, body: `Savvy code: ${code}. Reply with it to enable Sage-by-text actions.` });
  } catch (e) {
    console.error("sage verify sms failed", e);
    return { error: "sms_failed" };
  }
  return { ok: true };
}
