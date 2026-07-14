import { NextResponse } from "next/server";
import { z } from "@savvy/core";
import { adminDb, withTenant, canvassRep, eq, createScan } from "@savvy/db";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

const bodySchema = z.object({
  repId: z.string().uuid(),
  name: z.string().max(120).optional(),
  phone: z.string().max(40).optional(),
  ack: z.boolean().optional(),
});

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "POST, OPTIONS") });
}

// PUBLIC write (homeowner ID-scan capture): strict whitelist, active-rep check,
// hard per-IP limit. Echoes nothing back.
export async function POST(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const { ok } = await checkRateLimit("canvass", `scan:${clientIp(req.headers)}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  let json: unknown;
  try { json = await req.json(); } catch { return reply({ error: "invalid json" }, 400); }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return reply({ error: "bad_request" }, 400);
  const b = parsed.data;
  if (!b.name?.trim() && !b.phone?.trim()) return reply({ error: "name_or_phone" }, 400);

  const [rep] = await adminDb
    .select({ tenantId: canvassRep.tenantId, active: canvassRep.active })
    .from(canvassRep).where(eq(canvassRep.id, b.repId));
  if (!rep || rep.active === false) return reply({ error: "not_found" }, 404);

  await withTenant(rep.tenantId, (tx) =>
    createScan(tx, {
      tenantId: rep.tenantId, repId: b.repId,
      name: b.name?.trim() || null, phone: b.phone?.trim() || null, ack: !!b.ack,
      userAgent: (req.headers.get("user-agent") || "").slice(0, 300) || null,
    }),
  );
  return reply({ ok: true }, 201);
}
