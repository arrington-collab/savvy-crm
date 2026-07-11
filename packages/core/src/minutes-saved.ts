import { verbFor } from "./agent-verbs";

/**
 * Founder-minutes replaced per COMPLETED agent action (spec §3). Conservative by
 * design: a taskKey absent from this map contributes 0 minutes, never a guess, so
 * the odometer can only under-claim. Keyed by the real agent_run.task_key values
 * written across packages/agents. The ops owner tunes these freely.
 */
export const MINUTES_SAVED: Record<string, number> = {
  "estimate.generate": 20, // draft estimate
  "estimating-049": 20, // draft estimate (ESTIMATE_TASK_KEY)
  "lead.doc_parse": 15, // parse insurance / measurement document
  "ops.digest": 10, // compose the daily digest
  "enrich.property": 5, // property enrichment
  "lead.rep.alert": 2, // speed-to-lead: alert the rep
  "ops.health_sweep": 0, // internal sweep — explicitly excluded
};

export interface MinutesLine {
  taskKey: string;
  verb: string;
  count: number;
  minutesEach: number;
  subtotal: number;
}

export interface MinutesSaved {
  totalMinutes: number;
  lines: MinutesLine[];
}

/**
 * Sum founder-minutes replaced. Credits only runs that actually did the work
 * (status "ok") — a skipped or errored run saved nothing. Unknown/zero taskKeys
 * credit 0. Lines are sorted by subtotal desc for the methodology tooltip.
 */
export function summarizeMinutesSaved(
  runs: ReadonlyArray<{ taskKey: string | null; status: string }>,
): MinutesSaved {
  const counts = new Map<string, number>();
  for (const run of runs) {
    if (run.status !== "ok" || !run.taskKey) continue;
    const minutesEach = MINUTES_SAVED[run.taskKey] ?? 0;
    if (minutesEach <= 0) continue; // missing / excluded → 0, never a guess
    counts.set(run.taskKey, (counts.get(run.taskKey) ?? 0) + 1);
  }

  let totalMinutes = 0;
  const lines: MinutesLine[] = [];
  for (const [taskKey, count] of counts) {
    const minutesEach = MINUTES_SAVED[taskKey] ?? 0;
    const subtotal = minutesEach * count;
    totalMinutes += subtotal;
    lines.push({ taskKey, verb: verbFor(taskKey).verb, count, minutesEach, subtotal });
  }
  lines.sort((a, b) => b.subtotal - a.subtotal);
  return { totalMinutes, lines };
}

export type OdometerMode = "quiet" | "counting";

export interface OdometerView {
  mode: OdometerMode;
  actions: number;
  minutes: number;
  lines: MinutesLine[];
}

/**
 * Presentational decision for the Today odometer. Zero (or negative) actions →
 * "quiet" (spec: a literal "quiet night", no count-up). Any actions → "counting".
 */
export function describeOdometer(actions: number, saved: MinutesSaved): OdometerView {
  const safeActions = Math.max(0, Math.floor(actions));
  return {
    mode: safeActions > 0 ? "counting" : "quiet",
    actions: safeActions,
    minutes: saved.totalMinutes,
    lines: saved.lines,
  };
}
