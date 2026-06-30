"use server";

import { revalidatePath } from "next/cache";
import {
  setTelephonyMode,
  upsertTwilioConnection,
  getTwilioSecret,
  setTelephonyConnectionStatus,
  requestManagedTelephonySetup,
  disconnectTelephony,
} from "@savvy/db";
import { verifyTwilioCreds } from "@savvy/integrations";
import { getTenantId } from "./tenant";
import { getCurrentUser } from "./current-user";

const SETTINGS_PATH = "/settings/integrations";

export async function setTelephonyModeAction(
  mode: "platform" | "byo",
): Promise<{ ok: true } | { error: string }> {
  if (mode !== "platform" && mode !== "byo") return { error: "invalid_mode" };
  const tenantId = await getTenantId();
  await setTelephonyMode(tenantId, mode);
  revalidatePath(SETTINGS_PATH);
  return { ok: true };
}

export async function saveTwilioConnectionAction(input: {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}): Promise<{ ok: true } | { error: string }> {
  if (!input.accountSid || !input.authToken || !input.fromNumber) return { error: "missing_fields" };
  const tenantId = await getTenantId();
  await upsertTwilioConnection(tenantId, {
    secret: { accountSid: input.accountSid, authToken: input.authToken },
    fromNumber: input.fromNumber,
  });
  revalidatePath(SETTINGS_PATH);
  return { ok: true };
}

export async function testTwilioConnectionAction(): Promise<{ ok: true } | { error: string }> {
  const tenantId = await getTenantId();
  const secret = await getTwilioSecret(tenantId);
  if (!secret) return { error: "no_connection" };
  // verifyTwilioCreds accepts { accountSid, authToken } — same shape as TwilioSecret.
  // The secret is read server-side and NEVER returned to the client.
  const valid = await verifyTwilioCreds(secret);
  await setTelephonyConnectionStatus(tenantId, "twilio", valid ? "active" : "pending", { verifiedNow: valid });
  revalidatePath(SETTINGS_PATH);
  return valid ? { ok: true } : { error: "verify_failed" };
}

export async function disconnectTelephonyAction(): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await disconnectTelephony(tenantId, "twilio");
  revalidatePath(SETTINGS_PATH);
  return { ok: true };
}

export async function requestManagedSetupAction(
  feeNote?: string,
): Promise<{ ok: true } | { error: string }> {
  const tenantId = await getTenantId();
  const { userId } = await getCurrentUser();
  // Ensure a placeholder row exists so the managed request has a connection to flip.
  // Ops will overwrite it with real creds on fulfillment.
  await upsertTwilioConnection(tenantId, { secret: { accountSid: "", authToken: "" }, fromNumber: "" });
  await requestManagedTelephonySetup(tenantId, "twilio", { requestedBy: userId, feeNote });
  revalidatePath(SETTINGS_PATH);
  return { ok: true };
}
