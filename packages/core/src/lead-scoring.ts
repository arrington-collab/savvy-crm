import { z } from "./schemas";
import type { LeadFeatures, StormFeature } from "./lead-features";

export type ScoreBand = "hot" | "warm" | "cool" | "cold";
export type ScoreFactor = { label: string; points: number };
export type ScoredLead = {
  score: number;
  band: ScoreBand;
  reasons: string[];
  components: { storm: number; roof: number; source: number }; // 0..1 each, pre-weight
  disqualified: boolean;
};

const DEFAULTS = {
  weights: { storm: 47, roof: 33, source: 20 },
  bands: { hot: 80, warm: 60, cool: 40 },
  roofAgeMinYears: 10,
  roofAgeMaxYears: 22,
  tileBump: 0.1,
  // Source intent (slice 3 taxonomy + machine sources). Ordering per spec:
  // referral > insurance_agent/realtor > web > ads baseline. Legacy keys kept so
  // pre-migration rows / older tests still resolve.
  sourceQuality: {
    // slice-3 structured sources
    referral: 1.0, insurance_agent: 0.8, realtor: 0.8, partner: 0.75, ads: 0.35,
    // machine sources
    web: 0.45, inbound_call: 0.6, canvass: 0.7, direct_mail: 0.5, mobilization: 0.65,
    // legacy (pre-taxonomy) values
    repeat: 0.95, carrier: 0.8, storm_canvass: 0.7, google: 0.5,
    website: 0.45, door_knock: 0.45, facebook: 0.4, yard_sign: 0.35,
    manual: 0.3, other: 0.25,
  } as Record<string, number>,
  sourceDefault: 0.4,
  serviceAreaStates: null as string[] | null,
  renterMultiplier: 0.5, // dormant until occupancy data exists
  multiEventBumpPct: 0.1,
  stormLaneThreshold: 0.3,
};

export type ScoringConfig = typeof DEFAULTS;

const schema = z.object({
  weights: z.object({ storm: z.number(), roof: z.number(), source: z.number() }).partial().optional(),
  bands: z.object({ hot: z.number(), warm: z.number(), cool: z.number() }).partial().optional(),
  roofAgeMinYears: z.number().optional(),
  roofAgeMaxYears: z.number().optional(),
  tileBump: z.number().optional(),
  sourceQuality: z.record(z.string(), z.number()).optional(),
  sourceDefault: z.number().optional(),
  serviceAreaStates: z.array(z.string()).nullable().optional(),
  renterMultiplier: z.number().optional(),
  multiEventBumpPct: z.number().optional(),
  stormLaneThreshold: z.number().optional(),
});

export function parseScoringConfig(raw: unknown): ScoringConfig {
  const p = schema.safeParse(raw ?? {});
  const o = p.success ? p.data : {};
  return {
    ...DEFAULTS,
    ...o,
    weights: { ...DEFAULTS.weights, ...(o.weights ?? {}) },
    bands: { ...DEFAULTS.bands, ...(o.bands ?? {}) },
    sourceQuality: { ...DEFAULTS.sourceQuality, ...(o.sourceQuality ?? {}) },
    serviceAreaStates: o.serviceAreaStates ?? DEFAULTS.serviceAreaStates,
  };
}

function hailBase(inches: number): number {
  if (inches >= 1.5) return 1.0;
  if (inches >= 1.0) return 0.7;
  if (inches >= 0.75) return 0.4;
  return 0;
}
function windBase(mph: number): number {
  if (mph >= 58) return 0.6;
  if (mph >= 45) return 0.35;
  return 0;
}
function recencyFactor(daysSinceWorst: number | null): number {
  if (daysSinceWorst == null) return 0.5; // storm present but undated → neutral
  const months = daysSinceWorst / 30.44;
  if (months <= 6) return 1.0;
  if (months <= 12) return 0.85;
  if (months <= 18) return 0.55;
  if (months <= 24) return 0.3;
  return 0; // >24 months → no meaningful recency (per product spec)
}

// 0..1 storm exposure: max(severity)·recency, +bump for repeat events, capped.
export function stormSubScore(storm: StormFeature, cfg: ScoringConfig): number {
  const severity = Math.max(hailBase(storm.maxHailInches), windBase(storm.maxWindMph));
  if (severity === 0) return 0;
  let s = severity * recencyFactor(storm.daysSinceWorst);
  if (storm.eventCount >= 2) s *= 1 + cfg.multiEventBumpPct;
  return Math.max(0, Math.min(1, s));
}

