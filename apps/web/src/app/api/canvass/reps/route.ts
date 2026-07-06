import { NextResponse } from "next/server";
import { canvassRepCreateObject, canvassDeactivateObject, hashPin } from "@savvy/core";
import { adminDb, canvassRep, and, eq, sql } from "@savvy/db";
import { tenantByKey } from "@/lib/intake";
import { getTenantId } from "@/lib/tenant";
import { isOrgAdmin } from "@/lib/authz";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { log } from "@/lib/log";

export const runtime = "nodejs";

// GET   /api/canvass/reps?key=  → active reps (id, name, photoUrl) for the login picker
//   (public, read-only — field login devices are unauthenticated).
// POST  /api/canvass/reps       → manager creates a rep (name + PIN). Auth = an
//   authenticated org-admin session; the tenant is derived from that session, NOT
//   from a client-supplied public key. PIN is scrypt-hashed server-side; the
//   plaintext PIN never persists.
// PATCH /api/canvass/reps       → manager deactivates/reactivates a rep. Auth = same
//   org-admin session model as POST (tenant from session, never public key).

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, POST, PATCH, OPTIONS") });
}

export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, POST, PATCH, OPTIONS");
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!key) return NextResponse.json({ error: "missing key" }, { status: 400, headers });
  const t = await tenantByKey(key);
  if (!t) return NextResponse.json({ error: "unknown tenant" }, { status: 404, headers });
  const reps = await adminDb
    .select({ id: canvassRep.id, name: canvassRep.name, photoUrl: canvassRep.photoUrl, manager: canvassRep.manager })
    .from(canvassRep)
    .where(and(eq(canvassRep.tenantId, t.id), eq(canvassRep.active, true)));
  return NextResponse.json({ reps }, { status: 200, headers });
}

export async function POST(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, POST, PATCH, OPTIONS");
  const reply = (body: unknown, status: number) => NextResponse.json(body, { status, headers });

  // Privileged mutation: require an authenticated org-admin session and derive the
  // tenant from it — never from a client-supplied public key (the publicKey is not
  // a secret). Field devices (unauthenticated) only use GET /reps + /login.
  let tenantId: string;
  try {
    tenantId = await getTenantId();
  } catch {
    return reply({ error: "unauthorized" }, 401);
  }
  if (!(await isOrgAdmin())) return reply({ error: "forbidden" }, 403);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return reply({ error: "invalid json" }, 400);
  }
  const parsed = canvassRepCreateObject.safeParse(json);
  if (!parsed.success) return reply({ error: parsed.error.flatten() }, 400);
  const { name, pin, photoUrl, manager } = parsed.data;

  const { ok } = await checkRateLimit("canvass", `rep:${tenantId}:${clientIp(req.headers)}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  // Reject a duplicate ACTIVE name (case-insensitive) so login stays unambiguous.
  const dupe = await adminDb
    .select({ id: canvassRep.id })
    .from(canvassRep)
    .where(and(
      eq(canvassRep.tenantId, tenantId),
      eq(canvassRep.active, true),
      sql`lower(${canvassRep.name}) = ${name.trim().toLowerCase()}`,
    ));
  if (dupe.length) return reply({ error: "a rep with that name already exists" }, 409);

  const [rep] = await adminDb
    .insert(canvassRep)
    .values({ tenantId, name: name.trim(), pinHash: hashPin(pin), photoUrl: photoUrl ?? null, manager: manager ?? false })
    .returning({ id: canvassRep.id, name: canvassRep.name, photoUrl: canvassRep.photoUrl, manager: canvassRep.manager });

  log.info("canvass rep created", { route: "/api/canvass/reps", tenantId, repId: rep.id });
  return reply({ rep }, 201);
}

// Deactivate (or reactivate) a rep without deleting their data (Slice 4).
// Auth = org-admin session; tenant derived from session, NOT from public key.
export async function PATCH(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, POST, PATCH, OPTIONS");
  const reply = (body: unknown, status: number) => NextResponse.json(body, { status, headers });

  // Privileged mutation: require an authenticated org-admin session and derive the
  // tenant from it — never from a client-supplied public key.
  let tenantId: string;
  try {
    tenantId = await getTenantId();
  } catch {
    return reply({ error: "unauthorized" }, 401);
  }
  if (!(await isOrgAdmin())) return reply({ error: "forbidden" }, 403);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return reply({ error: "invalid json" }, 400);
  }
  const parsed = canvassDeactivateObject.safeParse(json);
  if (!parsed.success) return reply({ error: parsed.error.flatten() }, 400);
  const { repId, active } = parsed.data;

  const rows = await adminDb
    .update(canvassRep)
    .set({ active })
    .where(and(eq(canvassRep.tenantId, tenantId), eq(canvassRep.id, repId)))
    .returning({ id: canvassRep.id, active: canvassRep.active });
  if (!rows.length) return reply({ error: "rep not found" }, 404);

  log.info("canvass rep active toggled", { route: "/api/canvass/reps", tenantId, repId, active });
  return reply({ ok: true, rep: rows[0] }, 200);
}
