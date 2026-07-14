// Estimate Experience slice 3: the accept flow's DB truth. Accept(tier, color)
// mints the sign + deposit artifacts idempotently; the acceptance gate
// (signed AND deposited-when-required) decides when the EXISTING
// estimate/accepted chain may fire — this module never forks that chain.

import { eq } from "drizzle-orm";
import { withTenant } from "../tenant";
import { adminDb } from "../admin-client";
import { estimate } from "../schema/finance";
import { tenant } from "../schema/tenancy";
import {
  parseEstimateConfig,
  parseFinanceConfig,
  depositRequirement,
  acceptanceReady,
  type TierEstimate,
} from "@savvy/core";
import { setEstimateSelection } from "./estimate-page";
import { job } from "../schema/jobs";
import { auditLog } from "../schema/agents";

// Structural gateway types — accept the real integrations or test fakes.
type DocusealLike = {
  createSubmission: (o: { estimateId: string; signerEmail: string; total: number }) => Promise<{ submissionId: string; signUrl: string }>;
};
type StripeLike = {
  createCheckoutSession: (o: {
    connectedAccountId: string;
    amountCents: number;
    invoiceId: string;
    tenantId: string;
    description: string;
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
  }) => Promise<{ id: string; url: string; paymentIntentId: string | null }>;
};

export type BeginAcceptanceResult =
  | {
      ok: true;
      signingUrl: string;
      deposit: { required: boolean; amountCents: number; checkoutUrl: string | null };
    }
  | { ok: false; error: "expired" | "not_found" | "invalid_selection" | "already_accepted" };

export async function beginEstimateAcceptance(
  input: {
    tenantId: string;
    estimateId: string;
    tier?: "good" | "better" | "best" | null;
    color?: string | null;
    successUrl: string;
    cancelUrl: string;
    signerEmail?: string | null;
  },
  gateways: { docuseal: DocusealLike; stripe: StripeLike },
): Promise<BeginAcceptanceResult> {
  const [t] = await adminDb
    .select({ settings: tenant.settings, stripeAccountId: tenant.stripeAccountId })
    .from(tenant)
    .where(eq(tenant.id, input.tenantId));
  const estimateCfg = parseEstimateConfig((t?.settings as { estimate?: unknown })?.estimate);
  const financeCfg = parseFinanceConfig((t?.settings as { finance?: unknown })?.finance);

  const [est] = await withTenant(input.tenantId, (tx) =>
    tx.select().from(estimate).where(eq(estimate.id, input.estimateId)),
  );
  if (!est) return { ok: false, error: "not_found" };
  if (est.status === "accepted") return { ok: false, error: "already_accepted" };

  // RED PATH: no acceptance at stale prices — 30d (config) from send.
  const anchor = est.sentAt ?? est.createdAt;
  if (Date.now() > anchor.getTime() + estimateCfg.validityDays * 86_400_000) {
    return { ok: false, error: "expired" };
  }

  // Slice 7: the insurance variant has no tiers/colors — the carrier already
  // priced the roof. Selection is retail-only; deposits follow the tenant's
  // insurance config (default none — the deductible rides its own rails).
  const insurance = est.templateVersion === "insurance-v1" || est.source === "carrier";
  if (!insurance) {
    if (!input.tier || !input.color) return { ok: false, error: "invalid_selection" };
    // Persist the pick (validates tier ∈ snapshot, color ∈ palette).
    const sel = await setEstimateSelection({
      tenantId: input.tenantId,
      estimateId: input.estimateId,
      tier: input.tier,
      color: input.color,
    });
    if (!sel.ok) return { ok: false, error: "invalid_selection" };
  }

  // The accepted-tier total prices the deposit — not the single-price total.
  const tiers = (est.tiers ?? []) as unknown as TierEstimate[];
  const tierTotal = insurance
    ? est.total ?? 0
    : tiers.find((x) => x.tier === input.tier)?.subtotalCents ?? est.total ?? 0;
  const deposit = depositRequirement({
    totalCents: tierTotal,
    depositPercentageBps: insurance ? financeCfg.insuranceDepositPercentageBps : financeCfg.depositPercentageBps,
    stripeConnected: t?.stripeAccountId != null,
  });

  // Idempotent artifact minting: reuse what a prior accept already created.
  let signingUrl = est.signingUrl;
  let submissionId = est.docusealSubmissionId;
  if (!signingUrl || !submissionId) {
    const sub = await gateways.docuseal.createSubmission({
      estimateId: input.estimateId,
      signerEmail: input.signerEmail ?? "homeowner@unknown.invalid",
      total: tierTotal,
    });
    submissionId = sub.submissionId;
    signingUrl = sub.signUrl;
  }

  let checkoutSessionId = est.depositCheckoutSessionId;
  let checkoutUrl: string | null = est.depositCheckoutUrl;
  if (deposit.required && !checkoutSessionId) {
    const session = await gateways.stripe.createCheckoutSession({
      connectedAccountId: t!.stripeAccountId!,
      amountCents: deposit.amountCents,
      invoiceId: `estimate-deposit:${input.estimateId}`,
      tenantId: input.tenantId,
      description: "Roof project deposit",
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      metadata: { kind: "estimate_deposit", estimateId: input.estimateId },
    });
    checkoutSessionId = session.id;
    checkoutUrl = session.url;
  }

  await withTenant(input.tenantId, (tx) =>
    tx
      .update(estimate)
      .set({
        docusealSubmissionId: submissionId,
        signingUrl,
        depositCheckoutSessionId: checkoutSessionId,
        depositAmountCents: deposit.required ? deposit.amountCents : 0,
        depositCheckoutUrl: checkoutUrl,
      })
      .where(eq(estimate.id, input.estimateId)),
  );

  return { ok: true, signingUrl: signingUrl!, deposit: { ...deposit, checkoutUrl } };
}

