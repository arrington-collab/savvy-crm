import type { LeadFeatures } from "./lead-features";
import { stormSubScore, type ScoringConfig } from "./lead-scoring";

export type Lane = "storm" | "tile" | "standard";

// Precedence: a qualifying recent storm wins; else a tile roof; else standard.
export function deriveLane(f: LeadFeatures, cfg: ScoringConfig): Lane {
  if (stormSubScore(f.storm, cfg) >= cfg.stormLaneThreshold) return "storm";
  if (f.roofType === "tile" || f.roofTypeSecondary === "tile") return "tile";
  return "standard";
}
