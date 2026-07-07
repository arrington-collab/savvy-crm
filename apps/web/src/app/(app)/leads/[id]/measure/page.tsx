import Link from "next/link";
import { withTenant, lead, property, measurement, eq, desc } from "@savvy/db";
import { roofSketchSchema, type RoofSketch } from "@savvy/core";
import { getTenantId } from "@/lib/tenant";
import { SketchEditor } from "../../../jobs/[id]/measure/SketchEditor";

export const dynamic = "force-dynamic";

/**
 * Lead-stage roof drawing. A job doesn't exist until an estimate is accepted, and there's
 * no estimate without a measurement — so the DIY sketch must be creatable here. The
 * measurement is property-scoped, so this is the same row the job later reads.
 */
export default async function LeadMeasurePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenantId = await getTenantId();

  const data = await withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        leadId: lead.id,
        propertyId: lead.propertyId,
        address: property.address,
        lat: property.lat,
        lng: property.lng,
      })
      .from(lead)
      .leftJoin(property, eq(property.id, lead.propertyId))
      .where(eq(lead.id, id));
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
        Lead not found. <Link className="underline" href="/leads">Back to leads</Link>
      </div>
    );
  }

  if (!data.propertyId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Add the property address to this lead before drawing the roof.{" "}
        <Link className="underline" href={`/leads/${id}`}>Back to lead</Link>
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
      scope={{ kind: "lead", id: data.leadId }}
      measurementId={data.diy?.id ?? null}
      address={data.address ?? null}
      lat={data.lat ?? null}
      lng={data.lng ?? null}
      mapsApiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? ""}
      initialSketch={initialSketch}
    />
  );
}
