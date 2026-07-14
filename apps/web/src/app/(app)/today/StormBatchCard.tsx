import { Card } from "@/components/ui/card";
import { listOpenStormBatches } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";
import { StormBatchActions } from "./StormBatchActions";

// Roof Record slice 4: ONE card per verified storm event over baselined roofs.
// The owner approves the batch → NOVA sends the re-inspection outreach
// (service framing — "checking your roof against its baseline").
export async function StormBatchCard() {
  const tenantId = await getTenantId();
  const batches = await listOpenStormBatches(tenantId).catch(() => []);
  if (batches.length === 0) return null;

  return (
    <div className="space-y-3" data-testid="storm-batch-cards">
      {batches.map((b) => {
        const props = b.properties as { address: string }[];
        const mag = b.kind === "hail"
          ? `${(b.meta as { size?: number | null }).size ?? "?"}″ hail`
          : `${(b.meta as { windMph?: number | null }).windMph ?? "?"} mph wind`;
        return (
          <Card key={b.id} className="p-4" data-testid={`storm-batch-${b.id}`}>
            <p className="font-medium" style={{ color: "var(--text-body)" }}>
              ⛈️ Verified {mag} on {b.eventDate} — {props.length} baselined roof{props.length === 1 ? "" : "s"} in the path
            </p>
            <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
              {props.slice(0, 3).map((p) => p.address).join(" · ")}{props.length > 3 ? ` · +${props.length - 3} more` : ""}
            </p>
            <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
              Approving sends the check-against-your-baseline offer. Service framing, no sales copy.
            </p>
            <StormBatchActions batchId={b.id} status={b.status} />
          </Card>
        );
      })}
    </div>
  );
}
