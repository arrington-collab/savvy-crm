import { Card } from "@/components/ui/card";
import { pendingBlitzApprovals } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";
import { BlitzApprovalActions } from "./BlitzApprovalActions";

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

// Phase 26 slice 1: an over-cap or oversized blitz plan never sends silently —
// it asks. Approving releases the plan (pieces stay print_pending until a
// print provider is connected; nothing mails from this card today).
export async function BlitzApprovalCard() {
  const tenantId = await getTenantId();
  const pending = await pendingBlitzApprovals(tenantId).catch(() => []);
  if (pending.length === 0) return null;

  return (
    <div className="space-y-3" data-testid="blitz-approval-cards">
      {pending.map((b) => (
        <Card key={b.campaignId} className="p-4" data-testid={`blitz-approval-${b.campaignId}`}>
          <p className="font-medium" style={{ color: "var(--text-body)" }}>
            📬 Mobilization blitz needs approval — {b.audienceCount} homes, {usd(b.estCostCents)}
          </p>
          <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
            Over the per-job cap or above the audience limit. Approving queues the postcards
            (they print once a mail provider is connected).
          </p>
          <BlitzApprovalActions campaignId={b.campaignId} />
        </Card>
      ))}
    </div>
  );
}
