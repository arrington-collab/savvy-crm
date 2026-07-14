import { adminDb, canvassPing, sql } from "@savvy/db";
import { inngest } from "../client";

// Trails are an operational aid, not an archive: keep 30 days, prune daily.
export const canvassPingPrune = inngest.createFunction(
  { id: "canvass-ping-prune" },
  { cron: "0 10 * * *" }, // ~3am Phoenix
  async ({ step }) => {
    const pruned = await step.run("prune", async () => {
      const res = await adminDb.delete(canvassPing)
        .where(sql`${canvassPing.at} < now() - interval '30 days'`)
        .returning({ id: canvassPing.id });
      return res.length;
    });
    return { pruned };
  },
);
