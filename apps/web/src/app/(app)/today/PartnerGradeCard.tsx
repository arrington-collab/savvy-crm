import Link from "next/link";
import { Card } from "@/components/ui/card";
import { pendingCDecisions } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";
import { PartnerGradeActions } from "./PartnerGradeActions";

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

// Partner Ledger slice 3: a C grade NEVER auto-terminates a relationship — it
// presents the numbers and three suggested actions. The human decides.
export async function PartnerGradeCard() {
  const tenantId = await getTenantId();
  const pending = await pendingCDecisions(tenantId).catch(() => []);
  if (pending.length === 0) return null;

  return (
    <div className="space-y-3" data-testid="partner-grade-cards">
      {pending.map((c) => (
        <Card key={c.partnerId} className="p-4" data-testid={`partner-grade-${c.partnerId}`}>
          <p className="font-medium" style={{ color: "var(--text-body)" }}>
            📉 <Link href={`/partners/${c.partnerId}`} className="underline">{c.name}{c.org ? ` (${c.org})` : ""}</Link>{" "}
            graded C — {c.sent} referral{c.sent === 1 ? "" : "s"}, zero wins, {usd(c.cost12moCents)} spent
            (net {usd(c.netCents)}) in 12 months.
          </p>
          <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
            Suggested: have the conversation · move their referrals to slack-capacity scheduling · offer the paid
            roof-cert lane (coming). Your call — the machine ranks, it never cuts anyone off.
          </p>
          <PartnerGradeActions partnerId={c.partnerId} />
        </Card>
      ))}
    </div>
  );
}
