/**
 * Re-derive every job's stage from its evidence (contiguous model). Regresses over-declared
 * jobs (e.g. a job left at 'inspected' with no inspection) and promotes fully-evidenced ones.
 * Idempotent. Writes a corrective job_stage_event (note) per change. Data-only, no schema.
 *
 * Usage (local):  pnpm --filter @savvy/db exec tsx src/scripts/rederive-job-stages.ts [--dry-run]
 * Usage (prod):   DATABASE_ADMIN_URL="<prod-admin-url>" pnpm --filter @savvy/db exec tsx src/scripts/rederive-job-stages.ts --dry-run
 */
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client";
import { withTenant } from "../tenant";
import { job, jobStageEvent } from "../schema/index";
import { deriveContiguousStage } from "@savvy/core";
import { gatherStageEvidence } from "../lifecycle/stage-evidence-db";

export async function rederiveJobStages(opts: { dryRun: boolean }): Promise<{ scanned: number; changes: { jobId: string; tenantId: string; from: string; to: string }[] }> {
  const jobs = await adminDb.select({ id: job.id, tenantId: job.tenantId, stage: job.stage }).from(job);
  const changes: { jobId: string; tenantId: string; from: string; to: string }[] = [];
  for (const j of jobs) {
    const derived = await withTenant(j.tenantId, (tx) => gatherStageEvidence(tx, { tenantId: j.tenantId, jobId: j.id }).then(deriveContiguousStage));
    if (derived === j.stage) continue;
    changes.push({ jobId: j.id, tenantId: j.tenantId, from: j.stage, to: derived });
    if (!opts.dryRun) {
      await withTenant(j.tenantId, async (tx) => {
        await tx.update(job).set({ stage: derived, stageEnteredAt: new Date() }).where(eq(job.id, j.id));
        await tx.insert(jobStageEvent).values({ tenantId: j.tenantId, jobId: j.id, fromStage: j.stage, toStage: derived, byAgent: "orchestrator", note: "re-derive: evidence-supported stage" });
      });
    }
  }
  return { scanned: jobs.length, changes };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const { scanned, changes } = await rederiveJobStages({ dryRun });
  console.log(`scanned ${scanned} job(s); ${changes.length} would change`);
  const regressions = changes.filter((c) => c.from !== "lead");
  for (const c of changes) console.log(`  job ${c.jobId} (tenant ${c.tenantId}) ${c.from} -> ${c.to}`);
  console.log(`(${regressions.length} regressions/other, ${changes.length - regressions.length} promotions from lead)`);
  console.log(dryRun ? "dry-run: no changes written" : "changes applied");
  await adminPool.end();
}

// Run main() only as a CLI, not when imported by a test.
if (process.argv[1] && process.argv[1].includes("rederive-job-stages")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
