import { Card } from "@/components/ui/card";
import { listPartnerMergeCandidates } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";
import { PartnerMergeActions } from "./PartnerMergeActions";

// Partner Ledger slice 1: the backfill/create-once flow proposes merges when the
// same folded name shows up at different orgs — a human decides; the machine
// never silently merges distinct people.
export async function PartnerMergeCard() {
  const tenantId = await getTenantId();
  const pending = await listPartnerMergeCandidates(tenantId).catch(() => []);
  if (pending.length === 0) return null;

  return (
    <div className="space-y-3" data-testid="partner-merge-cards">
      {pending.map((c) => (
        <Card key={c.id} className="p-4" data-testid={`partner-merge-${c.id}`}>
          <p className="font-medium" style={{ color: "var(--text-body)" }}>
            🤝 Same partner? {c.partnerA.name}
            {c.partnerA.org ? ` (${c.partnerA.org})` : ""} vs {c.partnerB.name}
            {c.partnerB.org ? ` (${c.partnerB.org})` : ""}
          </p>
          <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>{c.reason}</p>
          <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
            Merging keeps “{c.partnerA.name}{c.partnerA.org ? ` — ${c.partnerA.org}` : ""}” and moves the other’s leads onto it.
          </p>
          <PartnerMergeActions candidateId={c.id} />
        </Card>
      ))}
    </div>
  );
}
