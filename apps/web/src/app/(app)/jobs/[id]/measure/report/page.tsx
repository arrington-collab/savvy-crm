import Link from "next/link";
import { withTenant, job, property, customer, measurement, eq, desc } from "@savvy/db";
import {
  roofSketchSchema,
  summarizeSketch,
  ventilationSummary,
  wasteTable,
  SKETCH_EDGE_TYPES,
  SKETCH_EDGE_LABELS,
  SKETCH_EDGE_COLORS,
  type RoofSketch,
} from "@savvy/core";
import { getTenantId } from "@/lib/tenant";
import { PrintButton } from "./PrintButton";
import { SketchDiagram } from "./SketchDiagram";

export const dynamic = "force-dynamic";

export default async function MeasureReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenantId = await getTenantId();

  const data = await withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        jobId: job.id,
        propertyId: job.propertyId,
        address: property.address,
        customerName: customer.name,
      })
      .from(job)
      .leftJoin(property, eq(property.id, job.propertyId))
      .leftJoin(customer, eq(customer.id, job.customerId))
      .where(eq(job.id, id));
    if (!row?.propertyId) return null;
    const rows = await tx
      .select()
      .from(measurement)
      .where(eq(measurement.propertyId, row.propertyId))
      .orderBy(desc(measurement.createdAt));
    const diy = rows.find((m) => m.provider === "diy");
    return { ...row, diy: diy ?? null };
  });

  const rawSketch = (data?.diy?.areas as { sketch?: unknown } | null)?.sketch;
  const parsed = rawSketch ? roofSketchSchema.safeParse(rawSketch) : null;
  const sketch: RoofSketch | null = parsed?.success ? parsed.data : null;

  if (!data || !sketch) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        No sketched measurement for this job yet.{" "}
        <Link className="underline" href={`/jobs/${id}/measure`}>
          Sketch the roof
        </Link>
      </div>
    );
  }

  const summary = summarizeSketch(sketch);
  const vent = ventilationSummary(sketch);
  const waste = wasteTable(summary.totalSurfaceSqft);
  const created = data.diy?.createdAt ? new Date(data.diy.createdAt).toLocaleDateString() : "";

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6 print:max-w-none print:p-0">
      {/* Toolbar (hidden in print) */}
      <div className="flex items-center justify-between print:hidden">
        <Link href={`/jobs/${id}`} className="text-sm text-muted-foreground hover:underline">
          ← Back to job
        </Link>
        <div className="flex items-center gap-2">
          <Link
            href={`/jobs/${id}/measure`}
            className="text-sm underline underline-offset-2 text-muted-foreground hover:text-foreground"
          >
            Edit sketch
          </Link>
          <PrintButton />
        </div>
      </div>

      {/* Header */}
      <header className="border-b border-border pb-4">
        <h1 className="text-2xl font-semibold">Roof Report</h1>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-2 text-sm text-muted-foreground">
          <div>
            {data.address && <div>{data.address}</div>}
            {data.customerName && <div>{data.customerName}</div>}
            {created && <div>Measured {created} · Self-drawn</div>}
          </div>
          <div className="text-right">
            <div className="text-xl font-semibold text-foreground">
              {Math.round(summary.totalSurfaceSqft).toLocaleString()} sqft
            </div>
            <div>
              {summary.facetCount} facets · predominant pitch {summary.predominantPitch}
            </div>
          </div>
        </div>
      </header>

      {/* Diagram */}
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Diagram
        </h2>
        <SketchDiagram sketch={sketch} />
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {SKETCH_EDGE_TYPES.filter((t) => summary.edgeLf[t] > 0).map((t) => (
            <span key={t} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-1 w-5 rounded" style={{ background: SKETCH_EDGE_COLORS[t] }} />
              {SKETCH_EDGE_LABELS[t]}
            </span>
          ))}
        </div>
      </section>

      {/* Summary */}
      <section className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Area
          </h2>
          <table className="w-full text-sm">
            <tbody>
              <Tr k="Plan (footprint) area" v={`${Math.round(summary.totalPlanSqft).toLocaleString()} sqft`} />
              <Tr k="Total roof area" v={`${Math.round(summary.totalSurfaceSqft).toLocaleString()} sqft`} />
              <Tr k="Squares" v={summary.squares.toFixed(1)} />
              <Tr k="Pitched area" v={`${Math.round(summary.pitchedSqft).toLocaleString()} sqft`} />
              <Tr k="Flat area" v={`${Math.round(summary.flatSqft).toLocaleString()} sqft`} />
              <Tr k="Roof facets" v={String(summary.facetCount)} />
              <Tr k="Predominant pitch" v={summary.predominantPitch} />
            </tbody>
          </table>
        </div>
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Lengths
          </h2>
          <table className="w-full text-sm">
            <tbody>
              {SKETCH_EDGE_TYPES.map((t) => (
                <Tr key={t} k={SKETCH_EDGE_LABELS[t]} v={fmtFtIn(summary.edgeLf[t])} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Waste table */}
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Waste factors
        </h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-1.5 font-medium">Waste %</th>
              {waste.map((w) => (
                <th key={w.pct} className="py-1.5 text-right font-medium">
                  {w.pct}%
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border">
              <td className="py-1.5 text-muted-foreground">Area (sqft)</td>
              {waste.map((w) => (
                <td key={w.pct} className="py-1.5 text-right">
                  {w.sqft.toLocaleString()}
                </td>
              ))}
            </tr>
            <tr>
              <td className="py-1.5 text-muted-foreground">Squares</td>
              {waste.map((w) => (
                <td key={w.pct} className="py-1.5 text-right">
                  {w.squares}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted-foreground">
          Waste depends on roof complexity and application style. Verify quantities before ordering
          materials.
        </p>
      </section>

      {/* Ventilation */}
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Ventilation
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Required net free area (NFA):{" "}
          <span className="font-medium text-foreground">{vent.requiredNfaSqft.toFixed(1)} sqft</span> over{" "}
          {Math.round(vent.ventilatedPlanSqft).toLocaleString()} sqft of ventilated plan area (balanced,
          1:300). Target splits ~50% exhaust / 50% intake; intake soffit sizing is pending.
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-1.5 font-medium">Exhaust option</th>
              <th className="py-1.5 text-right font-medium">Qty</th>
              <th className="py-1.5 text-right font-medium">NFA provided</th>
              <th className="py-1.5 text-right font-medium">Meets exhaust</th>
            </tr>
          </thead>
          <tbody>
            {vent.exhaustOptions.map((o) => (
              <tr key={o.key} className="border-b border-border last:border-0">
                <td className="py-1.5">{o.name}</td>
                <td className="py-1.5 text-right">
                  {o.quantity} {o.unit === "lf" ? "LF" : "ea"}
                </td>
                <td className="py-1.5 text-right">{Math.round(o.nfaProvidedSqIn).toLocaleString()} sq in</td>
                <td className="py-1.5 text-right">{o.meetsTarget ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted-foreground">
          Suggestions only — pick the exhaust product you&apos;ll install. Nothing is added to the
          estimate automatically.
        </p>
      </section>

      {/* Facets */}
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Facets
        </h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-1.5 font-medium">#</th>
              <th className="py-1.5 font-medium">Pitch</th>
              <th className="py-1.5 font-medium">Label</th>
              <th className="py-1.5 text-right font-medium">Plan sqft</th>
              <th className="py-1.5 text-right font-medium">Surface sqft</th>
            </tr>
          </thead>
          <tbody>
            {summary.facets.map((f, i) => (
              <tr key={f.id} className="border-b border-border last:border-0">
                <td className="py-1.5">{i + 1}</td>
                <td className="py-1.5">{f.pitch === "0/12" ? "Flat" : f.pitch}</td>
                <td className="py-1.5 capitalize">{f.label === "none" ? "—" : f.label.replace("_", " ")}</td>
                <td className="py-1.5 text-right">{Math.round(f.planSqft).toLocaleString()}</td>
                <td className="py-1.5 text-right">{Math.round(f.surfaceSqft).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Tr({ k, v }: { k: string; v: string }) {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="py-1.5 text-muted-foreground">{k}</td>
      <td className="py-1.5 text-right">{v}</td>
    </tr>
  );
}

function fmtFtIn(ft: number): string {
  const whole = Math.floor(ft);
  const inches = Math.round((ft - whole) * 12);
  if (inches === 12) return `${whole + 1}ft 0in`;
  return `${whole}ft ${inches}in`;
}
