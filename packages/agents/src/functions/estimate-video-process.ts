// Estimate Experience slice 5b: the AI post-processing SEAM. The spec calls
// for silence trim + audio normalize + AUTO-CAPTIONS + a branded end card —
// editing only, never generative. That takes transcription + ffmpeg infra the
// gateway doesn't route yet, so this ships dormant behind
// VIDEO_PROCESSING_URL (same complete-but-dormant pattern as the print seam):
// unset → takes pass through as 'processed' and deliver as recorded.

import { withTenant, eq, estimateVideo } from "@savvy/db";
import { inngest } from "../client";

export const estimateVideoProcess = inngest.createFunction(
  { id: "estimate-video-process" },
  { event: "estimate/video.recorded" },
  async ({ event, step }) => {
    const { tenantId, estimateVideoId } = event.data;
    const endpoint = process.env.VIDEO_PROCESSING_URL;

    if (endpoint) {
      await step.run("process", async () => {
        // Seam contract: POST { estimateVideoId } → the processor pulls the R2
        // object, trims/normalizes/captions/brands, writes a new R2 key, and
        // calls back. Until a processor exists this branch never runs.
        await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tenantId, estimateVideoId }),
        });
      });
      return { processed: "dispatched" };
    }

    await step.run("pass-through", () =>
      withTenant(tenantId, (tx) =>
        tx.update(estimateVideo).set({ status: "processed" }).where(eq(estimateVideo.id, estimateVideoId)),
      ),
    );
    return { processed: "pass-through" };
  },
);
