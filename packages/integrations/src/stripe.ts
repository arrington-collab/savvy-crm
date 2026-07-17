import Stripe from "stripe";

export type StripeEventLite = { type: string; account?: string; data: { object: Record<string, unknown> } };

export interface StripeGateway {
  oauthToken(code: string): Promise<{ stripeUserId: string }>;
  createCheckoutSession(o: {
    connectedAccountId: string; amountCents: number; currency?: string;
    invoiceId: string; tenantId: string; description: string;
    successUrl: string; cancelUrl: string; customerEmail?: string;
    metadata?: Record<string, string>;
  }): Promise<{ id: string; url: string; paymentIntentId: string | null }>;
  constructWebhookEvent(rawBody: string, signature: string): StripeEventLite;
  // Cell 8 reconciliation: total funds collected (succeeded charges) in cents on
  // a connected account within [since, until). Read-only.
  collectedCents(o: { connectedAccountId: string; since: Date; until: Date }): Promise<{ cents: number }>;
  // Phase 20: annual tune-up membership — hosted checkout in subscription mode
  // (inline price_data, yearly interval), and cancellation on the connected account.
  createSubscriptionCheckout(o: {
    connectedAccountId: string; annualAmountCents: number; currency?: string;
    tenantId: string; membershipId: string; description: string;
    successUrl: string; cancelUrl: string; customerEmail?: string;
  }): Promise<{ id: string; url: string; subscriptionId: string | null }>;
  cancelSubscription(o: { connectedAccountId: string; subscriptionId: string }): Promise<{ canceled: boolean }>;
}

function client(): Stripe {
  return new Stripe(process.env.STRIPE_SECRET_KEY ?? "", { apiVersion: "2026-05-27.dahlia" });
}

export const stripeGateway: StripeGateway = {
  async oauthToken(code) {
    const res = await client().oauth.token({ grant_type: "authorization_code", code });
    return { stripeUserId: res.stripe_user_id as string };
  },
  async createCheckoutSession(o) {
    const session = await client().checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card", "us_bank_account"],
      line_items: [{
        quantity: 1,
        price_data: { currency: o.currency ?? "usd", unit_amount: o.amountCents, product_data: { name: o.description } },
      }],
      metadata: { invoiceId: o.invoiceId, tenantId: o.tenantId, ...o.metadata },
      payment_intent_data: { metadata: { invoiceId: o.invoiceId, tenantId: o.tenantId, ...o.metadata } },
      success_url: o.successUrl, cancel_url: o.cancelUrl,
      ...(o.customerEmail ? { customer_email: o.customerEmail } : {}),
    }, { stripeAccount: o.connectedAccountId });
    return { id: session.id, url: session.url ?? "", paymentIntentId: (session.payment_intent as string | null) ?? null };
  },
  async createSubscriptionCheckout(o) {
    const session = await client().checkout.sessions.create({
      mode: "subscription",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: o.currency ?? "usd", unit_amount: o.annualAmountCents,
          recurring: { interval: "year" },
          product_data: { name: o.description },
        },
      }],
      metadata: { membershipId: o.membershipId, tenantId: o.tenantId },
      subscription_data: { metadata: { membershipId: o.membershipId, tenantId: o.tenantId } },
      success_url: o.successUrl, cancel_url: o.cancelUrl,
      ...(o.customerEmail ? { customer_email: o.customerEmail } : {}),
    }, { stripeAccount: o.connectedAccountId });
    return { id: session.id, url: session.url ?? "", subscriptionId: (session.subscription as string | null) ?? null };
  },
  async cancelSubscription(o) {
    await client().subscriptions.cancel(o.subscriptionId, {}, { stripeAccount: o.connectedAccountId });
    return { canceled: true };
  },
  constructWebhookEvent(rawBody, signature) {
    const evt = client().webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET ?? "");
    return { type: evt.type, account: (evt as { account?: string }).account, data: { object: evt.data.object as unknown as Record<string, unknown> } };
  },
  async collectedCents({ connectedAccountId, since, until }) {
    // Sum succeeded charges in the window (auto-paginating), scoped to the
    // connected account. amount is already in cents.
    let cents = 0;
    const params: Stripe.ChargeListParams = {
      created: { gte: Math.floor(since.getTime() / 1000), lt: Math.floor(until.getTime() / 1000) },
      limit: 100,
    };
    for await (const charge of client().charges.list(params, { stripeAccount: connectedAccountId })) {
      if (charge.paid && charge.status === "succeeded") cents += charge.amount;
    }
    return { cents };
  },
};

export function makeFakeStripe(): StripeGateway & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  let n = 0;
  return {
    calls,
    async oauthToken(code) { calls.push({ op: "oauth", code }); return { stripeUserId: `acct_fake_${++n}` }; },
    async createCheckoutSession(o) {
      calls.push({ op: "checkout", ...o });
      const id = `cs_fake_${++n}`;
      return { id, url: `https://checkout.stripe.test/${id}`, paymentIntentId: `pi_fake_${n}` };
    },
    constructWebhookEvent(rawBody) {
      calls.push({ op: "webhook" });
      return JSON.parse(rawBody) as StripeEventLite;
    },
    async collectedCents(o) {
      calls.push({ op: "collected", ...o });
      return { cents: 0 };
    },
    async createSubscriptionCheckout(o) {
      calls.push({ op: "subscription_checkout", ...o });
      const id = `cs_sub_fake_${++n}`;
      return { id, url: `https://checkout.stripe.test/${id}`, subscriptionId: null };
    },
    async cancelSubscription(o) {
      calls.push({ op: "cancel_subscription", ...o });
      return { canceled: true };
    },
  };
}
