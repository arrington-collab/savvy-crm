// Estimate Experience slice 6: drip-step gates — the mechanism that lets the
// follow-up sequence carry slots for machinery that isn't live yet.

import type { DripGate } from "./enums";

export function dripGateOpen(
  gate: DripGate | undefined,
  env: { financingLive: boolean; features: Set<string> },
): boolean {
  if (!gate) return true;
  if (gate === "financing_live") return env.financingLive;
  if (gate.startsWith("feature:")) return env.features.has(gate.slice("feature:".length));
  return false;
}
