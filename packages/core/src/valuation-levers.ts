import type { ValuationConfig } from "./valuation-config";
import type { ValuationSnapshotResult } from "./valuation";

// Owner's Room slice 2 — value levers. The actionable half of the room:
// levers derive from the snapshot's OWN adjustment ledger (a penalty present
// = money in removing it; a premium absent = money in earning it), never
// from generic advice. Impact = the adjustment's multiple delta × this
// company's SDE, shown as a range with the same honesty as the valuation.

export interface ValueLever {
  key: string;
  label: string;
  why: string;
  impactLowCents: number;
  impactHighCents: number;
  href: string;
}

export function buildValueLevers(snap: ValuationSnapshotResult, config: ValuationConfig): ValueLever[] {
  if (snap.status !== "ok" || !snap.sdeCents || snap.sdeCents <= 0) return [];
  const sde = snap.sdeCents;
  const has = (key: string) => snap.adjustments.some((a) => a.key === key);
  const get = (key: string) => snap.adjustments.find((a) => a.key === key);
  const dollars = ([lo, hi]: readonly [number, number]) =>
    ({ impactLowCents: Math.round(sde * Math.min(Math.abs(lo), Math.abs(hi))), impactHighCents: Math.round(sde * Math.max(Math.abs(lo), Math.abs(hi))) });

  const levers: ValueLever[] = [];

  if (!has("owner_independence")) {
    levers.push({
      key: "owner_independence", label: "Earn the owner-independence premium",
      why: `Coverage ≥ ${config.coverageMinPct}% with founder-minutes under ${config.founderMinutesMax30d}/30d prices the business as running without you.`,
      ...dollars(config.ownerIndependenceDelta), href: "/tasks",
    });
  }
  const conc = get("customer_concentration");
  if (conc) {
    levers.push({
      key: "customer_concentration", label: `Cut top-customer share below ${config.topCustomerMaxPct}%`,
      why: conc.rationale, ...dollars(config.concentrationDelta), href: "/leads",
    });
  }
  const ins = get("insurance_dependence");
  if (ins) {
    levers.push({
      key: "insurance_dependence", label: `Grow retail mix (insurance below ${config.insuranceMixMaxPct}%)`,
      why: ins.rationale, ...dollars(config.insuranceDelta), href: "/leads",
    });
  }
  if (!has("maintenance_mrr")) {
    levers.push({
      key: "maintenance_mrr", label: `Stand up maintenance MRR ≥ $${Math.round(config.mrrTargetCents / 100)}/mo`,
      why: "Recurring revenue is the single most transferable dollar a buyer can see (maintenance program — Phase 20).",
      ...dollars(config.mrrDelta), href: "/library",
    });
  }
  if (!has("clean_books")) {
    levers.push({
      key: "clean_books", label: "Connect + reconcile QuickBooks",
      why: "Diligence-ready books remove the discount every buyer applies to unverifiable financials.",
      ...dollars(config.cleanBooksDelta), href: "/settings/quickbooks",
    });
  }
  const gaps = get("data_gaps");
  if (gaps) {
    levers.push({
      key: "data_gaps", label: "Close the data gaps",
      why: gaps.rationale, ...dollars([gaps.deltaLow, gaps.deltaHigh] as const), href: "/money/owners-room#methodology",
    });
  }
  const ar = get("ar_aging");
  if (ar) {
    levers.push({
      key: "ar_aging", label: `Collect aged AR below ${config.arOver60MaxPct}%`,
      why: ar.rationale, ...dollars(config.arDelta), href: "/invoices",
    });
  }

  return levers.sort((a, b) => b.impactHighCents - a.impactHighCents).slice(0, 5);
}
