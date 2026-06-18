import "server-only";
import { cookies } from "next/headers";
import { signPayloadToken, verifyPayloadToken } from "@savvy/core";

const COOKIE = "crew_session";
const TTL_MS = 12 * 60 * 60 * 1000;
const SECRET = () => process.env.CREW_SESSION_SECRET ?? "dev-crew-secret";

export type CrewSession = { tenantId: string; crewUserId: string };

export async function getCrewSession(): Promise<CrewSession | null> {
  const jar = await cookies();
  const tok = jar.get(COOKIE)?.value;
  if (!tok) return null;
  const p = verifyPayloadToken<{ tenantId: string; crewUserId: string; exp: string }>(tok, SECRET());
  if (!p) return null;
  if (Number(p.exp) < Date.now()) return null;
  return { tenantId: p.tenantId, crewUserId: p.crewUserId };
}

export async function setCrewCookie(s: CrewSession): Promise<void> {
  const tok = signPayloadToken({ ...s, exp: String(Date.now() + TTL_MS) }, SECRET());
  const jar = await cookies();
  jar.set(COOKIE, tok, {
    httpOnly: true,
    // secure must be OFF over http://localhost or the browser drops the cookie (breaks e2e).
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: TTL_MS / 1000,
  });
}

export async function clearCrewCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}
