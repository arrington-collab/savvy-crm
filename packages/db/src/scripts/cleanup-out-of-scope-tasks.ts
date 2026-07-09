/**
 * Idempotent prod cleanup: remove out-of-scope task rows left over from before per-scope task
 * ledgers existed. Deletes `job_task` rows whose registry scope is not `per_job`, `lead_task`
 * rows whose registry scope is not `per_lead`, and the legacy marketing `job_checklist_item`
 * rows (num 2, 4, 12, 14). Data-only, no schema. Safe to re-run — a second run deletes 0.
 *
 * Usage (local):  pnpm --filter @savvy/db exec tsx src/scripts/cleanup-out-of-scope-tasks.ts [--dry-run]
 * Usage (prod):   DATABASE_ADMIN_URL="<prod-admin-url>" pnpm --filter @savvy/db exec tsx src/scripts/cleanup-out-of-scope-tasks.ts --dry-run
 */
import { sql } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client";

export async function cleanupOutOfScopeTasks(opts: { dryRun: boolean }): Promise<{ jobTaskDeleted: number; leadTaskDeleted: number; checklistDeleted: number }> {
  if (opts.dryRun) {
    const jt = await adminDb.execute(sql`select jt.id from job_task jt join task_registry tr on tr.id=jt.task_id where tr.scope <> 'per_job'`);
    const lt = await adminDb.execute(sql`select lt.id from lead_task lt join task_registry tr on tr.id=lt.task_id where tr.scope <> 'per_lead'`);
    const ci = await adminDb.execute(sql`select id from job_checklist_item where (payload->>'num')::int in (2,4,12,14)`);
    return { jobTaskDeleted: jt.rows.length, leadTaskDeleted: lt.rows.length, checklistDeleted: ci.rows.length };
  }
  const jt = await adminDb.execute(sql`delete from job_task jt using task_registry tr where tr.id=jt.task_id and tr.scope <> 'per_job' returning jt.id`);
  const lt = await adminDb.execute(sql`delete from lead_task lt using task_registry tr where tr.id=lt.task_id and tr.scope <> 'per_lead' returning lt.id`);
  const ci = await adminDb.execute(sql`delete from job_checklist_item where (payload->>'num')::int in (2,4,12,14) returning id`);
  return { jobTaskDeleted: jt.rows.length, leadTaskDeleted: lt.rows.length, checklistDeleted: ci.rows.length };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const res = await cleanupOutOfScopeTasks({ dryRun });
  console.log(JSON.stringify({ dryRun, ...res }));
  await adminPool.end();
}

// Run main() only as a CLI, not when imported by a test.
if (process.argv[1] && process.argv[1].includes("cleanup-out-of-scope-tasks")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
