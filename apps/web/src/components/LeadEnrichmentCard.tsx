import { Card } from "@/components/ui/card";
import { formatCountyLabel } from "@savvy/core";

type Factor = { label: string; points: number };

export function LeadEnrichmentCard({
  scoreFeatures,
  yearBuilt,
  roofType,
  county,
  installRecommendation,
}: {
  scoreFeatures: { factors?: Factor[]; baseline?: number } | null;
  yearBuilt: number | null;
  roofType: string | null;
  county: string | null;
  installRecommendation: { windRating: string; impactResistance: string; suggestedProducts: string[]; rationale: string } | null;
}) {
  const factors = scoreFeatures?.factors ?? [];

  return (
    <Card className="p-4 space-y-3" data-testid="lead-enrichment-card">
      <h3 className="text-sm font-semibold">Why this score</h3>
      <div className="text-xs text-muted-foreground">
        {[yearBuilt && `Built ${yearBuilt}`, roofType, formatCountyLabel(county)]
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
      {installRecommendation && installRecommendation.suggestedProducts.length > 0 && (
        <div className="space-y-1" data-testid="install-recommendation">
          <h3 className="text-sm font-semibold">Suggested install / upsell</h3>
          <div className="flex flex-wrap gap-1">
            {installRecommendation.suggestedProducts.map((p, i) => (
              <span key={i} className="rounded bg-accent-gold/15 px-2 py-0.5 text-xs">{p}</span>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{installRecommendation.rationale}</p>
        </div>
      )}
    </Card>
  );
}
