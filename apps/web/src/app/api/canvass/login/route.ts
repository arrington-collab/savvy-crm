import { NextResponse } from "next/server";
import { canvassLoginObject, verifyPin, z } from "@savvy/core";
import { adminDb, canvassRep, and, eq } from "@savvy/db";
import { tenantByKey } from "@/lib/intake";
import { signCanvassToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { log } from "@/lib/log";

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

  const t = await tenantByKey(key);
  if (!t) return reply({ error: "unknown tenant" }, 404);

  // Admin read (like crewLogin): filter to this tenant's ACTIVE reps, then match
  // name + verify PIN. Deactivated reps cannot sign in.
  const reps = await adminDb
    .select({ id: canvassRep.id, name: canvassRep.name, pinHash: canvassRep.pinHash, photoUrl: canvassRep.photoUrl })
    .from(canvassRep)
    .where(and(eq(canvassRep.tenantId, t.id), eq(canvassRep.active, true)));

  const nm = name.trim().toLowerCase();
  const match = reps.find((r) => r.name.trim().toLowerCase() === nm && verifyPin(pin, r.pinHash));
  if (!match) {
    log.warn("canvass login failed", { route: "/api/canvass/login", tenantId: t.id });
    return reply({ error: "invalid name or PIN" }, 401);
  }

  const token = signCanvassToken({ tenantId: t.id, repId: match.id });
  log.info("canvass login ok", { route: "/api/canvass/login", tenantId: t.id, repId: match.id });
  return reply({ token, rep: { id: match.id, name: match.name, photoUrl: match.photoUrl } }, 200);
}
