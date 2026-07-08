/**
 * Backfill: recompute the stored `measurement.areas` for DIY sketch measurements using
 * the shared-edge-deduped summarizeSketch (slice 2). Sketches drawn before the fix stored
 * double-counted ridge/hip/valley LF; this recomputes them from the SAME stored geometry
 * (`areas.sketch`) — data-only, no schema change, idempotent (a re-run writes nothing new).
 *
 * Usage (local): pnpm --filter @savvy/db exec tsx src/scripts/backfill-sketch-summaries.ts [--dry-run]
 * Usage (prod):  DATABASE_ADMIN_URL="<prod-admin-url>" pnpm --filter @savvy/db exec tsx src/scripts/backfill-sketch-summaries.ts --dry-run
 */
import { adminDb, adminPool } from "../admin-client";
import { measurement } from "../schema/ops";
import { eq } from "drizzle-orm";
import { roofSketchSchema, summarizeSketch, sketchSummaryToAreas } from "@savvy/core";

const LF_KEYS = ["ridgeLf", "hipLf", "valleyLf", "eaveLf", "rakeLf", "stepFlashingLf"] as const;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const rows = await adminDb.select().from(measurement).where(eq(measurement.provider, "diy"));
  let withSketch = 0;
  let changed = 0;

  for (const m of rows) {
    const areas = (m.areas ?? {}) as Record<string, unknown>;
    const parsed = roofSketchSchema.safeParse(areas.sketch);
    if (!parsed.success) continue;
    withSketch++;

    const summary = summarizeSketch(parsed.data);
    const next: Record<string, unknown> = {
      ...sketchSummaryToAreas(summary),
      totalSqft: Math.round(summary.totalSurfaceSqft),
      flatSqft: Math.round(summary.flatSqft),
      pitchedSqft: Math.round(summary.pitchedSqft),
      sketch: parsed.data,
    };

    const before = LF_KEYS.map((k) => `${k}=${areas[k] ?? "?"}`).join(" ");
    const after = LF_KEYS.map((k) => `${k}=${next[k]}`).join(" ");
    if (before === after) continue; // already deduped — leave it

    changed++;
    console.log(`measurement ${m.id} (${summary.sharedEdgeCount} shared edge(s))`);
    console.log(`  before: ${before}`);
    console.log(`  after:  ${after}`);
    if (!dryRun) {
      await adminDb.update(measurement).set({ areas: next }).where(eq(measurement.id, m.id));
    }
  }

  console.log(`${withSketch} DIY measurement(s) with a sketch; ${changed} had double-counted LF${dryRun ? " (dry-run: no writes)" : " (updated)"}`);
  await adminPool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
