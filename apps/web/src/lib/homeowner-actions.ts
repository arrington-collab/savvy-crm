"use server";
import { getHomeownerStatus, type HomeownerStatus } from "@savvy/db";
import { verifyPayloadToken, requireSecret } from "@savvy/core";

export async function getHomeownerStatusByToken(token: string): Promise<HomeownerStatus | { error: "invalid" }> {
  const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
  const payload = verifyPayloadToken<{ tenantId: string; jobId: string }>(token, secret);
  if (!payload?.tenantId || !payload?.jobId) return { error: "invalid" };
  const status = await getHomeownerStatus(payload.tenantId, payload.jobId);
  return status ?? { error: "invalid" };
}
