import { NextResponse } from "next/server";
import { allowedCanvassOrigin, canvassContractObject, z } from "@savvy/core";
import { inngest } from "@savvy/agents";
import { createLeadForTenant, tenantByKey } from "@/lib/intake";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { log } from "@/lib/log";

export const runtime = "nodejs";

// Signed-contract intake from the canvass (door-knocking) field app.
// Auth = tenant publicKey in the body (same model as /api/leads).
// The field app is hosted on a separate origin, so this route is CORS-enabled
// via CANVASS_ALLOWED_ORIGINS (see allowedCanvassOrigin in @savvy/core).
// Creates customer + property + lead via the shared intake path (dedupe,
// lead tasks, lead/created), then emits canvass/contract.signed so the
// durable workflow stores the signed contract as a tenant document.
const bodySchema = canvassContractObject.extend({ key: z.string().min(1) });

function corsHeaders(req: Request): Record<string, string> {
  const allow = allowedCanvassOrigin(req.headers.get("origin"), process.env.CANVASS_ALLOWED_ORIGINS);
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allow) h["Access-Control-Allow-Origin"] = allow;
  return h;
}

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

export async function POST(req: Request): Promise<NextResponse> {
  const cors = corsHeaders(req);
  const reply = (body: unknown, status: number) => NextResponse.json(body, { status, headers: cors });

  let json: unknown = null;
  try {
    json = await req.json();
  } catch {
    return reply({ error: "invalid json" }, 400);
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return reply({ error: parsed.error.flatten() }, 400);
  }
  const { key, customer, contract } = parsed.data;

  const ip = clientIp(req.headers);
  const { ok } = await checkRateLimit("canvass", `${key}:${ip}`);
  if (!ok) {
    log.warn("canvass contract rate limited", { route: "/api/canvass/contract", tenantKey: key });
    return reply({ error: "rate_limited" }, 429);
  }

  const t = await tenantByKey(key);
  if (!t) return reply({ error: "unknown tenant" }, 404);

  const leadId = await createLeadForTenant(t.id, { ...customer, source: "door-knocking" });
  try {
    await inngest.send({ name: "canvass/contract.signed", data: { tenantId: t.id, leadId, contract } });
  } catch (e) {
    // Lead is persisted; a missing Inngest engine must not fail intake.
    log.error("canvass/contract.signed emit failed", {
      route: "/api/canvass/contract",
      tenantId: t.id,
      msg: String(e),
    });
  }
  log.info("canvass contract accepted", { route: "/api/canvass/contract", tenantId: t.id });
  return reply({ leadId }, 201);
}
