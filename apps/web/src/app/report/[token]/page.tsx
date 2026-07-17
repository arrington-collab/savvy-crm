import { getVisitReport } from "@savvy/db";

export const dynamic = "force-dynamic";

// The homeowner visit report (#308) — the renewal driver. Homeowner design
// family like the estimate page: light, warm, mobile-first. The token is the
// capability; nothing renders without it.

const SCORE_COPY: Record<string, { title: string; tone: string }> = {
  good: { title: "Your roof is in good shape", tone: "text-emerald-700" },
  watch: { title: "Your roof is healthy, with a few things we're watching", tone: "text-amber-700" },
  needs_attention: { title: "A few items on your roof need attention", tone: "text-red-700" },
  ungraded: { title: "Your visit summary", tone: "text-stone-700" },
};

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export default async function VisitReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const report = await getVisitReport(token);

  if (!report) {
    return (
      <main className="mx-auto max-w-md p-8 text-center bg-white text-stone-800 min-h-screen" data-testid="report-invalid">
        <h1 className="text-xl font-semibold">Link unavailable</h1>
        <p className="mt-2 text-stone-500">This report link is invalid. Please contact us for a fresh one.</p>
      </main>
    );
  }

  const score = SCORE_COPY[report.score.label] ?? SCORE_COPY.ungraded!;
  return (
    <main className="mx-auto max-w-2xl bg-white p-6 text-stone-800 min-h-screen" data-testid="visit-report-page">
      <p className="text-sm text-stone-500">{report.tenantName} · Annual maintenance visit</p>
      <h1 className={`mt-1 text-2xl font-semibold ${score.tone}`} data-testid="report-score">{score.title}</h1>
      {report.completedAt && (
        <p className="mt-1 text-sm text-stone-500">
          Visited {new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(report.completedAt)}
        </p>
      )}

      {report.narrative && (
        <p className="mt-5 leading-relaxed text-stone-700" data-testid="report-narrative">{report.narrative}</p>
      )}

      <section className="mt-6" data-testid="report-zones">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">What we checked</h2>
        <ul className="mt-2 divide-y divide-stone-100">
          {report.zones.map((z) => (
            <li key={z.zoneLabel} className="flex items-center justify-between py-2">
              <span>{z.zoneLabel}</span>
              <span className="text-sm text-stone-500">
                {z.photoCount > 0 ? `${z.photoCount} photo${z.photoCount === 1 ? "" : "s"} · ` : ""}
                {z.grade === "good" ? "✓ good" : z.grade === "monitor" ? "watching" : z.grade === "action" ? "needs attention" : "—"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {report.repairQuotes.length > 0 && (
        <section className="mt-6" data-testid="report-quotes">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Small repairs we&apos;d suggest</h2>
          <ul className="mt-2 space-y-3">
            {report.repairQuotes.map((q, i) => (
              <li key={i} className="rounded-lg border border-stone-200 p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{q.whatItIs}</span>
                  <span className="shrink-0 font-semibold">{usd(q.repairEstimateCents)}</span>
                </div>
                {q.ifIgnored && <p className="mt-1 text-sm text-stone-500">If left alone: {q.ifIgnored}</p>}
                {q.timeframe && <p className="mt-0.5 text-sm text-stone-500">Timeframe: {q.timeframe}</p>}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-stone-500">No pressure — these are member-priced and yours to schedule whenever suits.</p>
        </section>
      )}

      <p className="mt-8 text-xs text-stone-400">Part of your annual maintenance membership. Reply to our text or call anytime.</p>
    </main>
  );
}
