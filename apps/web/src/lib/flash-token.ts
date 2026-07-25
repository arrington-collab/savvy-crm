import { signPayloadToken, verifyPayloadToken, requireSecret } from "@savvy/core";

export interface FlashTokenPayload {
  tenantId: string;
  businessDate: string;
}

// Stateless signed link for the Flash page — same recipe as the status-photo
// proxy (packages/core signPayloadToken/verifyPayloadToken over
// UNSUBSCRIBE_SECRET): no DB row to create, the token itself carries
// tenant+date and is re-verified on every view. Simpler than the cert/estimate
// permanent-code links (packages/db/src/lifecycle/cert-request.ts), which
// persist a booking_link row — Flash is regenerated daily on demand, so a
// durable code table isn't needed here.
function secret(): string {
  return requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
}

export function signFlashToken(tenantId: string, businessDate: string): string {
  return signPayloadToken({ tenantId, businessDate }, secret());
}

export function verifyFlashToken(token: string): FlashTokenPayload | null {
  const payload = verifyPayloadToken<FlashTokenPayload>(token, secret());
  if (!payload?.tenantId || !payload?.businessDate) return null;
  return payload;
}
