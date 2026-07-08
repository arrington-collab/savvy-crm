"use server";

import { revalidatePath } from "next/cache";
import { saveSketchMeasurement, type SketchScope } from "@savvy/db";
import { type RoofSketch } from "@savvy/core";
import { inngest } from "@savvy/agents";
import { getTenantId } from "./tenant";

/** Persist a self-drawn (DIY) roof sketch as a measurement, scoped to a lead or a job.
 *  The measurement rides on the shared property, so a sketch drawn at LEAD stage (before
 *  any job exists) is the same row the job later reads — and it drives the lead-stage
 *  estimate that in turn creates the job. Property resolution + persistence live in the
 *  `saveSketchMeasurement` lifecycle fn (tested in @savvy/db); this action wraps it with
 *  the tenant context, the durable estimate seam, and cache revalidation. */
export async function saveSketchMeasurementAction(input: {
  scope: SketchScope;
  sketch: RoofSketch;
  measurementId?: string | null;
}): Promise<{ ok: true; measurementId: string } | { error: string }> {
  const tenantId = await getTenantId();

  const result = await saveSketchMeasurement({
    tenantId,
    scope: input.scope,
    sketch: input.sketch,
    measurementId: input.measurementId,
  });
  if ("error" in result) return { error: result.error };

  // DIY measurement landed — trigger the estimate (first data wins). The gate in
  // draftLeadEstimateIfReady still waits for inspection completion. leadId is set for the
  // lead path (jobId undefined); the gate keys off leadId.
  try {
    await inngest.send({
      name: "measurement/ready",
      data: {
        tenantId,
        measurementId: result.measurementId,
        propertyId: result.propertyId,
        leadId: result.leadId,
        jobId: result.jobId,
      },
    });
  } catch (e) {
    console.error("inngest.send failed", e);
  }

  const base = input.scope.kind === "lead" ? `/leads/${input.scope.id}` : `/jobs/${input.scope.id}`;
  revalidatePath(base);
  revalidatePath(`${base}/measure`);
  return { ok: true, measurementId: result.measurementId };
}
