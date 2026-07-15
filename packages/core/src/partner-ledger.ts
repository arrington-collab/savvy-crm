import { z } from "zod";

// Partner Ledger slice 2 — cost accrual (spec: docs/superpowers/specs/
// prompts-partner-ledger.md). Costs are counted HONESTLY: standard costs for
// inspections (documented methodology below) plus trackable actuals (fees,
// free repairs, expenses). cert_cost is reserved for slice 4's paid-cert lane.

export const PARTNER_LEDGER_KINDS = ["inspection_standard", "free_repair", "referral_fee", "cert_cost", "expense"] as const;
export type PartnerLedgerKind = (typeof PARTNER_LEDGER_KINDS)[number];

export const PARTNER_LEDGER_DIRECTIONS = ["cost", "revenue"] as const;

/** Tooltip copy — the same honesty pattern as founder-minutes. */
export const INSPECTION_STANDARD_METHODOLOGY =
  "Standard cost per inspection: 2–3 loaded hours (drive + roof time + write-up) at a loaded field rate. Tenant-configurable; default $200.";

const partnerLedgerConfigSchema = z.object({
  inspectionStandardCostCents: z.number().int().min(0).catch(20000).default(20000),
});
export type PartnerLedgerConfig = z.infer<typeof partnerLedgerConfigSchema>;

export function parsePartnerLedgerConfig(raw: unknown): PartnerLedgerConfig {
  const r = partnerLedgerConfigSchema.safeParse(raw ?? {});
  return r.success ? r.data : { inspectionStandardCostCents: 20000 };
}

/** Owner-digest line for the trailing-week partner expense sum; silent at zero. */
export function buildPartnerExpenseLine(sumCents: number): string | null {
  if (sumCents <= 0) return null;
  const usd = (sumCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  return `Partner expenses this week: ${usd}`;
}
