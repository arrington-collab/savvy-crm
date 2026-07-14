import { refreshLeadEstimateDraft, withAgentRun } from "@savvy/db";
import { inngest } from "../client";

const LIVE_BUILD_TASK_KEY = "roof_record.live_build";

/**
 * Roof Record slice 1: LIVE BUILD. Every new zone-tagged photo re-prices the
 * lead's estimate pre-draft so both artifacts are ready when the inspector
 * climbs down. The refresh is idempotent and self-gating (skips without a live
 * inspection or once the estimate leaves draft), so event replays are safe.
 * Attributed as an agent_run on the lead — the activity feed shows the record
 * assembling in real time.
 */
export async function inspectionMediaHandler(input: {
  tenantId: string;
  inspectionId: string;
  leadId: string | null;
}): Promise<{ estimateId: string; action: string } | { skipped: string }> {
  if (!input.leadId) return { skipped: "no_lead" };
  const leadId = input.leadId;
  return withAgentRun(
    { tenantId: input.tenantId, agent: "claims", taskKey: LIVE_BUILD_TASK_KEY, leadId, jobId: null },
    () => refreshLeadEstimateDraft({ tenantId: input.tenantId, leadId }),
    { resolve: (r) => ("estimateId" in r ? { status: "ok" } : { status: "skipped" }) },
  );
}

export const inspectionLiveBuild = inngest.createFunction(
  // Per-inspection serialization: media events for one inspection refresh in
  // order instead of racing each other's re-price.
  { id: "inspection-live-build", concurrency: { limit: 1, key: "event.data.inspectionId" }, retries: 2 },
  { event: "inspection/media.ingested" },
  async ({ event, step }) => {
    const { tenantId, inspectionId, leadId } = event.data;
    return step.run("refresh-pre-draft", () => inspectionMediaHandler({ tenantId, inspectionId, leadId }));
  },
);

/**
 * Completion: one FINAL re-price so a photo that landed after the last refresh
 * is still reflected. The draft-once trigger (appointment/completed path) is
 * untouched — if no pre-draft exists this creates it; if one exists it re-prices.
 */
export const inspectionFinalize = inngest.createFunction(
  { id: "inspection-finalize", retries: 2 },
  { event: "inspection/completed" },
  async ({ event, step }) => {
    const { tenantId, inspectionId, leadId } = event.data;
    return step.run("final-reprice", () => inspectionMediaHandler({ tenantId, inspectionId, leadId }));
  },
);
