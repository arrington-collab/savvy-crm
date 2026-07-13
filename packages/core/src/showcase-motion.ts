import type { EvidenceStatus } from "./enums";

// ── A: orb pulse rate ────────────────────────────────────────────────────────
/** 0 runs/hour: a gentle idle breath so the orb is alive but honest about being idle. */
export const ORB_IDLE_SECONDS = 6;
/** Safety floor: a huge burst never strobes faster than this (accessibility). */
export const ORB_MIN_SECONDS = 1.2;

/**
 * Seconds per pulse for the SageCore orb, driven by real runs/hour.
 *
 * Honesty rule (spec §4): the orb must NEVER pulse faster than the real cadence.
 * With `n` runs in the last hour the real period is `3600/n` seconds; we use that
 * as the pulse period, floored at `ORB_MIN_SECONDS`. Since the floor only ever makes
 * the pulse *slower*, `pulses/hour ≤ runs/hour` always holds. 0 runs/hour is the one
 * sanctioned exception: a slow idle breath rather than a frozen orb.
 */
export function pulseDurationSeconds(runsLastHour: number): number {
  if (runsLastHour <= 0) return ORB_IDLE_SECONDS;
  const secondsPerRun = 3600 / runsLastHour;
  return Math.max(secondsPerRun, ORB_MIN_SECONDS);
}

// ── B: coverage-cell wins ────────────────────────────────────────────────────
/**
 * Check keys that transitioned into a *genuine* win since the last poll: `fail`
 * or `stale` → `pass`. A `skip → pass` is not a win (nothing was earned), an
 * already-`pass` doesn't glow, and the first observation (no prior status) never
 * celebrates — we only react to a transition we actually watched happen.
 */
export function coverageWins(
  prev: Record<string, EvidenceStatus>,
  next: Record<string, EvidenceStatus>,
): string[] {
  return Object.keys(next).filter((k) => next[k] === "pass" && (prev[k] === "fail" || prev[k] === "stale"));
}

// ── C: enrichment settled ────────────────────────────────────────────────────
/** True when a run that was in-flight last poll is now gone (completed) — the cue to refresh. */
export function justCompleted(prev: unknown | null, next: unknown | null): boolean {
  return prev != null && next == null;
}
