import { and, eq, lt, sql } from "drizzle-orm";
import { withTenant } from "../tenant";
import { tenant, estimate, repairCredit, inspectionFinding, inspectionChecklist, lead } from "../schema/index";
import { parseEstimateConfig, computeEstimateTotals } from "@savvy/core";

/**
 * Roof Record slice 2 — the generosity machinery.
 * Friend rule: "anything I'd do for a friend or neighbor is free" — eligible
 * small findings are fixed free on the spot. Paid repairs mint a 36-month
 * replacement credit that AUTO-APPLIES to future replacement estimates as a
 * visible credit line, with a service-framed check-in cadence if no
 * replacement happens (12mo, 24mo, ~33mo before expiry).
 */

const CREDIT_MONTHS = 36;
const CREDIT_LINE_KEY = "repair-credit";
const DEFAULT_FRIEND_RULE_MAX_CENTS = 15_000; // $150 — tenant-configurable

type ChecklistItemRow = { key: string; friend_rule_eligible?: boolean };

function friendRuleMaxCents(settings: unknown): number {
  const cfg = (settings as { roofRecord?: { friendRule?: { maxCents?: number } } } | null)?.roofRecord?.friendRule;
  return typeof cfg?.maxCents === "number" && cfg.maxCents >= 0 ? cfg.maxCents : DEFAULT_FRIEND_RULE_MAX_CENTS;
}

export type FriendRuleResult =
  | { applied: true; disposition: "fixed_free_today" }
  | { applied: false; reason: "finding_not_found" | "not_eligible" | "no_estimate" | "over_threshold" };

export async function applyFriendRule(input: {
  tenantId: string;
  findingId: string;
}): Promise<FriendRuleResult> {
  return withTenant(input.tenantId, async (tx) => {
    const [f] = await tx.select({
      id: inspectionFinding.id,
      checklistItemKey: inspectionFinding.checklistItemKey,
      repairEstimateCents: inspectionFinding.repairEstimateCents,
    }).from(inspectionFinding).where(eq(inspectionFinding.id, input.findingId));
    if (!f) return { applied: false as const, reason: "finding_not_found" as const };

    const checklists = await tx.select({ items: inspectionChecklist.items }).from(inspectionChecklist)
      .where(eq(inspectionChecklist.active, true));
    const item = checklists.flatMap((c) => c.items as ChecklistItemRow[]).find((i) => i.key === f.checklistItemKey);
    if (!item?.friend_rule_eligible) return { applied: false as const, reason: "not_eligible" as const };
    if (f.repairEstimateCents == null) return { applied: false as const, reason: "no_estimate" as const };

    const [t] = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, input.tenantId));
    if (f.repairEstimateCents > friendRuleMaxCents(t?.settings)) return { applied: false as const, reason: "over_threshold" as const };

    await tx.update(inspectionFinding).set({ disposition: "fixed_free_today" })
      .where(eq(inspectionFinding.id, input.findingId));
    return { applied: true as const, disposition: "fixed_free_today" as const };
  });
}

export type IssueCreditResult =
  | { creditId: string; expiresAt: Date }
  | { skipped: "already_issued"; creditId: string };

/** Once per source invoice — a replayed webhook or double-click never double-mints. */
export async function issueRepairCredit(input: {
  tenantId: string;
  customerId: string;
  sourceInspectionId?: string | null;
  sourceInvoiceRef: string;
  amountCents: number;
}): Promise<IssueCreditResult> {
  return withTenant(input.tenantId, async (tx) => {
    const [existing] = await tx.select({ id: repairCredit.id }).from(repairCredit)
      .where(and(eq(repairCredit.customerId, input.customerId), eq(repairCredit.sourceInvoiceRef, input.sourceInvoiceRef)));
    if (existing) return { skipped: "already_issued" as const, creditId: existing.id };

    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime());
    expiresAt.setUTCMonth(expiresAt.getUTCMonth() + CREDIT_MONTHS);
    const [row] = await tx.insert(repairCredit).values({
      tenantId: input.tenantId,
      customerId: input.customerId,
      sourceInspectionId: input.sourceInspectionId ?? null,
      sourceInvoiceRef: input.sourceInvoiceRef,
      amountCents: input.amountCents,
      issuedAt,
      expiresAt,
    }).returning({ id: repairCredit.id });
    return { creditId: row!.id, expiresAt };
  });
}

export type ApplyCreditResult =
  | { applied: true; creditId: string; amountCents: number }
  | { skipped: "estimate_not_found" | "estimate_locked" | "no_customer" | "no_active_credit" | "already_applied" };

/**
 * The visible credit line: an active, unexpired credit for the estimate's
 * customer lands on the draft as a negative line item and totals recompute.
 * Idempotent — the line key guards re-application (re-prices strip regenerated
 * lines, so callers re-apply after every refresh).
 */
