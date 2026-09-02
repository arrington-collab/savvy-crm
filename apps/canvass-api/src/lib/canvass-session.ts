import "server-only";
import { signPayloadToken, verifyPayloadToken, requireSecret } from "@savvy/core";

// The canvass field app is a SEPARATE origin (savvy-canvass.pages.dev), so a
// sameSite cookie (like crew-session) won't be sent cross-site. Instead the
// login endpoint returns a signed bearer token that the app stores and sends
// as `Authorization: Bearer <token>` on every canvass API call.
const TTL_MS = 12 * 60 * 60 * 1000;
const SECRET = () => requireSecret("CANVASS_SESSION_SECRET", { devFallback: "dev-canvass-secret" });

export type CanvassSession = { tenantId: string; repId: string };

export function signCanvassToken(s: CanvassSession): string {
  return signPayloadToken({ ...s, exp: String(Date.now() + TTL_MS) }, SECRET());
}

export function verifyCanvassToken(token: string | null | undefined): CanvassSession | null {
  if (!token) return null;
  const p = verifyPayloadToken<{ tenantId: string; repId: string; exp: string }>(token, SECRET());
  if (!p) return null;
  const exp = Number(p.exp);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  return { tenantId: p.tenantId, repId: p.repId };
}

/** Extract the bearer token from an Authorization header, or null. */
export function bearerToken(h: Headers): string | null {
  const a = h.get("authorization") || "";
  return a.startsWith("Bearer ") ? a.slice(7).trim() || null : null;
}
