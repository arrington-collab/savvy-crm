import { withTenant, recordStageChange } from "@savvy/db";
import type { JobStage } from "@savvy/core";
import { inngest } from "../client";

// Durable canonical path for PROGRAMMATIC/agent-driven stage changes.
// (User drags on the board call recordStageChange directly in a server action;
// they do NOT emit this event, to avoid double-activation.)
export const jobStageChanged = inngest.createFunction(
  { id: "job-stage-changed" },
  { event: "job/stage-changed" },
  async ({ event, step }) => {
    const { jobId, tenantId, toStage } = event.data;
    return step.run("apply", async () =>
      withTenant(tenantId, (tx) =>
        recordStageChange(tx, { tenantId, jobId, toStage: toStage as JobStage, byAgent: "orchestrator" }),
      ),
    );
  },
);
