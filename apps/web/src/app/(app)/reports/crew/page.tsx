import { listCrews } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/cockpit/PageHeader";

export const dynamic = "force-dynamic";

// D4-9: the crew productivity panel (spec §6e). Built to the frozen
// `crew.squares_per_day` contract (Appendix A.2) — Day 12 is what actually
// supplies `crew.hours.logged` / `job.completed` / `job.cost.actual` events;
// none of the three exist today, so every measurable column degrades to
// "awaiting crew app" (§7/§8: absence renders "—" with a reason, NEVER a
// silent 0 — a crew that logged 0 squares today and a crew nobody has heard
// from are different facts, and this panel must not conflate them).
//
// The row structure is real, not a placeholder: crews already exist
// (`crew`/`crew_member` tables, `listCrews`), so this lists the tenant's
// actual crews — the empty state is only in the measurable columns. That's
// deliberate: when Day 12 starts emitting the three events, this page needs
// zero changes — the columns just start resolving instead of degrading.

const AWAITING_REASON = "awaiting crew app";

function AwaitingCell() {
  return <span style={{ color: "var(--text-faint)" }}>— {AWAITING_REASON}</span>;
}

export default async function CrewPage() {
  const tenantId = await getTenantId();
  const crews = await listCrews(tenantId);
  const activeCrews = crews.filter((c) => c.active);
  const inactiveCrews = crews.filter((c) => !c.active);

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Reports" title="Crew productivity" />
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Built to the <span className="mono">crew.squares_per_day</span> contract. Day 12 supplies the
        <span className="mono"> crew.hours.logged</span> / <span className="mono">job.completed</span> /
        <span className="mono"> job.cost.actual</span> events this panel needs — none exist yet, so every measurable
        below shows &ldquo;{AWAITING_REASON}&rdquo; instead of a fabricated 0. The crew roster itself is real; only the
        numbers are pending.
      </p>

      <Card className="p-4" data-testid="crew-table">
        {activeCrews.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>No active crews on file yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="eyebrow text-left">
                <th className="py-1">Crew</th>
                <th>Members</th>
                <th>Squares / day</th>
                <th>Hours logged</th>
                <th>Jobs completed</th>
                <th>Cost (actual)</th>
              </tr>
            </thead>
            <tbody style={{ color: "var(--text-body)" }}>
              {activeCrews.map((crew) => (
                <tr key={crew.id} data-testid={`row-${crew.id}`}>
                  <td className="py-1">{crew.name}</td>
                  <td>
                    {crew.members.length === 0 ? (
                      <span style={{ color: "var(--text-faint)" }}>unstaffed</span>
                    ) : (
                      crew.members.map((m) => m.name).join(", ")
                    )}
                  </td>
                  <td><AwaitingCell /></td>
                  <td><AwaitingCell /></td>
                  <td><AwaitingCell /></td>
                  <td><AwaitingCell /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {inactiveCrews.length > 0 && (
        <p className="text-xs" style={{ color: "var(--text-faint)" }}>
          {inactiveCrews.length} inactive crew{inactiveCrews.length === 1 ? "" : "s"} on file, hidden from this view.
        </p>
      )}
    </div>
  );
}
