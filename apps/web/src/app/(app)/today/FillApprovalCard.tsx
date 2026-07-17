import { Card } from "@/components/ui/card";
import { pendingFillApprovals } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";
import { FillApprovalActions } from "./FillApprovalActions";

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

// Phase 26 S5/S6: an over-threshold fill discount never sends silently — it
// asks. Approval still rides the governor (opt-outs and the cap hold).
export async function FillApprovalCard() {
  const tenantId = await getTenantId();
  const pending = await pendingFillApprovals(tenantId).catch(() => []);
  if (pending.length === 0) return null;

  return (
    <div className="space-y-3" data-testid="fill-approval-cards">
      {pending.map((p) => (
        <Card key={p.playId} className="p-4" data-testid={`fill-approval-${p.playId}`}>
          <p className="font-medium" style={{ color: "var(--text-body)" }}>
            🔧 Slow-week discount needs approval — {((p.discountBps ?? 0) / 100).toFixed(1)}% off
            {p.originalTotalCents != null && p.discountedTotalCents != null
              ? ` (${usd(p.originalTotalCents)} → ${usd(p.discountedTotalCents)})`
              : ""}
          </p>
          <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
            The configured incentive is above the auto-approve cap. Approving texts the
            homeowner a this-week offer (opt-outs and the touch cap still apply).
          </p>
          <FillApprovalActions playId={p.playId} />
        </Card>
      ))}
    </div>
  );
}
