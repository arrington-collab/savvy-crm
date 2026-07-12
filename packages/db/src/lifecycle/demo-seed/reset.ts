import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../../admin-client";
import { tenant } from "../../schema/tenancy";
import { taskRegistry } from "../../schema/task-registry";
import { recomputeTaskHealth } from "../task-health";
import { provisionDemoTenant, type ProvisionDemoOpts } from "./config";
import { seedDemoLeads, type DemoLeadIds } from "./leads";
import { seedStageJobs, type StageJobIds } from "./jobs";
import { seedFlavorJobs, type FlavorIds } from "./flavor";

export interface SeedDemoTenantSummary {
  leads: DemoLeadIds;
  stageJobs: StageJobIds;
  flavorJobs: FlavorIds;
  tasksSwept: number;
}

/**
 * Full-run orchestration: provision -> leads -> stage jobs -> flavor jobs ->
 * health sweep, so Today/Coverage/activity are populated the moment the demo
 * tenant exists. Idempotent — every step it composes dedupes off natural keys
 * (see config.ts / leads.ts / jobs.ts / flavor.ts), so re-running this against
 * the same tenant (same `opts`) is a no-op past the first run: same tenantId,
 * same job/lead counts, health recomputed fresh.
 *
 * `opts` (keySuffix / clerkOrgId) threads straight to `provisionDemoTenant` for
 * hermetic test isolation. Default (no opts) targets the one real singleton
 * demo tenant.
 */
export async function seedDemoTenant(
  opts: ProvisionDemoOpts = {},
): Promise<{ tenantId: string; summary: SeedDemoTenantSummary }> {
  const { tenantId } = await provisionDemoTenant(opts);

  const leads = await seedDemoLeads(tenantId);
  const stageJobs = await seedStageJobs(tenantId);
  const flavorJobs = await seedFlavorJobs(tenantId);

  // Health sweep: recompute (tenant, task) health for every registry task so
  // task_health rows exist and the Today/Coverage views have something to
  // render. This is the recompute half only (no live evidence checks against
  // vendor integrations — those live in @savvy/agents' sweepTenantHealth,
  // which this package cannot depend on: db is lower in the dependency graph
  // than agents/integrations). Safe to re-run — recomputeTaskHealth upserts.
  const taskIds = await adminDb.select({ id: taskRegistry.id }).from(taskRegistry);
  for (const t of taskIds) {
    await recomputeTaskHealth(tenantId, t.id);
  }

  return {
    tenantId,
    summary: { leads, stageJobs, flavorJobs, tasksSwept: taskIds.length },
  };
}

/**
 * FK-safe teardown of a demo tenant's data. GUARDED: refuses to run against
 * any tenant where `demo !== true` — this must never touch a real customer.
 *
 * Soft (default): wipes all tenant-scoped pipeline/ops data but keeps the
 * `tenant` row and its `user` (staff) rows, so the tenant can be immediately
 * re-seeded without re-provisioning.
 *
 * Hard (`{ hard: true }`): additionally deletes the `user` rows and the
 * `tenant` row itself — full teardown, e.g. for cleaning up an isolated test
 * tenant created via `keySuffix`.
 *
 * Delete order is computed dynamically from the live FK graph (via
 * information_schema/pg_catalog) rather than hand-maintained, so it can't
 * silently drift out of sync as new tenant-scoped tables are added — every
 * table with a `tenant_id` column is discovered and topologically sorted
 * children-before-parents before any DELETE runs.
 */
export async function resetDemoTenant(tenantId: string, opts: { hard?: boolean } = {}): Promise<void> {
  const [t] = await adminDb.select({ demo: tenant.demo }).from(tenant).where(eq(tenant.id, tenantId));
  if (!t) return; // nothing to reset
  if (t.demo !== true) {
    throw new Error(`resetDemoTenant refused: tenant ${tenantId} is not flagged demo=true`);
  }

  const hard = opts.hard === true;
  const order = await tenantScopedDeleteOrder();
  const tablesToWipe = hard ? order : order.filter((name) => name !== "user");

  for (const tableName of tablesToWipe) {
    await adminPool.query(`DELETE FROM ${quoteIdent(tableName)} WHERE tenant_id = $1`, [tenantId]);
  }

  if (hard) {
    await adminPool.query(`DELETE FROM ${quoteIdent("tenant")} WHERE id = $1`, [tenantId]);
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Discovers every table with a `tenant_id` column (all tenant-scoped tables,
 * `user` included) plus `tenant` itself, builds the FK graph among them from
 * `information_schema`, and returns a topologically-sorted delete order
 * (children before the parents they reference). `tenant` is excluded from the
 * returned list — callers handle it explicitly as the final hard-reset step.
 */
async function tenantScopedDeleteOrder(): Promise<string[]> {
  const scopedRes = await adminPool.query<{ table_name: string }>(
    `SELECT DISTINCT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'tenant_id'`,
  );
  const scoped = new Set(scopedRes.rows.map((r) => r.table_name));
  const nodes = new Set(scoped);
  nodes.add("tenant");

  const fkRes = await adminPool.query<{ child_table: string; parent_table: string }>(
    `SELECT
       tc.table_name AS child_table,
       ccu.table_name AS parent_table
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`,
  );

  // edge child -> parent (child must be deleted first). Only keep edges within our node set.
  const edges = fkRes.rows.filter(
    (r) => nodes.has(r.child_table) && nodes.has(r.parent_table) && r.child_table !== r.parent_table,
  );

  // Kahn's algorithm on edges child->parent (child must be deleted first): a
  // node is ready to delete once none of its *children* (tables that hold an
  // FK pointing at it) still have rows remaining. `incoming[parent]` = the
  // set of child tables that reference `parent` and haven't been scheduled
  // for deletion yet.
  const incoming = new Map<string, Set<string>>();
  for (const n of scoped) incoming.set(n, new Set());
  for (const e of edges) {
    if (!scoped.has(e.parent_table)) continue; // `tenant` itself is handled separately by the caller
    incoming.get(e.parent_table)!.add(e.child_table);
  }

  const order: string[] = [];
  const remaining = new Set(scoped);
  while (remaining.size > 0) {
    // A node is deletable now if every child that references it has already
    // been deleted (removed from `remaining`) — i.e. no remaining table still
    // holds a live FK pointing at this one.
    const ready = [...remaining]
      .filter((n) => ![...incoming.get(n)!].some((c) => scoped.has(c) && remaining.has(c)))
      .sort();
    if (ready.length === 0) {
      // Cycle among tenant-scoped tables — fall back to deleting the rest in a
      // deterministic (alphabetical) order rather than hanging forever. Should
      // not happen with this schema; if it does, a FK violation here is a
      // clear signal to inspect the cycle.
      order.push(...[...remaining].sort());
      break;
    }
    for (const n of ready) {
      order.push(n);
      remaining.delete(n);
    }
  }

  return order;
}
