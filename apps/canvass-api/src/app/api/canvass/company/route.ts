import { NextResponse } from "next/server";
import { tenantByKey } from "@/lib/intake";
import { canvassCors } from "@/lib/canvass-cors";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { withTenant, isCanvassManager, tenant, eq } from "@savvy/db";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

// GET /api/canvass/company?key=<publicKey> — resolves a company code to its
// display name (+ optional canvass logo from tenant settings) so the field app
// can brand itself at onboarding, BEFORE any rep logs in. Public + read-only,
// same model as GET /reps: the publicKey is not a secret (it ships in the app),
// and this returns only a name — publicKeys are 40-char random, not guessable.
export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, POST, OPTIONS") });
}

export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, POST, OPTIONS");
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!key) return NextResponse.json({ error: "missing key" }, { status: 400, headers });
  const t = await tenantByKey(key);
  if (!t) return NextResponse.json({ error: "unknown company code" }, { status: 404, headers });
  const settings = (t.settings ?? {}) as { canvassLogo?: string; canvassId?: Record<string, string> };
  return NextResponse.json(
    {
      name: t.name,
      logo: typeof settings.canvassLogo === "string" ? settings.canvassLogo : null,
      canvassId: settings.canvassId ?? null,
    },
    { status: 200, headers },
  );
}

const ID_FIELDS = ["licenseNo", "insuranceCarrier", "insurancePolicy", "insurancePhone", "coiUrl", "metaPixelId"] as const;

// POST /api/canvass/company — manager-only: merge company ID/insurance config
// (published on the public /id/ page) into tenant.settings.canvassId.
export async function POST(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });
  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);
  let json: unknown;
  try { json = await req.json(); } catch { return reply({ error: "invalid json" }, 400); }
  const body = (json ?? {}) as Record<string, unknown>;
  const patch: Record<string, string> = {};
  for (const f of ID_FIELDS) if (typeof body[f] === "string") patch[f] = (body[f] as string).slice(0, 300);
  const done = await withTenant(sess.tenantId, async (tx) => {
    if (!(await isCanvassManager(tx, sess.tenantId, sess.repId))) return false;
    const [t] = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, sess.tenantId));
    const settings = (t?.settings ?? {}) as Record<string, unknown>;
    const prev = (settings.canvassId ?? {}) as Record<string, string>;
    await tx.update(tenant).set({ settings: { ...settings, canvassId: { ...prev, ...patch } } }).where(eq(tenant.id, sess.tenantId));
    return true;
  });
  if (!done) return reply({ error: "forbidden" }, 403);
  return reply({ ok: true }, 200);
}
