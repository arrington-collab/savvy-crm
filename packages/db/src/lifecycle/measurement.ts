import { withTenant } from "../tenant";
import { measurement } from "../schema/ops";
import { lead } from "../schema/crm";
import { job } from "../schema/jobs";
import { eq } from "drizzle-orm";
import {
  roofSketchSchema,
  summarizeSketch,
  sketchSummaryToAreas,
  type RoofSketch,
} from "@savvy/core";

/** A DIY sketch belongs to the shared property of either a lead or a job. */
export type SketchScope = { kind: "lead" | "job"; id: string };

export type SaveSketchMeasurementResult =
  | {
      ok: true;
      measurementId: string;
      propertyId: string;
      leadId: string | undefined;
      jobId: string | undefined;
    }
  | { error: "invalid_sketch" | "no_property" };

/**
 * Persist a self-drawn (DIY) roof sketch as a `measurement` row on the scope's
 * property. `measurement` is property-scoped (no job_id), and property is shared across
 * the lead → job lifecycle — so a sketch drawn at LEAD stage is the same row the job
 * later reads. That is why the roof drawing can drive the lead-stage estimate that in
 * turn creates the job (never the reverse).
 *
 * The sketch geometry rides along inside `areas.sketch` so the editor can re-open it;
 * the flat MeasurementAreas fields feed the estimate engine unchanged.
 *
 * Returns the resolved scope ids so the caller can emit `measurement/ready` — leadId is
 * set for the lead path and jobId omitted, because the estimate gate keys off leadId.
 */
export async function saveSketchMeasurement(input: {
  tenantId: string;
  scope: SketchScope;
  sketch: RoofSketch;
  measurementId?: string | null;
}): Promise<SaveSketchMeasurementResult> {
  const parsed = roofSketchSchema.safeParse(input.sketch);
  if (!parsed.success) return { error: "invalid_sketch" };
  const sketch = parsed.data;

  const summary = summarizeSketch(sketch);
  const areas: Record<string, unknown> = {
    ...sketchSummaryToAreas(summary),
    totalSqft: Math.round(summary.totalSurfaceSqft),
    flatSqft: Math.round(summary.flatSqft),
    pitchedSqft: Math.round(summary.pitchedSqft),
    sketch,
  };

  return withTenant(input.tenantId, async (tx) => {
    // Resolve the property (and the scope ids for the estimate seam) from the lead or job.
    let propertyId: string | null;
    let leadId: string | undefined;
    let jobId: string | undefined;
    if (input.scope.kind === "lead") {
      const [l] = await tx.select({ propertyId: lead.propertyId }).from(lead).where(eq(lead.id, input.scope.id));
      propertyId = l?.propertyId ?? null;
      leadId = input.scope.id;
    } else {
      const [j] = await tx
        .select({ propertyId: job.propertyId, leadId: job.leadId })
        .from(job)
        .where(eq(job.id, input.scope.id));
      propertyId = j?.propertyId ?? null;
      leadId = j?.leadId ?? undefined;
      jobId = input.scope.id;
    }
    if (!propertyId) return { error: "no_property" as const };

    if (input.measurementId) {
      const [row] = await tx
        .update(measurement)
        .set({ areas, pitch: summary.predominantPitch, provider: "diy", source: "sketch" })
        .where(eq(measurement.id, input.measurementId))
        .returning({ id: measurement.id });
      if (row) return { ok: true as const, measurementId: row.id, propertyId, leadId, jobId };
    }

    const [row] = await tx
      .insert(measurement)
      .values({
        tenantId: input.tenantId,
        propertyId,
        provider: "diy",
        source: "sketch",
        pitch: summary.predominantPitch,
        areas,
      })
      .returning({ id: measurement.id });
    return { ok: true as const, measurementId: row!.id, propertyId, leadId, jobId };
  });
}
