import { withTenant, advanceJobStageForward, missingProductionPhotos, hasScheduledCrewInstall } from "@savvy/db";
import { type JobStage } from "@savvy/core";
import { inngest } from "../client";

type StageResult = { toStage: JobStage } | { skipped: string };

/**
 * Derived-status triggers (spec §B). Each maps a real-world signal to a forward-only
 * stage advance so the board stays current with zero manual dragging.
 */

/** Crew GPS check-in → production. */
export async function syncCrewCheckInStage(tenantId: string, jobId: string): Promise<StageResult> {
  return withTenant(tenantId, (tx) =>
    advanceJobStageForward(tx, { tenantId, jobId, toStage: "production", byAgent: "scheduling" }),
  );
}

/** Material delivery confirmed + crew assigned → production (delivery alone is not "ready"). */
export async function syncMaterialDeliveredStage(tenantId: string, jobId: string): Promise<StageResult> {
  return withTenant(tenantId, async (tx) => {
    if (!(await hasScheduledCrewInstall(tx, jobId))) return { skipped: "no_crew_install" };
    return advanceJobStageForward(tx, { tenantId, jobId, toStage: "production", byAgent: "scheduling" });
  });
}

/** Required completion photos satisfied → closeout (photo-based QA; we trust the crew). */
export async function syncCompletionPhotosStage(tenantId: string, jobId: string): Promise<StageResult> {
  return withTenant(tenantId, async (tx) => {
    const missing = await missingProductionPhotos(tx, tenantId, jobId);
    if (missing.length > 0) return { skipped: "photos_incomplete" };
    return advanceJobStageForward(tx, { tenantId, jobId, toStage: "closeout", byAgent: "orchestrator" });
  });
}

export const crewCheckedInToProduction = inngest.createFunction(
  { id: "crew-checked-in-to-production", concurrency: { limit: 5 } },
  { event: "crew/checked-in" },
  async ({ event, step }) => step.run("sync", () => syncCrewCheckInStage(event.data.tenantId, event.data.jobId)),
);

export const materialDeliveredToProduction = inngest.createFunction(
  { id: "material-delivered-to-production", concurrency: { limit: 5 } },
  { event: "material/delivered" },
  async ({ event, step }) => step.run("sync", () => syncMaterialDeliveredStage(event.data.tenantId, event.data.jobId)),
);

export const productionPhotosToCloseout = inngest.createFunction(
  { id: "production-photos-to-closeout", concurrency: { limit: 5 } },
  { event: "job/production-photos-updated" },
  async ({ event, step }) => step.run("sync", () => syncCompletionPhotosStage(event.data.tenantId, event.data.jobId)),
);
