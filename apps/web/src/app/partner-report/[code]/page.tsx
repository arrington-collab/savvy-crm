import { resolvePartnerReportLink, getPartnerReportPageData } from "@savvy/db";

export const dynamic = "force-dynamic";

/**
 * The partner-facing quarterly summary. Thank-you framing, honest outcomes,
 * ZERO shame mechanics: no grades, no costs, no rankings — just what they
 * sent, what happened to it, and gratitude. The internal economics live at
 * /partners/quarterly, never here.
 */
export default async function PartnerReportPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const link = await resolvePartnerReportLink(code);
  const data = link ? await getPartnerReportPageData(link.tenantId, link.reportId) : null;

  if (!link || !data) {
    return (
      <main className="mx-auto min-h-screen max-w-md bg-white p-8 text-center text-stone-800" data-testid="partner-report-invalid">
        <h1 className="text-xl font-semibold">Report unavailable</h1>
        <p className="mt-2 text-stone-500">This link isn&apos;t ready yet. Please contact us.</p>
      </main>
    );
  }

  const p = data.payload;
  const outcomes: Array<{ n: number; label: string }> = [
    { n: p.sent, label: p.sent === 1 ? "referral you sent us" : "referrals you sent us" },
    { n: p.inspected, label: "inspected" },
    { n: p.won, label: p.won === 1 ? "became a project" : "became projects" },
    ...(p.certsDelivered > 0 ? [{ n: p.certsDelivered, label: p.certsDelivered === 1 ? "roof certification delivered" : "roof certifications delivered" }] : []),
  ];

  return (
    <main className="min-h-screen bg-gradient-to-b from-amber-50/60 via-white to-white text-stone-800" data-testid="partner-report-page">
      <div className="mx-auto max-w-xl px-6 pb-16 pt-14">
        <header className="text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700/70">{data.companyName}</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            Thank you, {data.partnerName.split(/\s+/)[0]}
          </h1>
          <p className="mt-1 text-sm text-stone-500" data-testid="partner-report-quarter">
            Your {data.quarterKey} partnership summary
          </p>
        </header>

        <section className="mt-10 space-y-3" data-testid="partner-report-outcomes">
          {outcomes.map((o) => (
            <div key={o.label} className="flex items-baseline gap-4 rounded-xl border border-stone-200 bg-white p-4">
              <span className="text-3xl font-semibold tabular-nums text-amber-700">{o.n}</span>
              <span className="text-stone-600">{o.label}</span>
            </div>
          ))}
        </section>

        <section className="mt-10 text-center text-sm leading-relaxed text-stone-600">
          {p.sent === 0 && p.certsDelivered === 0 ? (
            <p>A quiet quarter — we&apos;re here whenever your clients need a roof looked at.</p>
          ) : (
            <p>
              Every one of these got a real inspection and an honest answer — that&apos;s the promise behind
              every referral you make. Thank you for trusting us with your clients.
            </p>
          )}
          <p className="mt-3 font-medium text-stone-700">— The {data.companyName} team</p>
        </section>
      </div>
    </main>
  );
}