/** Stamp the DocuSeal completion. Returns the gate state so the caller (the
 *  webhook) can decide whether to emit estimate/accepted. */
export async function recordEstimateSigned(
  tenantId: string,
  estimateId: string,
): Promise<{ nowReady: boolean }> {
  await withTenant(tenantId, (tx) =>
    tx.update(estimate).set({ signedAt: new Date() }).where(eq(estimate.id, estimateId)),
  );
  const state = await estimateAcceptanceState(tenantId, estimateId);
  return { nowReady: state.ready };
}

/** Stamp the deposit payment (idempotent on the Stripe payment id living in
 *  depositCheckoutSessionId's paid marker). */
export async function recordEstimateDeposit(input: {
  tenantId: string;
  estimateId: string;
  stripePaymentId: string;
}): Promise<{ alreadyRecorded: boolean; nowReady: boolean }> {
  const [est] = await withTenant(input.tenantId, (tx) =>
    tx.select().from(estimate).where(eq(estimate.id, input.estimateId)),
  );
  if (!est) return { alreadyRecorded: false, nowReady: false };
  if (est.depositPaidAt) {
    const state = await estimateAcceptanceState(input.tenantId, input.estimateId);
    return { alreadyRecorded: true, nowReady: state.ready };
  }
  await withTenant(input.tenantId, (tx) =>
    tx.update(estimate).set({ depositPaidAt: new Date() }).where(eq(estimate.id, input.estimateId)),
  );
  const state = await estimateAcceptanceState(input.tenantId, input.estimateId);
  return { alreadyRecorded: false, nowReady: state.ready };
}

export async function estimateAcceptanceState(
  tenantId: string,
  estimateId: string,
): Promise<{
  signed: boolean;
  depositRequired: boolean;
  depositPaid: boolean;
  depositAmountCents: number;
  ready: boolean;
  accepted: boolean;
  jobId: string | null;
  signingUrl: string | null;
  depositCheckoutUrl: string | null;
}> {
  const [est] = await withTenant(tenantId, (tx) =>
    tx.select().from(estimate).where(eq(estimate.id, estimateId)),
  );
  if (!est) {
    return { signed: false, depositRequired: false, depositPaid: false, depositAmountCents: 0, ready: false, accepted: false, jobId: null, signingUrl: null, depositCheckoutUrl: null };
  }
  const depositRequired = (est.depositAmountCents ?? 0) > 0;
  return {
    signed: est.signedAt != null,
    depositRequired,
    depositPaid: est.depositPaidAt != null,
    depositAmountCents: est.depositAmountCents ?? 0,
    ready: acceptanceReady({ signedAt: est.signedAt, depositPaidAt: est.depositPaidAt, depositRequired }),
    accepted: est.status === "accepted",
    jobId: est.jobId,
    signingUrl: est.signingUrl,
    depositCheckoutUrl: est.depositCheckoutUrl,
  };
}

/** The install-week choices offered after acceptance: the next `count` Mondays
 *  starting at least `leadDays` out (crew mobilization isn't instant). */
export function installWeekOptions(now: Date, opts?: { count?: number; leadDays?: number }): Date[] {
  const count = opts?.count ?? 6;
  const leadDays = opts?.leadDays ?? 7;
  const earliest = new Date(now.getTime() + leadDays * 86_400_000);
  const monday = new Date(Date.UTC(earliest.getUTCFullYear(), earliest.getUTCMonth(), earliest.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7)); // 0 when already Monday
  return Array.from({ length: count }, (_, i) => new Date(monday.getTime() + i * 7 * 86_400_000));
}

/** The homeowner's install-week pick. A SOFT production hold: stored on the
 *  job (never an appointment, so it can't satisfy the production stage's
 *  crew-scheduled evidence) + audit-logged for the office to confirm. */
export async function setRequestedInstallWeek(input: {
  tenantId: string;
  estimateId: string;
  weekStart: Date;
}): Promise<{ ok: true; jobId: string } | { ok: false; error: "not_accepted" | "invalid_week" }> {
  const state = await estimateAcceptanceState(input.tenantId, input.estimateId);
  if (!state.accepted || !state.jobId) return { ok: false, error: "not_accepted" };

  const valid = installWeekOptions(new Date()).some(
    (w) => w.toISOString().slice(0, 10) === input.weekStart.toISOString().slice(0, 10),
  );
  if (!valid) return { ok: false, error: "invalid_week" };

  await withTenant(input.tenantId, async (tx) => {
    await tx.update(job).set({ requestedInstallWeek: input.weekStart }).where(eq(job.id, state.jobId!));
    await tx.insert(auditLog).values({
      tenantId: input.tenantId,
      agent: "scheduling",
      entityType: "job",
      entityId: state.jobId!,
      action: "install_week_requested",
      diff: { weekStart: input.weekStart.toISOString().slice(0, 10), source: "estimate_page" },
    });
  });
  return { ok: true, jobId: state.jobId };
}
