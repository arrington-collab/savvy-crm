import type { ValuationConfig } from "./valuation-config";

// Owner's Room slice 1 — the valuation engine. Honesty rules (non-negotiable,
// from the spec): a RANGE, never a point; every adjustment NAMED with its
// rationale; "insufficient data" until inputs are real; missing inputs widen
// the range and get flagged — never silent precision. This is a planning
// estimate from operating data, not an appraisal.

export type InputQuality = "real" | "estimated" | "missing";
export type QualifiedInput = { value: number | null; quality: InputQuality };

export interface ValuationInputs {
  /** Months of job history backing the TTM figures. */
  ttmMonths: number;
  ttmRevenueCents: QualifiedInput;
  ttmGrossMarginPct: QualifiedInput;
  insuranceMixPct: QualifiedInput;
  maintenanceMrrCents: QualifiedInput; // Phase 20 unbuilt ⇒ arrives 'missing'
  topCustomerPct: QualifiedInput;
  topLeadSourcePct: QualifiedInput;
  coveragePct: QualifiedInput;
  founderMinutes30d: QualifiedInput;
  backlogCents: QualifiedInput;
  arOver60Pct: QualifiedInput;
  qboReconciled: boolean;
}

export interface ValuationAdjustment {
  key: string;
  deltaLow: number;
  deltaHigh: number;
  rationale: string;
}

export interface ValuationSnapshotResult {
  status: "ok" | "insufficient_data";
  reasons?: string[];
  sdeCents: number | null;
  bandKey: string | null;
  baseMultipleLow: number;
  baseMultipleHigh: number;
  adjustments: ValuationAdjustment[];
  multipleLow: number;
  multipleHigh: number;
  valueLowCents: number | null;
  valueLikelyCents: number | null;
  valueHighCents: number | null;
  inputQuality: { real: number; estimated: number; missing: number; flags: Record<string, InputQuality> };
  methodologyVersion: string;
}

const INSUFFICIENT: Omit<ValuationSnapshotResult, "reasons" | "inputQuality" | "methodologyVersion"> = {
  status: "insufficient_data",
  sdeCents: null, bandKey: null,
  baseMultipleLow: 0, baseMultipleHigh: 0, adjustments: [],
  multipleLow: 0, multipleHigh: 0,
  valueLowCents: null, valueLikelyCents: null, valueHighCents: null,
};

