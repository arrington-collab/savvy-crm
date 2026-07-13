import { resolveEstimateLink, beginEstimateAcceptance, withTenant, estimate, lead, user, eq } from "@savvy/db";
import { httpDocuseal, makeFakeDocuseal, stripeGateway, makeFakeStripe } from "@savvy/integrations";
import { getTenantSms } from "@savvy/agents";
import { log } from "@/lib/log";

export const runtime = "nodejs";

// Public, token-gated: kicks off the accept motion — persists the pick, mints
// the DocuSeal submission + Stripe deposit checkout, returns both URLs.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params;
  const link = await resolveEstimateLink(code);
  if (!link) return new Response("Not found", { status: 404 });

  let body: { tier?: string; color?: string; email?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  if (!body.tier || !body.color) return Response.json({ ok: false, error: "missing_fields" }, { status: 400 });

  const origin = new URL(req.url).origin;
  const pageUrl = `${origin}/estimate/${code}`;
  const res = await beginEstimateAcceptance(
    {
      tenantId: link.tenantId,
      estimateId: link.estimateId,
      tier: body.tier as "good" | "better" | "best",
      color: body.color,
      successUrl: `${pageUrl}?deposit=ok`,
      cancelUrl: `${pageUrl}?deposit=cancelled`,
      signerEmail: body.email ?? null,
    },
    {
      docuseal: process.env.DOCUSEAL_API_KEY ? httpDocuseal : makeFakeDocuseal(),
      stripe: process.env.STRIPE_SECRET_KEY ? stripeGateway : makeFakeStripe(),
    },
  );

  // RED PATH: expired → renewal prompt for the homeowner + a heads-up to the
  // assigned rep so a refreshed estimate goes out (fail-soft, demo-mute rides
  // getTenantSms).
  if (!res.ok && res.error === "expired") {
    try {
      const rep = await withTenant(link.tenantId, async (tx) => {
        const [est] = await tx.select({ leadId: estimate.leadId }).from(estimate).where(eq(estimate.id, link.estimateId));
        if (!est?.leadId) return null;
        const [l] = await tx.select({ assignedUserId: lead.assignedUserId }).from(lead).where(eq(lead.id, est.leadId));
        if (!l?.assignedUserId) return null;
        const [u] = await tx.select({ phone: user.phone, name: user.name }).from(user).where(eq(user.id, l.assignedUserId));
        return u ?? null;
      });
      if (rep?.phone) {
        const { sender, from } = await getTenantSms(link.tenantId);
        await sender.sendSms({
          to: rep.phone,
          from,
          body: `A homeowner just tried to accept an EXPIRED estimate — refresh it at current pricing: ${pageUrl}`,
        });
      }
    } catch (e) {
      log.error("expired-estimate rep notify failed", { route: "/api/estimate/accept", tenantId: link.tenantId, msg: String(e) });
    }
  }

  return Response.json(res, { status: res.ok ? 200 : 409 });
}
