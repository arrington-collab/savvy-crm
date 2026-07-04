import Link from "next/link";
import { withTenant, job, property, measurement, eq, desc } from "@savvy/db";
import { roofSketchSchema, type RoofSketch } from "@savvy/core";
import { getTenantId } from "@/lib/tenant";
import { SketchEditor } from "./SketchEditor";

export const dynamic = "force-dynamic";

export default async function MeasurePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenantId = await getTenantId();

  const data = await withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        jobId: job.id,
        propertyId: job.propertyId,
        address: property.address,
        lat: property.lat,
        lng: property.lng,
      })
      .from(job)
      .leftJoin(property, eq(property.id, job.propertyId))
      .where(eq(job.id, id));
    if (!row) return null;

    // Most recent DIY measurement carries the editable sketch geometry.
    const rows = row.propertyId
      ? await tx
          .select()
          .from(measurement)
          .where(eq(measurement.propertyId, row.propertyId))
          .orderBy(desc(measurement.createdAt))
      : [];
    const diy = rows.find((m) => m.provider === "diy");
    return { ...row, diy: diy ?? null };
  });

  if (!data) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Job not found. <Link className="underline" href="/pipeline">Back to pipeline</Link>
      </div>
    );
  }

  let initialSketch: RoofSketch | null = null;
  const rawSketch = (data.diy?.areas as { sketch?: unknown } | null)?.sketch;
  if (rawSketch) {
    const parsed = roofSketchSchema.safeParse(rawSketch);
    if (parsed.success) initialSketch = parsed.data;
  }

  return (
    <SketchEditor
      jobId={data.jobId}
      measurementId={data.diy?.id ?? null}
      address={data.address ?? null}
      lat={data.lat ?? null}
      lng={data.lng ?? null}
      mapsApiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? ""}
      initialSketch={initialSketch}
    />
  );
}
