import { NextResponse } from "next/server";
import { canvassTerritoryObject } from "@savvy/core";
import { withTenant, canvassTerritory, isNotNull } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassManagerTenantId } from "@/lib/canvass-authz";
import { canvassCors } from "@/lib/canvass-cors";

export const runtime = "nodejs";

// Shared canvassing territories.
// GET  → list territories (bearer session).
// POST → create/update territory (manager-only: canvass MANAGER bearer token from
//         the field app, or an org-admin Clerk session from the web app — tenant
//         from the session, NOT from a client-supplied public key). Upserts on
//         (tenant, clientId) so a re-synced field territory never duplicates.

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, POST, OPTIONS") });
}

export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, POST, OPTIONS");
  // Bearer session ONLY (beta hardening): territory shapes reveal where the
  // company is working, and the publicKey ships in the app.
  const sess = verifyCanvassToken(bearerToken(req.headers));
  const tenantId = sess?.tenantId;
  if (!tenantId) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  const territories = await withTenant(tenantId, (tx) =>
    tx
      .select({ id: canvassTerritory.id, clientId: canvassTerritory.id, name: canvassTerritory.name, color: canvassTerritory.color, points: canvassTerritory.points })
      .from(canvassTerritory),
  );
  return NextResponse.json({ territories }, { status: 200, headers });
}

export async function POST(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  // Privileged mutation: manager bearer token or org-admin session; tenant from
  // the session — never from a client-supplied public key.
  const tenantId = await canvassManagerTenantId(req);
  if (!tenantId) return reply({ error: "unauthorized" }, 401);

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return reply({ error: "invalid json" }, 400);
  }
  const parsed = canvassTerritoryObject.safeParse(json);
  if (!parsed.success) return reply({ error: parsed.error.flatten() }, 400);
  const t = parsed.data;

  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .insert(canvassTerritory)
      .values({ tenantId, clientId: t.clientId, name: t.name, color: t.color ?? null, points: t.points })
      .onConflictDoUpdate({
        target: [canvassTerritory.tenantId, canvassTerritory.clientId],
        // the unique index is partial (client_id IS NOT NULL) — the conflict
        // target must carry the same predicate to match it
        targetWhere: isNotNull(canvassTerritory.clientId),
        set: { name: t.name, color: t.color ?? null, points: t.points },
      })
      .returning({ id: canvassTerritory.id }),
  );
  return reply({ ok: true, id: row?.id ?? null }, 201);
}