export function computeValuationSnapshot(inputs: ValuationInputs, config: ValuationConfig): ValuationSnapshotResult {
  const flags: Record<string, InputQuality> = {
    ttmRevenueCents: inputs.ttmRevenueCents.quality,
    ttmGrossMarginPct: inputs.ttmGrossMarginPct.quality,
    insuranceMixPct: inputs.insuranceMixPct.quality,
    maintenanceMrrCents: inputs.maintenanceMrrCents.quality,
    topCustomerPct: inputs.topCustomerPct.quality,
    topLeadSourcePct: inputs.topLeadSourcePct.quality,
    coveragePct: inputs.coveragePct.quality,
    founderMinutes30d: inputs.founderMinutes30d.quality,
    backlogCents: inputs.backlogCents.quality,
    arOver60Pct: inputs.arOver60Pct.quality,
    // The operating-cost side of the proxy stays an estimate until QBO P&L
    // actuals replace the config percentage — reconciled books don't change that.
    ebitdaProxy: "estimated",
  };
  const quality = {
    real: Object.values(flags).filter((q) => q === "real").length,
    estimated: Object.values(flags).filter((q) => q === "estimated").length,
    missing: Object.values(flags).filter((q) => q === "missing").length,
    flags,
  };

  // ── Honesty gate: no range from placeholder or thin data ──
  const reasons: string[] = [];
  if (inputs.ttmRevenueCents.value == null || inputs.ttmRevenueCents.quality === "missing")
    reasons.push("TTM revenue unavailable — job-costing actuals not live");
  if (inputs.ttmGrossMarginPct.value == null || inputs.ttmGrossMarginPct.quality === "missing")
    reasons.push("gross margin unavailable — job costs not recorded");
  if (inputs.ttmMonths < config.minTtmMonths)
    reasons.push(`only ${inputs.ttmMonths} months of history — needs ${config.minTtmMonths} months minimum`);
  if (reasons.length > 0) {
    return { ...INSUFFICIENT, reasons, inputQuality: quality, methodologyVersion: config.version };
  }

  const revenue = inputs.ttmRevenueCents.value!;
  const gmPct = inputs.ttmGrossMarginPct.value!;
  const sdeCents = Math.max(0, Math.round((revenue * (gmPct - config.operatingCostPctEstimate)) / 100));

  // ── Base multiple band by revenue ──
  const band = config.bands.find((b) => b.maxRevenueCents == null || revenue < b.maxRevenueCents) ?? config.bands[config.bands.length - 1]!;
  const bandKey = band.maxRevenueCents == null ? "top" : `under_${band.maxRevenueCents}`;

  // ── The named-adjustment ledger — every +/− carries its why ──
  const adjustments: ValuationAdjustment[] = [];
  const add = (key: string, [deltaLow, deltaHigh]: readonly [number, number], rationale: string) =>
    adjustments.push({ key, deltaLow, deltaHigh, rationale });

  const mrr = inputs.maintenanceMrrCents;
  if (mrr.quality !== "missing" && (mrr.value ?? 0) >= config.mrrTargetCents) {
    add("maintenance_mrr", config.mrrDelta,
      `recurring maintenance revenue ≥ $${config.mrrTargetCents / 100}/mo — buyers pay for predictability`);
  }
  const cov = inputs.coveragePct, fm = inputs.founderMinutes30d;
  if (cov.quality !== "missing" && fm.quality !== "missing"
    && (cov.value ?? 0) >= config.coverageMinPct && (fm.value ?? Infinity) <= config.founderMinutesMax30d) {
    add("owner_independence", config.ownerIndependenceDelta,
      `coverage ${cov.value}% with ${fm.value} founder-min/30d — the business runs without the owner (documented-process premium)`);
  }
  const topCust = inputs.topCustomerPct;
  if (topCust.quality !== "missing" && (topCust.value ?? 0) > config.topCustomerMaxPct) {
    add("customer_concentration", config.concentrationDelta,
      `top customer is ${topCust.value}% of revenue (> ${config.topCustomerMaxPct}%) — key-account risk`);
  }
  const ins = inputs.insuranceMixPct;
  if (ins.quality !== "missing" && (ins.value ?? 0) > config.insuranceMixMaxPct) {
    add("insurance_dependence", config.insuranceDelta,
      `insurance work is ${ins.value}% of mix (> ${config.insuranceMixMaxPct}%) — storm-dependence discount`);
  }
  if (inputs.qboReconciled) {
    add("clean_books", config.cleanBooksDelta, "QBO-reconciled books — diligence-ready financials");
  }
  const ar = inputs.arOver60Pct;
  if (ar.quality !== "missing" && (ar.value ?? 0) > config.arOver60MaxPct) {
    add("ar_aging", config.arDelta, `${ar.value}% of AR is >60 days (> ${config.arOver60MaxPct}%) — collections drag`);
  }

  // Missing non-critical inputs widen the range — as a LEDGER ENTRY, so the
  // final multiple is always base + the visible sum (nothing hidden).
  const missingKeys = Object.entries(flags)
    .filter(([k, q]) => q === "missing" && k !== "ebitdaProxy")
    .map(([k]) => k);
  if (missingKeys.length > 0) {
    const w = config.widenPerMissing * missingKeys.length;
    add("data_gaps", [-w, w] as const,
      `${missingKeys.length} input(s) unavailable (${missingKeys.join(", ")}) — range widened, not guessed`);
  }

  const multipleLow = band.low + adjustments.reduce((s, a) => s + a.deltaLow, 0);
  const multipleHigh = band.high + adjustments.reduce((s, a) => s + a.deltaHigh, 0);
  const multipleLikely = (multipleLow + multipleHigh) / 2;

  return {
    status: "ok",
    sdeCents,
    bandKey,
    baseMultipleLow: band.low,
    baseMultipleHigh: band.high,
    adjustments,
    multipleLow,
    multipleHigh,
    valueLowCents: Math.round(sdeCents * multipleLow),
    valueLikelyCents: Math.round(sdeCents * multipleLikely),
    valueHighCents: Math.round(sdeCents * multipleHigh),
    inputQuality: quality,
    methodologyVersion: config.version,
  };
}