function roofSubScore(f: LeadFeatures, cfg: ScoringConfig): number {
  if (f.roofAgeYears == null) return 0.5; // neutral, not zero
  const span = Math.max(1, cfg.roofAgeMaxYears - cfg.roofAgeMinYears);
  let s = Math.max(0, Math.min(1, (f.roofAgeYears - cfg.roofAgeMinYears) / span));
  // Tile drives service value; a tile facet in EITHER slot earns the bump (slice 5:
  // e.g. an asphalt+tile or tile+foam roof scores like its tile component).
  if (f.roofType === "tile" || f.roofTypeSecondary === "tile") s = Math.min(1, s + cfg.tileBump);
  return s;
}

function sourceSubScore(f: LeadFeatures, cfg: ScoringConfig): number {
  return cfg.sourceQuality[(f.source ?? "").toLowerCase()] ?? cfg.sourceDefault;
}

export function deriveBand(score: number, cfg: ScoringConfig): ScoreBand {
  if (score >= cfg.bands.hot) return "hot";
  if (score >= cfg.bands.warm) return "warm";
  if (score >= cfg.bands.cool) return "cool";
  return "cold";
}

export type ScoreBandLegendRow = { band: ScoreBand; label: string; min: number; max: number };

/** The 0–100 scale as contiguous band ranges, for the in-app score-chip tooltip (slice 5). */
export function scoreBandLegend(cfg: ScoringConfig): ScoreBandLegendRow[] {
  const { hot, warm, cool } = cfg.bands;
  return [
    { band: "hot", label: "Hot", min: hot, max: 100 },
    { band: "warm", label: "Warm", min: warm, max: hot - 1 },
    { band: "cool", label: "Cool", min: cool, max: warm - 1 },
    { band: "cold", label: "Cold", min: 0, max: cool - 1 },
  ];
}

export function scoreLead(f: LeadFeatures, cfg: ScoringConfig): ScoredLead {
  const storm = stormSubScore(f.storm, cfg);
  const roof = roofSubScore(f, cfg);
  const source = sourceSubScore(f, cfg);
  const components = { storm, roof, source };

  // Out-of-service-area fit gate (only when a service area is configured AND the state is known).
  if (cfg.serviceAreaStates && f.state && !cfg.serviceAreaStates.includes(f.state)) {
    return { score: 0, band: "cold", reasons: ["Out of area — disqualified"], components, disqualified: true };
  }

  const w = cfg.weights;
  const wsum = w.storm + w.roof + w.source || 1;
  const score = Math.round((100 * (w.storm * storm + w.roof * roof + w.source * source)) / wsum);
  const band = deriveBand(score, cfg);

  const reasons: string[] = [];
  if (storm > 0) {
    const mo = f.storm.daysSinceWorst == null ? null : Math.round(f.storm.daysSinceWorst / 30.44);
    const kind = f.storm.maxHailInches >= 0.75 ? `${f.storm.maxHailInches}" hail` : `${f.storm.maxWindMph}mph wind`;
    reasons.push(mo == null ? `Storm exposure (${kind})` : `${kind} ${mo} mo ago`);
  }
  const tile = f.roofType === "tile" || f.roofTypeSecondary === "tile" ? " (tile)" : "";
  if (f.roofAgeYears != null && f.roofReplacementYear) {
    // A KNOWN replacement is always cited (even for a young roof), so the rationale
    // reflects the effective age instead of implying a build-year age. This is what
    // the lead.effective_age invariant enforces (slice 5 — "roof ~9 yrs — replaced 2017").
    reasons.push(`Roof ~${f.roofAgeYears} yrs — replaced ${f.roofReplacementYear}${tile}`);
  } else if (f.roofAgeYears != null && f.roofAgeYears >= cfg.roofAgeMinYears) {
    reasons.push(`Roof ~${f.roofAgeYears} yrs${tile}`);
  }
  if (source >= 0.7) reasons.push(`${f.source} lead`);

  return { score, band, reasons, components, disqualified: false };
}
