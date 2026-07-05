import { NextResponse } from "next/server";
import { canvassTerritoryObject } from "@savvy/core";
import { withTenant, canvassTerritory } from "@savvy/db";
import { tenantByKey } from "@/lib/intake";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { getTenantId } from "@/lib/tenant";
import { isOrgAdmin } from "@/lib/authz";
import { canvassCors } from "@/lib/canvass-cors";

export const runtime = "nodejs";

// Shared canvassing territories.
// GET  → list territories (field-accessible: bearer session or ?key=).
// POST → create territory (manager-only: requires org-admin session, tenant from
//         session — NOT from a client-supplied public key).

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, POST, OPTIONS") });
}

export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, POST, OPTIONS");
  // Field read: accept bearer session OR public key.
  const sess = verifyCanvassToken(bearerToken(req.headers));
  let tenantId = sess?.tenantId;
  if (!tenantId) {
    const key = new URL(req.url).searchParams.get("key");
    if (key) tenantId = (await tenantByKey(key))?.id;
  }
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
  const parsed = canvassTerritoryObject.safeParse(json);
  if (!parsed.success) return reply({ error: parsed.error.flatten() }, 400);
  const t = parsed.data;

  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(canvassTerritory).values({ tenantId, name: t.name, color: t.color ?? null, points: t.points }).returning({ id: canvassTerritory.id }),
  );
  return reply({ ok: true, id: row?.id ?? null }, 201);
}
