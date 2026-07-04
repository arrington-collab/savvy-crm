import "server-only";
import { withTenant, adminDb, agentRun, taskRegistry, and, eq, gte, count } from "@savvy/db";
import { rollupPersonaActivity, type PersonaActivity } from "@savvy/core";
import { getTenantId } from "./tenant";
import { PERSONAS, resolveAgent, type Persona } from "./agents";

const DAY_MS = 86_400_000;
// Roster display order: orchestrator → intake → comms → dispatch → finance → claims → collections.
const ROSTER_ORDER = ["SAGE", "ATLAS", "NOVA", "MILO", "VERA", "SCOUT", "RAINE"] as const;

export type RosterCard = {
  persona: Persona;
  tasksOwned: number; // from task_registry.default_owner (0 until ownership is assigned)
  actions24h: number;
  errors: number;
  skips: number;
  lastRunAt: Date | null;
  auditPct: number | null; // not instrumented yet → "—"
};
export type AgentRoster = { cards: RosterCard[]; humanTasks: number; totalActions24h: number };

export async function getAgentRoster(now: Date = new Date()): Promise<AgentRoster> {
  const tenantId = await getTenantId();
  const dayAgo = new Date(now.getTime() - DAY_MS);

  const [ownerRows, runs] = await Promise.all([
    // task_registry is global (no RLS) — count tasks per default owner.
    adminDb.select({ owner: taskRegistry.defaultOwner, n: count() }).from(taskRegistry).groupBy(taskRegistry.defaultOwner),
    withTenant(tenantId, (tx) =>
      tx
        .select({ agent: agentRun.agent, taskKey: agentRun.taskKey, status: agentRun.status, startedAt: agentRun.startedAt })
        .from(agentRun)
        .where(and(eq(agentRun.tenantId, tenantId), gte(agentRun.startedAt, dayAgo))),
    ),
  ]);

  const ownedByKey = new Map<string, number>(ownerRows.map((r) => [r.owner, Number(r.n)]));
  // Resolve each run to a persona (base agent + taskKey), then roll up per persona.
  const activity = rollupPersonaActivity(
    runs.map((r) => ({ personaKey: resolveAgent({ agent: r.agent, taskKey: r.taskKey }).persona.key, status: r.status, startedAt: new Date(r.startedAt as unknown as string) })),
  );

  const cards: RosterCard[] = ROSTER_ORDER.map((key) => {
    const persona = PERSONAS[key];
    const a: PersonaActivity | undefined = activity[key];
    return {
      persona,
      tasksOwned: ownedByKey.get(key) ?? 0,
      actions24h: a?.actions ?? 0,
      errors: a?.errors ?? 0,
      skips: a?.skips ?? 0,
      lastRunAt: a?.lastRunAt ?? null,
      auditPct: null,
    };
  });

  return {
    cards,
    humanTasks: ownedByKey.get("HUMAN") ?? 0,
    totalActions24h: cards.reduce((sum, c) => sum + c.actions24h, 0),
  };
}
