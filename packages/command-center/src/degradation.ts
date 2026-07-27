// Day 4 "honest absence" model (design spec §7 graceful degradation): a
// dashboard metric that cannot be computed yet (no crew-app events, no cost
// data, Twilio still A2P-pending, …) must never render/store a silent 0 —
// zero and unknown are different facts. Every such metric is one of:
//   - { status: "ok", value }        — computed, trust it
//   - { status: "pending", reason }  — not available yet, and why
// Consumers (UI, weekly rollup) branch on `status` instead of null-checking a
// number, so "no data" can never be accidentally summed/averaged as 0.

export type MetricValue = { status: "ok"; value: number } | { status: "pending"; reason: string };

export function ok(value: number): MetricValue {
  return { status: "ok", value };
}

export function pending(reason: string): MetricValue {
  return { status: "pending", reason };
}
