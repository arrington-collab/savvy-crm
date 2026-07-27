import { listQueue } from "@savvy/db";
import { groupActiveByOwnerAndAge, QUEUE_AGE_BUCKETS, type QueueAgeBucket } from "@savvy/command-center";
import { getTenantId } from "@/lib/tenant";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/cockpit/PageHeader";

export const dynamic = "force-dynamic";

// D4-9: the accountability panel (spec §6f) — "what's aging on someone else's
// plate." Reads the same `exception_queue` Day 2/3 already write to
// (`listQueue`), filters to ACTIVE items (open, or a snooze whose time has
// passed) and groups by primary owner + age via `groupActiveByOwnerAndAge`
// (@savvy/command-center, pure, unit-tested) — which itself reuses Day 2's
// `isActive` rather than reinventing open/snoozed lifecycle rules. Owners are
// sorted worst-aging-first: whoever is sitting on the single oldest active
// item leads the panel.

const AGE_BUCKET_LABEL: Record<QueueAgeBucket, string> = {
  "0-1d": "0–1 day",
  "2-3d": "2–3 days",
  "4-7d": "4–7 days",
  "8d+": "8+ days",
};

export default async function AccountabilityPage() {
  const tenantId = await getTenantId();
  const queue = await listQueue(tenantId);
  const now = new Date();
  const groups = groupActiveByOwnerAndAge(queue, now);
  const totalActive = groups.reduce((sum, g) => sum + g.total, 0);

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Reports" title="Accountability" />
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        {totalActive} open exception{totalActive === 1 ? "" : "s"} across {groups.length} owner
        {groups.length === 1 ? "" : "s"}, as of {now.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.
        Acknowledged and resolved items aren&rsquo;t shown — only what still needs someone&rsquo;s attention. Owners
        holding the oldest item are listed first.
      </p>

      <Card className="p-4" data-testid="accountability-table">
        {groups.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>No open exceptions right now.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="eyebrow text-left">
                <th className="py-1">Owner</th>
                <th>Open</th>
                {QUEUE_AGE_BUCKETS.map((bucket) => (
                  <th key={bucket}>{AGE_BUCKET_LABEL[bucket]}</th>
                ))}
                <th>Oldest</th>
              </tr>
            </thead>
            <tbody style={{ color: "var(--text-body)" }}>
              {groups.map((group) => (
                <tr key={group.owner} data-testid={`row-${group.owner}`}>
                  <td className="py-1">{group.owner}</td>
                  <td>{group.total}</td>
                  {QUEUE_AGE_BUCKETS.map((bucket) => {
                    const items = group.byAge[bucket];
                    return (
                      <td key={bucket}>
                        {items.length === 0 ? (
                          <span style={{ color: "var(--text-faint)" }}>—</span>
                        ) : (
                          items.length
                        )}
                      </td>
                    );
                  })}
                  <td>{Math.floor(group.oldestDays)}d</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
