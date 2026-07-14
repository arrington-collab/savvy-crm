import { Card } from "@/components/ui/card";
import { pendingMoveVerifications } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";
import { MoveVerificationActions } from "./MoveVerificationActions";

// Customer for Life slice 3: a below-threshold move signal never acts alone —
// it asks. Confirming runs both plays (new-address outreach + warranty-transfer
// offer to the old address's new owner).
export async function MoveVerificationCard() {
  const tenantId = await getTenantId();
  const pending = await pendingMoveVerifications(tenantId).catch(() => []);
  if (pending.length === 0) return null;

  return (
    <div className="space-y-3" data-testid="move-verification-cards">
      {pending.map((m) => (
        <Card key={m.moveEventId} className="p-4" data-testid={`move-verification-${m.moveEventId}`}>
          <p className="font-medium" style={{ color: "var(--text-body)" }}>
            📦 Did {m.customerName} move from {m.address}?
          </p>
          <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
            {m.signals.map((s) => s.kind.replace("_", " ")).join(" + ")} · confidence {m.confidence}%
            {m.newAddress ? ` · possible new address: ${m.newAddress}` : ""}
          </p>
          <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
            Confirming reaches out at the new place and offers the new owner the warranty transfer.
          </p>
          <MoveVerificationActions moveEventId={m.moveEventId} newAddress={m.newAddress} />
        </Card>
      ))}
    </div>
  );
}
