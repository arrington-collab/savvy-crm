import { NextResponse } from "next/server";
import { stripeGateway, makeFakeStripe } from "@savvy/integrations";
import { recordStripePayment, recordEstimateDeposit } from "@savvy/db";
import { inngest } from "@savvy/agents";
import { log } from "@/lib/log";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text(); // raw body required for signature verification
  const sig = req.headers.get("stripe-signature") ?? "";
  // Mirror the DocuSeal pattern: no Stripe key (dev/e2e) → fake gateway that
  // parses the raw JSON without signature verification. Production always
  // verifies (key + webhook secret are required env there).
  const gw = process.env.STRIPE_SECRET_KEY ? stripeGateway : makeFakeStripe();
  let evt;
  try {
    evt = gw.constructWebhookEvent(raw, sig);
  } catch {
    return new NextResponse("bad signature", { status: 400 });
  }

  const isSuccess = evt.type === "checkout.session.completed" || evt.type === "checkout.session.async_payment_succeeded";
  if (!isSuccess) return NextResponse.json({ received: true });
  log.info("stripe webhook received", { route: "/api/stripe/webhook", event: evt.type });

  const session = evt.data.object as {
    id?: string; payment_intent?: string; amount_total?: number;
    payment_status?: string;
    metadata?: { invoiceId?: string; tenantId?: string; kind?: string; estimateId?: string };
  };

  // Method + settlement gating:
  // - async_payment_succeeded = an ACH/delayed payment that has now SETTLED -> record as ach.
  // - completed = the session finished; record ONLY if payment_status is "paid" (card/instant).
  //   For ACH, `completed` fires with payment_status "processing"/"unpaid" BEFORE funds settle —
  //   we must wait for the later async_payment_succeeded, so we skip here.
  let method: "card" | "ach";
  if (evt.type === "checkout.session.async_payment_succeeded") {
    method = "ach";
  } else {
    if (session.payment_status !== "paid") return NextResponse.json({ received: true });
    method = "card";
  }

  const invoiceId = session.metadata?.invoiceId;
  const tenantId = session.metadata?.tenantId;
  const stripePaymentId = session.payment_intent ?? session.id;
  if (!invoiceId || !tenantId || !stripePaymentId) return NextResponse.json({ received: true });

  // Estimate Experience slice 3: acceptance deposits are estimate-scoped (no
  // invoice exists yet — the job hasn't been created). Settling the deposit
  // completes the sign+pay gate; when both halves are in, fire the UNCHANGED
  // estimate/accepted chain.
  if (session.metadata?.kind === "estimate_deposit" && session.metadata.estimateId) {
    const estimateId = session.metadata.estimateId;
    try {
      const dep = await recordEstimateDeposit({ tenantId, estimateId, stripePaymentId });
      if (!dep.alreadyRecorded && dep.nowReady) {
        try {
          await inngest.send({ name: "estimate/accepted", data: { tenantId, estimateId } });
        } catch (e) {
          log.error("estimate/accepted emit failed", { route: "/api/stripe/webhook", tenantId, msg: String(e) });
        }
      }
    } catch (e) {
      log.error("estimate deposit reconcile failed", { route: "/api/stripe/webhook", tenantId, msg: String(e) });
    }
    return NextResponse.json({ received: true });
  }

  try {
    const r = await recordStripePayment({
      tenantId, invoiceId, stripePaymentId, method, amountCents: session.amount_total ?? 0,
    });
    if (r.nowPaid) {
      try { await inngest.send({ name: "invoice/paid", data: { invoiceId, tenantId } }); } catch (e) { log.error("invoice/paid emit failed", { route: "/api/stripe/webhook", tenantId, msg: String(e) }); }
    }
  } catch (e) {
    // 23505 race -> already recorded; other errors logged but still 200 (avoid infinite Stripe retries on a poison event).
    log.error("stripe reconcile failed", { route: "/api/stripe/webhook", tenantId, msg: String(e) });
  }
  return NextResponse.json({ received: true });
}
