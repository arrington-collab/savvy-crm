import { NextResponse } from "next/server";
import { canvassLoginObject, verifyPin, z } from "@savvy/core";
import { adminDb, canvassRep, and, eq, withTenant, createPinLockoutAlert } from "@savvy/db";
import { tenantByKey } from "@/lib/intake";
import { signCanvassToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit, clientIp, bumpFailure, isLocked, setLock, clearTripwire } from "@/lib/rate-limit";
import { log } from "@/lib/log";

// Tripwire: after this many wrong PINs for one rep name (within the window), lock
// that login and alert managers. The per-name rate limit (10/min) means reaching
// this is a sustained attack, not a rep fat-fingering their own PIN.
const PIN_LOCK_THRESHOLD = 15;
const PIN_LOCK_TTL_SECONDS = 900; // 15 minutes (also the failure-count window)

export const runtime = "nodejs";

// Field-app rep login: tenant publicKey + rep name + PIN → signed bearer token.
// Returns { token, rep } on success; the app stores the token and sends it as
// Authorization on later canvass calls (Slice 2+).
const bodySchema = canvassLoginObject.extend({ key: z.string().min(1) });

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req) });
}

export async function POST(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req);
  const reply = (body: unknown, status: number) => NextResponse.json(body, { status, headers });

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return reply({ error: "invalid json" }, 400);
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return reply({ error: parsed.error.flatten() }, 400);
  const { key, name, pin } = parsed.data;

  const { ok } = await checkRateLimit("canvass", `login:${key}:${clientIp(req.headers)}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);
  // Per-rep backoff too (beta hardening): a distributed PIN guess against one
  // name is throttled even across IPs.
  const perName = await checkRateLimit("canvass", `login:${key}:name:${name.trim().toLowerCase()}`);
  if (!perName.ok) return reply({ error: "rate_limited" }, 429);

  const t = await tenantByKey(key);
  if (!t) return reply({ error: "unknown tenant" }, 404);

  const nm = name.trim().toLowerCase();
  const lockKey = `pinlock:${t.id}:${nm}`;
  const failKey = `pinfail:${t.id}:${nm}`;
  // Tripwire lock: a name under active guessing is frozen for the window.
  if (await isLocked(lockKey)) return reply({ error: "locked — try again in 15 minutes" }, 429);

  // Admin read (like crewLogin): filter to this tenant's ACTIVE reps, then match
  // name + verify PIN. Deactivated reps cannot sign in.
  const reps = await adminDb
    .select({ id: canvassRep.id, name: canvassRep.name, pinHash: canvassRep.pinHash, photoUrl: canvassRep.photoUrl, manager: canvassRep.manager })
    .from(canvassRep)
    .where(and(eq(canvassRep.tenantId, t.id), eq(canvassRep.active, true)));

  const match = reps.find((r) => r.name.trim().toLowerCase() === nm && verifyPin(pin, r.pinHash));
  if (!match) {
    log.warn("canvass login failed", { route: "/api/canvass/login", tenantId: t.id });
    const fails = await bumpFailure(failKey, PIN_LOCK_TTL_SECONDS);
    if (fails >= PIN_LOCK_THRESHOLD) {
      await setLock(lockKey, PIN_LOCK_TTL_SECONDS);
      await clearTripwire(failKey);
      // Best-effort manager alert — never fail the login response over it.
      try {
        await withTenant(t.id, (tx) => createPinLockoutAlert(tx, t.id, name.trim()));
        log.warn("canvass pin lockout", { route: "/api/canvass/login", tenantId: t.id, name: name.trim() });
      } catch (e) {
        log.error("pin lockout alert failed", { route: "/api/canvass/login", tenantId: t.id, msg: String(e) });
      }
    }
    return reply({ error: "invalid name or PIN" }, 401);
  }

  // Clean login clears the tripwire for this name.
  await clearTripwire(failKey, lockKey);
  const token = signCanvassToken({ tenantId: t.id, repId: match.id });
  log.info("canvass login ok", { route: "/api/canvass/login", tenantId: t.id, repId: match.id });
  return reply({ token, rep: { id: match.id, name: match.name, photoUrl: match.photoUrl, manager: match.manager } }, 200);
}
