import { NextResponse } from "next/server";
import { stripeGateway } from "@savvy/integrations";
import { recordStripePayment } from "@savvy/db";
import { inngest } from "@savvy/agents";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text(); // raw body required for signature verification
  const sig = req.headers.get("stripe-signature") ?? "";
  let evt;
  try {
    evt = stripeGateway.constructWebhookEvent(raw, sig);
  } catch {
    return new NextResponse("bad signature", { status: 400 });
  }

  const isSuccess = evt.type === "checkout.session.completed" || evt.type === "checkout.session.async_payment_succeeded";
  if (!isSuccess) return NextResponse.json({ received: true });

  const session = evt.data.object as {
    id?: string; payment_intent?: string; amount_total?: number;
    payment_status?: string;
    metadata?: { invoiceId?: string; tenantId?: string };
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

  try {
    const r = await recordStripePayment({
      tenantId, invoiceId, stripePaymentId, method, amountCents: session.amount_total ?? 0,
    });
    if (r.nowPaid) {
      try { await inngest.send({ name: "invoice/paid", data: { invoiceId, tenantId } }); } catch (e) { console.error(e); }
    }
  } catch (e) {
    // 23505 race -> already recorded; other errors logged but still 200 (avoid infinite Stripe retries on a poison event).
    console.error("reconcile failed", e);
  }
  return NextResponse.json({ received: true });
}
