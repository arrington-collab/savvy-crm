import { NextResponse } from "next/server";
import { adminDb, tenant, sql } from "@savvy/db";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

// GET /api/canvass/tenant?slug=<subdomain> — resolves the subdomain the field
// app is being served from to that company's public key AND its whole branding
// / behaviour config.
//
// Why this exists: every per-customer setting (public key, feature flags,
// outcome + status label overrides, accent colours, logo) used to be a
// hardcoded object in the app's client JS, so onboarding one company meant
// editing code and redeploying the app for EVERY existing company. With this,
// onboarding is a database row.
//
// Public and read-only by design, exactly like GET /reps and GET /company:
// everything returned here already ships to the browser, and the public key
// alone cannot read a single homeowner record — PII stays behind a rep's
// bearer token.
export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, OPTIONS") });
}

// Subdomain label: what can appear before ".knockjockey.com".
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const { ok } = await checkRateLimit("canvass-read", `tenant:${clientIp(req.headers)}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  const slug = (new URL(req.url).searchParams.get("slug") || "").trim().toLowerCase();
  if (!slug || !SLUG.test(slug)) return reply({ error: "bad slug" }, 400);

  // Matched on settings->>'canvassSlug'. adminDb (RLS-bypassing) is correct
  // here for the same reason as the login rep lookup: there is no tenant
  // context to scope by yet — resolving it is the whole point of the call.
  const [t] = await adminDb
    .select({ name: tenant.name, publicKey: tenant.publicKey, settings: tenant.settings })
    .from(tenant)
    .where(sql`${tenant.settings}->>'canvassSlug' = ${slug}`)
    .limit(1);

  if (!t || !t.publicKey) return reply({ error: "unknown company" }, 404);

  const s = (t.settings ?? {}) as {
    canvassLogo?: string;
    canvass?: Record<string, unknown>;
  };

  return reply(
    {
      key: t.publicKey,
      name: t.name,
      logo: typeof s.canvassLogo === "string" ? s.canvassLogo : null,
      // Free-form so a new per-vertical toggle never needs a schema migration:
      // storms, outcomeLabels, statusLabels, accent, accent2, logoDark.
      config: s.canvass ?? {},
    },
    200,
  );
}
