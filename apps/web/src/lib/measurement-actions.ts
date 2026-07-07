"use server";

import { revalidatePath } from "next/cache";
import { withTenant, measurement, job, eq } from "@savvy/db";
import {
  roofSketchSchema,
  summarizeSketch,
  sketchSummaryToAreas,
  type RoofSketch,
} from "@savvy/core";
import { inngest } from "@savvy/agents";
import { getTenantId } from "./tenant";

/** Persist a self-drawn (DIY) roof sketch as a measurement row. The sketch
 *  geometry rides along inside `areas.sketch` so the editor can re-open it;
 *  the flat MeasurementAreas fields feed the estimate engine unchanged. */
export async function saveSketchMeasurementAction(input: {
  jobId: string;
  sketch: RoofSketch;
  measurementId?: string | null;
}): Promise<{ ok: true; measurementId: string } | { error: string }> {
  const tenantId = await getTenantId();

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

  const result = await withTenant(tenantId, async (tx) => {
    const [j] = await tx.select().from(job).where(eq(job.id, input.jobId));
    if (!j?.propertyId) return null;

    if (input.measurementId) {
      const [row] = await tx
        .update(measurement)
        .set({ areas, pitch: summary.predominantPitch, provider: "diy" })
        .where(eq(measurement.id, input.measurementId))
        .returning();
      if (row) return { row, leadId: j.leadId, propertyId: j.propertyId };
    }
    const [row] = await tx
      .insert(measurement)
      .values({
        tenantId,
        propertyId: j.propertyId,
        provider: "diy",
        pitch: summary.predominantPitch,
        areas,
      })
      .returning();
    return row ? { row, leadId: j.leadId, propertyId: j.propertyId } : null;
  });

  if (!result) return { error: "job_or_property_not_found" };
  // DIY measurement landed — trigger the estimate (first data wins). The gate in
  // draftLeadEstimateIfReady still waits for inspection completion.
  try {
    await inngest.send({
      name: "measurement/ready",
      data: { tenantId, measurementId: result.row.id, propertyId: result.propertyId, leadId: result.leadId ?? undefined, jobId: input.jobId },
    });
  } catch (e) {
    console.error("inngest.send failed", e);
  }
  revalidatePath(`/jobs/${input.jobId}`);
  revalidatePath(`/jobs/${input.jobId}/measure`);
  return { ok: true, measurementId: result.row.id };
}
