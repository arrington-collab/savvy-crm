/**
 * Agent roster activity rollup for the Operator Console Agents screen. Pure so
 * the per-persona counting is unit-tested; the page resolves each agent_run row
 * to a persona (via the web persona resolver, which needs the taskKey) and feeds
 * the already-keyed rows here. Base agent → persona is one-to-many, so the
 * grouping happens on the resolved persona key, not the base agent.
 */
export type PersonaActivityRow = { personaKey: string; status: string; startedAt: Date };
export type PersonaActivity = { actions: number; ok: number; errors: number; skips: number; lastRunAt: Date };

export function rollupPersonaActivity(rows: PersonaActivityRow[]): Record<string, PersonaActivity> {
  const out: Record<string, PersonaActivity> = {};
  for (const r of rows) {
    const a = (out[r.personaKey] ??= { actions: 0, ok: 0, errors: 0, skips: 0, lastRunAt: r.startedAt });
    a.actions += 1;
    if (r.status === "ok") a.ok += 1;
    else if (r.status === "error") a.errors += 1;
    else if (r.status === "skipped") a.skips += 1;
    if (r.startedAt > a.lastRunAt) a.lastRunAt = r.startedAt;
  }
  return out;
}
