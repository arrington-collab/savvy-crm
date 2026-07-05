import { NextResponse } from "next/server";
import { canvassRepCreateObject, hashPin, z } from "@savvy/core";
import { adminDb, canvassRep, and, eq, sql } from "@savvy/db";
import { tenantByKey } from "@/lib/intake";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { log } from "@/lib/log";

export const runtime = "nodejs";

// GET  /api/canvass/reps?key=  → active reps (id, name, photoUrl) for the login picker.
// POST /api/canvass/reps       → manager creates a rep (name + PIN). Auth = tenant
//   publicKey in the body (same model as the other canvass endpoints). PIN is
//   scrypt-hashed server-side; the plaintext PIN never persists.
const createSchema = canvassRepCreateObject.extend({ key: z.string().min(1) });

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, POST, OPTIONS") });
}

export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, POST, OPTIONS");
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!key) return NextResponse.json({ error: "missing key" }, { status: 400, headers });
  const t = await tenantByKey(key);
  if (!t) return NextResponse.json({ error: "unknown tenant" }, { status: 404, headers });
  const reps = await adminDb
    .select({ id: canvassRep.id, name: canvassRep.name, photoUrl: canvassRep.photoUrl })
    .from(canvassRep)
    .where(and(eq(canvassRep.tenantId, t.id), eq(canvassRep.active, true)));
  return NextResponse.json({ reps }, { status: 200, headers });
}

export async function POST(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, POST, OPTIONS");
  const reply = (body: unknown, status: number) => NextResponse.json(body, { status, headers });

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return reply({ error: "invalid json" }, 400);
  }
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) return reply({ error: parsed.error.flatten() }, 400);
  const { key, name, pin, photoUrl } = parsed.data;

  const { ok } = await checkRateLimit("canvass", `rep:${key}:${clientIp(req.headers)}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  const t = await tenantByKey(key);
  if (!t) return reply({ error: "unknown tenant" }, 404);

  // Reject a duplicate ACTIVE name (case-insensitive) so login stays unambiguous.
  const dupe = await adminDb
    .select({ id: canvassRep.id })
    .from(canvassRep)
    .where(and(
      eq(canvassRep.tenantId, t.id),
      eq(canvassRep.active, true),
      sql`lower(${canvassRep.name}) = ${name.trim().toLowerCase()}`,
    ));
  if (dupe.length) return reply({ error: "a rep with that name already exists" }, 409);

  const [rep] = await adminDb
    .insert(canvassRep)
    .values({ tenantId: t.id, name: name.trim(), pinHash: hashPin(pin), photoUrl: photoUrl ?? null })
    .returning({ id: canvassRep.id, name: canvassRep.name, photoUrl: canvassRep.photoUrl });

  log.info("canvass rep created", { route: "/api/canvass/reps", tenantId: t.id, repId: rep.id });
  return reply({ rep }, 201);
}
