import { verbFor } from "./agent-verbs";

export interface InflightEntry { agent: string; verb: string; startedAt: string }
export interface InflightMap { jobs: Record<string, InflightEntry>; leads: Record<string, InflightEntry> }

/**
 * Shapes running agent_run rows into per-entity in-flight dots for the command
 * center. Filters out runs older than maxSeconds (no stuck spinner) and keeps
 * only the newest run per job/lead.
 */
export function shapeInflight(
  rows: { agent: string; taskKey: string | null; jobId: string | null; leadId: string | null; startedAt: Date }[],
  now: Date,
  maxSeconds: number,
): InflightMap {
  const jobs: Record<string, InflightEntry> = {};
  const leads: Record<string, InflightEntry> = {};
  for (const r of rows) {
    if ((now.getTime() - r.startedAt.getTime()) / 1000 > maxSeconds) continue; // stale → no dot
    const entry: InflightEntry = { agent: r.agent, verb: verbFor(r.taskKey).verb, startedAt: r.startedAt.toISOString() };
    const bucket = r.jobId ? jobs : leads;
    const key = r.jobId ?? r.leadId!;
    const prev = bucket[key];
    if (!prev || entry.startedAt > prev.startedAt) bucket[key] = entry; // newest wins
  }
  return { jobs, leads };
}
