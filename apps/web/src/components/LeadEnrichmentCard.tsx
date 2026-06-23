import { Card } from "@/components/ui/card";

type Factor = { label: string; points: number };

export function LeadEnrichmentCard({
  scoreFeatures,
  yearBuilt,
  roofType,
  county,
}: {
  scoreFeatures: { factors?: Factor[]; baseline?: number } | null;
  yearBuilt: number | null;
  roofType: string | null;
  county: string | null;
}) {
  const factors = scoreFeatures?.factors ?? [];

  return (
    <Card className="p-4 space-y-3" data-testid="lead-enrichment-card">
      <h3 className="text-sm font-semibold">Why this score</h3>
      <div className="text-xs text-muted-foreground">
        {[yearBuilt && `Built ${yearBuilt}`, roofType, county && `${county} County`]
          .filter(Boolean)
          .join(" · ") || "No enrichment yet"}
      </div>
      <ul className="space-y-1">
        {factors.map((f, i) => (
          <li key={i} className="flex justify-between text-sm">
            <span>{f.label}</span>
            <span className="tabular-nums text-accent-gold">+{f.points}</span>
          </li>
        ))}
        {factors.length === 0 && (
          <li className="text-sm text-muted-foreground">No factors recorded.</li>
        )}
      </ul>
    </Card>
  );
}
