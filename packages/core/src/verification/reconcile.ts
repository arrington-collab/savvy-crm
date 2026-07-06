import { reconciled } from "./builders";
import type { EvidenceCheck, EvidenceCtx } from "./types";

// Cell 8 money-reconciliation checks. Both use the `reconciled` builder, so a
// vendor error/outage surfaces as `stale` (never a manufactured `fail`). The
// external fetcher is INJECTED — @savvy/core cannot import @savvy/db or
// @savvy/integrations (dependency direction), so the real QBO/Stripe loaders are
// wired in packages/agents/src/health-sweep.ts, mirroring comms.deliverability.
// A null external value means "not connected" → skip (nothing to reconcile yet).

// Savvy accounts receivable = every open invoice balance (sent + overdue).
// draft (not billed), paid, and void are excluded.
const SAVVY_AR_SQL = `
  select coalesce(sum(amount_due), 0)::bigint as ar_cents
    from invoice
   where tenant_id = $1 and status in ('sent', 'overdue')`;

// Savvy Stripe ledger = every payment carrying a Stripe id in the window.
const SAVVY_STRIPE_LEDGER_SQL = `
  select coalesce(sum(amount), 0)::bigint as cents
    from payment
   where tenant_id = $1 and stripe_payment_id is not null
     and received_at >= $2 and received_at < $3`;

async function scalarCents(ctx: EvidenceCtx, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await ctx.db.query<{ ar_cents?: string; cents?: string }>(sql, params);
  const raw = rows[0]?.ar_cents ?? rows[0]?.cents ?? "0";
  return Number(raw);
}

/**
 * finance.qb_reconcile — Savvy open AR must equal QuickBooks AR. `fetchQboArCents`
 * returns the QBO AR total in cents, or null when the tenant has no QBO
 * connection (→ skip). A throw (API down) → stale via the reconciled builder.
 */
export function makeQbReconcileCheck(fetchQboArCents: (tenantId: string) => Promise<number | null>): EvidenceCheck {
  return reconciled(
    (ctx) => fetchQboArCents(ctx.tenantId),
    async (qboArCents, ctx) => {
      if (qboArCents == null) return { status: "skip", details: "no QuickBooks connection", refs: [] };
      const savvyAr = await scalarCents(ctx, SAVVY_AR_SQL, [ctx.tenantId]);
      const diff = savvyAr - qboArCents;
      if (diff === 0) return { status: "pass", details: `AR reconciled at ${savvyAr}¢`, refs: [] };
      return {
        status: "fail",
        details: `Savvy AR ${savvyAr}¢ != QuickBooks AR ${qboArCents}¢ (diff ${diff}¢)`,
        refs: [{ type: "reconcile", ref: "qb_reconcile", url: JSON.stringify({ savvyAr, qboArCents, diff }) }],
      };
    },
  );
}

/**
 * finance.stripe_match — Stripe funds collected in the window must equal the
 * payments ledger (payments carrying a Stripe id). `fetchStripeCollectedCents`
 * returns the Stripe-collected total in cents for the window, or null when the
 * tenant has no Stripe connection (→ skip). A throw → stale.
 */
export function makeStripeMatchCheck(
  fetchStripeCollectedCents: (tenantId: string, window: { start: Date; end: Date }) => Promise<number | null>,
): EvidenceCheck {
  return reconciled(
    (ctx) => fetchStripeCollectedCents(ctx.tenantId, ctx.window),
    async (stripeCents, ctx) => {
      if (stripeCents == null) return { status: "skip", details: "no Stripe connection", refs: [] };
      const ledger = await scalarCents(ctx, SAVVY_STRIPE_LEDGER_SQL, [ctx.tenantId, ctx.window.start, ctx.window.end]);
      const diff = ledger - stripeCents;
      if (diff === 0) return { status: "pass", details: `Stripe reconciled at ${ledger}¢`, refs: [] };
      return {
        status: "fail",
        details: `payments ledger ${ledger}¢ != Stripe collected ${stripeCents}¢ (diff ${diff}¢)`,
        refs: [{ type: "reconcile", ref: "stripe_match", url: JSON.stringify({ ledger, stripeCents, diff }) }],
      };
    },
  );
}
