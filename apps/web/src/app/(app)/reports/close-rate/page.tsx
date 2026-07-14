import { closeRateRows } from "@savvy/db";
import { closeRateReport } from "@savvy/core";
import { getTenantId } from "@/lib/tenant";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/cockpit/PageHeader";

export const dynamic = "force-dynamic";

const pct = (bps: number | null) => (bps == null ? "—" : `${(bps / 100).toFixed(1)}%`);

// Slice 7: the close-rate loop — sent/opened/accepted by template version and
// tier, plus the video personalized-vs-generic split. Rates activate at n≥20
// per version; below that the report says so instead of pretending.
export default async function CloseRatePage() {
  const tenantId = await getTenantId();
  const rows = await closeRateRows(tenantId);
  const report = closeRateReport(rows);

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Reports" title="Estimate close rates" />
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Last 90 days of sent estimates. Rates activate at 20 sent per template version — below that we show the count, not a guess.
      </p>

      <Card className="p-4" data-testid="close-rate-versions">
        <h2 className="eyebrow mb-2">By template version</h2>
        {report.versions.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>No estimates sent yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="eyebrow text-left"><th className="py-1">Version</th><th>Sent</th><th>Open rate</th><th>Close rate</th></tr>
            </thead>
            <tbody style={{ color: "var(--text-body)" }}>
              {report.versions.map((v) => (
                <tr key={v.version} data-testid={`version-${v.version}`}>
                  <td className="py-1">{v.version}</td>
                  <td>{v.n}</td>
                  <td>{v.active ? pct(v.openRateBps) : `insufficient data — n=${v.n}`}</td>
                  <td>{v.active ? pct(v.closeRateBps) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {report.tiers.length > 0 && (
        <Card className="p-4" data-testid="close-rate-tiers">
          <h2 className="eyebrow mb-2">By selected tier</h2>
          <table className="w-full text-sm">
            <thead><tr className="eyebrow text-left"><th className="py-1">Tier</th><th>Picked</th><th>Close rate</th></tr></thead>
            <tbody style={{ color: "var(--text-body)" }}>
              {report.tiers.map((t) => (
                <tr key={t.tier}><td className="py-1 capitalize">{t.tier}</td><td>{t.n}</td><td>{t.closeRateBps == null ? `insufficient data — n=${t.n}` : pct(t.closeRateBps)}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {(report.video.personalized || report.video.generic) && (
        <Card className="p-4" data-testid="close-rate-video">
          <h2 className="eyebrow mb-2">Owner video — the 10% hypothesis</h2>
          <p className="text-sm" style={{ color: "var(--text-body)" }}>
            Personalized: {report.video.personalized ? `${report.video.personalized.n} sent · close ${report.video.personalized.closeRateBps == null ? `insufficient data — n=${report.video.personalized.n}` : pct(report.video.personalized.closeRateBps)}` : "none yet"}
            {" · "}
            Generic: {report.video.generic ? `${report.video.generic.n} sent · close ${report.video.generic.closeRateBps == null ? `insufficient data — n=${report.video.generic.n}` : pct(report.video.generic.closeRateBps)}` : "none yet"}
          </p>
        </Card>
      )}
    </div>
  );
}
