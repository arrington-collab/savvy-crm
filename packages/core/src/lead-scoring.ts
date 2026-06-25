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
  sourceQuality: {
    referral: 1.0, repeat: 0.95, carrier: 0.8, storm_canvass: 0.7, google: 0.5,
    website: 0.45, web: 0.45, door_knock: 0.45, facebook: 0.4, yard_sign: 0.35,
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
  if (months <= 9) return 0.85;
  if (months <= 12) return 0.55;
  if (months <= 15) return 0.3;
  return 0; // >~15 months (500+ days) → no meaningful recency
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
  if (f.roofType === "tile") s = Math.min(1, s + cfg.tileBump);
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
  if (f.roofAgeYears != null && f.roofAgeYears >= cfg.roofAgeMinYears) {
    reasons.push(`Roof ~${f.roofAgeYears} yrs${f.roofType === "tile" ? " (tile)" : ""}`);
  }
  if (source >= 0.7) reasons.push(`${f.source} lead`);

  return { score, band, reasons, components, disqualified: false };
}
