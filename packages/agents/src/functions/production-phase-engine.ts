// Production Pulse slice 1: Inngest wiring for the phase engine.
// - Phases instantiate when a job ENTERS production (the derived-status
//   triggers already advance the stage; this rides the same event).
// - QC failures on completion evidence reopen the phase (punch) — the office
//   hears about it as an exception, the crew re-shoots; routine progress
//   never pings a human.

import { withTenant, eq, job, instantiateProductionPhases, ensureProductionPhaseTemplates, reopenPhaseForQcFailure, withAgentRun } from "@savvy/db";
import { inngest } from "../client";

/** Instantiate phases when the job enters production. Idempotent per job. */
export async function instantiatePhasesHandler(input: {
  tenantId: string;
  jobId: string;
}): Promise<{ created: number } | { skipped: string }> {
  const [j] = await withTenant(input.tenantId, (tx) =>
    tx.select({ stage: job.stage }).from(job).where(eq(job.id, input.jobId)));
  if (j?.stage !== "production") return { skipped: "not_production" };
  await ensureProductionPhaseTemplates(input.tenantId);
  const res = await withAgentRun(
    { tenantId: input.tenantId, agent: "orchestrator", taskKey: "production_pulse.instantiate", jobId: input.jobId, leadId: null },
    () => instantiateProductionPhases({ tenantId: input.tenantId, jobId: input.jobId }),
    { resolve: (r) => ("created" in r && r.created > 0 ? { status: "ok" } : { status: "skipped" }) },
  );
  if ("error" in res) return { skipped: res.error };
  return { created: res.created };
}

export const productionPhasesOnStage = inngest.createFunction(
  { id: "production-phases-on-stage", retries: 2 },
  { event: "job/stage-changed" },
  async ({ event, step }) => {
    const { tenantId, jobId, toStage } = event.data;
    if (toStage !== "production") return { skipped: "not_production" };
    return step.run("instantiate", () => instantiatePhasesHandler({ tenantId, jobId }));
  },
);

/** QC verdicts already flow through photo/ingested → photoQc → setPhotoQc.
 *  This rides the SAME event with a delay-tolerant recheck: if the document
 *  ended up flagged AND was completion evidence, the phase reopens. */
export const productionPhaseQcReopen = inngest.createFunction(
  { id: "production-phase-qc-reopen", retries: 2 },
  { event: "photo/ingested" },
  async ({ event, step }) => {
    const { tenantId, documentId } = event.data;
    // Give the QC pass time to land its verdict before checking.
    await step.sleep("await-qc", "2m");
    const res = await step.run("reopen-if-flagged", () => reopenPhaseForQcFailure({ tenantId, documentId }));
    return res;
  },
);
