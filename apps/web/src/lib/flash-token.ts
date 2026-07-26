import { signPayloadToken, verifyPayloadToken, requireSecret } from "@savvy/core";

export interface FlashTokenPayload {
  tenantId: string;
  businessDate: string;
  recipient: string;
}

// Stateless signed link for the Flash page — same recipe as the status-photo
// proxy (packages/core signPayloadToken/verifyPayloadToken over
// UNSUBSCRIBE_SECRET): no DB row to create, the token itself carries
// tenant+date+recipient and is re-verified on every view. Simpler than the
// cert/estimate permanent-code links (packages/db/src/lifecycle/cert-request.ts),
// which persist a booking_link row — Flash is regenerated daily on demand, so a
// durable code table isn't needed here.
//
// exp/kind conventions mirror crew-session.ts / canvass-session.ts: an `exp`
// claim (epoch ms as a string) rejected once past, and a `kind` discriminator
// so a differently-purposed token signed with the same shared secret can
// never satisfy this verifier.
const FLASH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days: generous enough to view a past day's flash, bounded enough to matter.

interface SignedFlashToken extends Record<string, string> {
  tenantId: string;
  businessDate: string;
  recipient: string;
  kind: "flash";
  exp: string;
}

function secret(): string {
  return requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
}

export function signFlashToken(tenantId: string, businessDate: string, recipient: string): string {
  const payload: SignedFlashToken = {
    tenantId,
    businessDate,
    recipient,
    kind: "flash",
    exp: String(Date.now() + FLASH_TOKEN_TTL_MS),
  };
  return signPayloadToken(payload, secret());
}

export function verifyFlashToken(token: string): FlashTokenPayload | null {
  const payload = verifyPayloadToken<SignedFlashToken>(token, secret());
  if (!payload?.tenantId || !payload?.businessDate || !payload?.recipient) return null;
  if (payload.kind !== "flash") return null;
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  return { tenantId: payload.tenantId, businessDate: payload.businessDate, recipient: payload.recipient };
}