export async function applyRepairCreditToEstimate(input: {
  tenantId: string;
  estimateId: string;
}): Promise<ApplyCreditResult> {
  return withTenant(input.tenantId, async (tx) => {
    const [e] = await tx.select({
      id: estimate.id, status: estimate.status, leadId: estimate.leadId, lineItems: estimate.lineItems,
    }).from(estimate).where(eq(estimate.id, input.estimateId));
    if (!e) return { skipped: "estimate_not_found" as const };
    if (e.status !== "draft" && e.status !== "sent") return { skipped: "estimate_locked" as const };

    const lines = (e.lineItems ?? []) as ({ key?: string; amountCents: number } & Record<string, unknown>)[];
    if (lines.some((l) => l.key === CREDIT_LINE_KEY)) return { skipped: "already_applied" as const };

    const customerId = e.leadId
      ? (await tx.select({ customerId: lead.customerId }).from(lead).where(eq(lead.id, e.leadId)))[0]?.customerId
      : null;
    if (!customerId) return { skipped: "no_customer" as const };

    const now = new Date();
    const [credit] = await tx.select().from(repairCredit)
      .where(and(eq(repairCredit.customerId, customerId), eq(repairCredit.status, "active")))
      .orderBy(sql`${repairCredit.issuedAt} desc`)
      .limit(1);
    if (!credit || credit.expiresAt <= now) return { skipped: "no_active_credit" as const };

    const [t] = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, input.tenantId));
    const cfg = parseEstimateConfig((t?.settings as { estimate?: unknown })?.estimate);

    const creditLine = {
      key: CREDIT_LINE_KEY,
      name: "Repair credit — applied toward your replacement",
      qty: 1,
      unit: "ea",
      unitPriceCents: -credit.amountCents,
      amountCents: -credit.amountCents,
    };
    const nextLines = [...lines, creditLine];
    const totals = computeEstimateTotals(nextLines, cfg.taxRateBps);
    await tx.update(estimate).set({
      lineItems: nextLines,
      subtotal: totals.subtotalCents,
      tax: totals.taxCents,
      total: totals.totalCents,
    }).where(eq(estimate.id, input.estimateId));

    await tx.update(repairCredit)
      .set({ status: "applied", appliedEstimateId: input.estimateId })
      .where(eq(repairCredit.id, credit.id));
    return { applied: true as const, creditId: credit.id, amountCents: credit.amountCents };
  });
}

const CHECKIN_KINDS = [
  { kind: "12mo" as const, afterDays: 365 },
  { kind: "24mo" as const, afterDays: 730 },
  // ~33 months: the before-it-expires note with the re-inspection offer.
  { kind: "33mo" as const, afterDays: 1004 },
];

export type CreditCheckinDue = { creditId: string; customerId: string; kind: "12mo" | "24mo" | "33mo"; amountCents: number };

/** Service-framed cadence while a credit sits unapplied: each kind comes due
 *  once, skipped forever after it's logged (or the credit resolves). */
export async function creditCheckinsDue(tenantId: string, now: Date): Promise<CreditCheckinDue[]> {
  return withTenant(tenantId, async (tx) => {
    const credits = await tx.select().from(repairCredit)
      .where(and(eq(repairCredit.status, "active"), lt(repairCredit.issuedAt, now)));
    const due: CreditCheckinDue[] = [];
    for (const c of credits) {
      if (c.expiresAt <= now) continue;
      const ageDays = (now.getTime() - c.issuedAt.getTime()) / 86_400_000;
      const logged = new Set((c.checkinLog as { kind?: string }[]).map((l) => l.kind));
      const next = CHECKIN_KINDS.filter((k) => ageDays >= k.afterDays && !logged.has(k.kind)).pop();
      if (next) due.push({ creditId: c.id, customerId: c.customerId, kind: next.kind, amountCents: c.amountCents });
    }
    return due;
  });
}

export async function recordCreditCheckin(input: {
  tenantId: string;
  creditId: string;
  kind: "12mo" | "24mo" | "33mo";
  commId?: string | null;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) => tx.update(repairCredit).set({
    checkinLog: sql`${repairCredit.checkinLog} || ${JSON.stringify([{ kind: input.kind, at: new Date().toISOString(), commId: input.commId ?? null }])}::jsonb`,
  }).where(eq(repairCredit.id, input.creditId)));
}

/** Expiry sweep: active + past expiry → expired. Applied/opted-out untouched. */
export async function expireLapsedCredits(tenantId: string, now: Date): Promise<{ expired: number }> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.update(repairCredit).set({ status: "expired" })
      .where(and(eq(repairCredit.status, "active"), lt(repairCredit.expiresAt, now)))
      .returning({ id: repairCredit.id });
    return { expired: rows.length };
  });
}
