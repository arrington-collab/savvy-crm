import { Card } from "@/components/ui/card";
import { dueBoostCards } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";
import { BoostCardActions } from "./BoostCardActions";

// Phase 26 slice 2: Facebook boosts are MANUAL-TRIGGER by owner decision — no
// Meta API. The card hands over ready-to-post creative (street-level, photo
// only with consent) and records boosted/skipped so execution is provable.
export async function BoostCard() {
  const tenantId = await getTenantId();
  const due = await dueBoostCards(tenantId, new Date()).catch(() => []);
  if (due.length === 0) return null;

  return (
    <div className="space-y-3" data-testid="boost-cards">
      {due.map((b) => (
        <Card key={b.boostCardId} className="p-4" data-testid={`boost-${b.boostCardId}`}>
          <p className="font-medium" style={{ color: "var(--text-body)" }}>
            📣 Facebook boost ready — {b.kind === "day_before" ? "crew arrives tomorrow" : "crew on-site today"}
          </p>
          <p className="mono mt-2 rounded-md border p-3 text-[13px]" style={{ borderColor: "var(--border-panel)", color: "var(--text-muted)" }}
             data-testid="boost-copy">
            {b.copy}
          </p>
          <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
            {b.photoDocumentId ? "Job photo attached (customer consented)." : "Copy-only — no marketing consent on file for this job."}
            {" "}Post it on the company page, then record the outcome.
          </p>
          <BoostCardActions boostCardId={b.boostCardId} />
        </Card>
      ))}
    </div>
  );
}
