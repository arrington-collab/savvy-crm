export interface ClaimSummary {
  id: string;
  /** The job this claim was carried onto once the lead converts; null pre-conversion. */
  jobId: string | null;
  carrierName: string | null;
  claimNumber: string | null;
  acvCents: number | null;
  rcvCents: number | null;
  deductibleCents: number | null;
  lineItemCount: number;
}

export interface MeasurementSummary {
  id: string;
  squares: number | null;
  pitch: string | null;
  ridgeLf: number | null;
  hipLf: number | null;
  valleyLf: number | null;
  eaveLf: number | null;
  rakeLf: number | null;
  facetCount: number | null;
  penetrationCount: number | null;
  /** Roof waste as a 0-1 fraction, shown only when the source measurement carries it. */
  wasteFactor: number | null;
}

export type DocParseSummary =
  | { kind: "insurance_estimate"; status: string; confidence: number | null; claim: ClaimSummary | null }
  | { kind: "measurement_report"; status: string; confidence: number | null; measurement: MeasurementSummary | null };

export interface ParseView {
  tone: "parsed" | "low" | "failed" | "pending";
  headline: string;
  rows: { label: string; value: string }[];
  // Claim links to its job (only once converted); measurement links to the lead's measure view.
  entityLink: { kind: "claim"; jobId: string | null } | { kind: "measurement"; id: string } | null;
}

function usd(cents: number | null): string {
  if (cents == null) return "—";
  return `$${Math.round(cents / 100).toLocaleString()}`;
}
function num(n: number | null): string {
  return n == null ? "—" : String(n);
}
function pct(c: number | null): string {
  return c == null ? "—" : `${Math.round(c * 100)}%`;
}

/**
 * Map a live parse summary to a display model. Pure; non-`parsed` states carry no rows and
 * no entity link — the panel shows their status headline instead. This is the trust-surface
 * shaping: the owner reads these rows next to the source PDF.
 */
export function parseSummaryView(s: DocParseSummary): ParseView {
  if (s.status === "unparsed_low_confidence") {
    return { tone: "low", headline: "Stored, unparsed — card open", rows: [], entityLink: null };
  }
  if (s.status === "parse_failed") {
    return { tone: "failed", headline: "Parse failed — re-run to retry", rows: [], entityLink: null };
  }
  if (s.status !== "parsed") {
    return { tone: "pending", headline: "Parsing…", rows: [], entityLink: null };
  }

  if (s.kind === "insurance_estimate") {
    const c = s.claim;
    const rows: { label: string; value: string }[] = c
      ? [
          { label: "Carrier", value: c.carrierName ?? "—" },
          { label: "Claim #", value: c.claimNumber ?? "—" },
          { label: "ACV", value: usd(c.acvCents) },
          { label: "RCV", value: usd(c.rcvCents) },
          { label: "Deductible", value: usd(c.deductibleCents) },
          { label: "Line items", value: String(c.lineItemCount) },
          { label: "Confidence", value: pct(s.confidence) },
        ]
      : [];
    return { tone: "parsed", headline: "Extracted from insurance estimate", rows, entityLink: c ? { kind: "claim", jobId: c.jobId } : null };
  }

  const m = s.measurement;
  const rows: { label: string; value: string }[] = m
    ? [
        { label: "Squares", value: num(m.squares) },
        { label: "Pitch", value: m.pitch ?? "—" },
        { label: "Ridge LF", value: num(m.ridgeLf) },
        { label: "Hip LF", value: num(m.hipLf) },
        { label: "Valley LF", value: num(m.valleyLf) },
        { label: "Eave LF", value: num(m.eaveLf) },
        { label: "Rake LF", value: num(m.rakeLf) },
        { label: "Facets", value: num(m.facetCount) },
        { label: "Penetrations", value: num(m.penetrationCount) },
        // Waste only appears when the source measurement carries it (sketch/DIY); uploaded reports omit it.
        ...(m.wasteFactor != null ? [{ label: "Waste", value: `${Math.round(m.wasteFactor * 100)}%` }] : []),
        { label: "Confidence", value: pct(s.confidence) },
      ]
    : [];
  return { tone: "parsed", headline: "Extracted from measurement report", rows, entityLink: m ? { kind: "measurement", id: m.id } : null };
}
