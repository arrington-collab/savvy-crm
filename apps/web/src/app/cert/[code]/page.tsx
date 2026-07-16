import { resolveCertLink, getCertPageData } from "@savvy/db";

export const dynamic = "force-dynamic";

const GRADE_LABEL: Record<string, string> = { good: "Good", monitor: "Monitor", action: "Needs attention" };
const GRADE_STYLE: Record<string, string> = {
  good: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  monitor: "bg-amber-50 text-amber-700 ring-amber-200",
  action: "bg-rose-50 text-rose-700 ring-rose-200",
};

/**
 * The paid roof certification — an evidentiary condition report for a real
 * estate transaction. Deliberately NOT the Roof Record: no free-repair
 * framing, no suggestions, no estimate links, no sales language of any kind.
 * Condition, age, photos, licenses. That's the product.
 */
export default async function CertPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const link = await resolveCertLink(code);
  const data = link ? await getCertPageData(link.tenantId, link.certRequestId) : null;

  if (!link || !data) {
    return (
      <main className="mx-auto min-h-screen max-w-md bg-white p-8 text-center text-stone-800" data-testid="cert-invalid">
        <h1 className="text-xl font-semibold">Certification unavailable</h1>
        <p className="mt-2 text-stone-500">This roof certification link isn&apos;t ready yet. Please contact us.</p>
      </main>
    );
  }

  const deliveredOn = data.deliveredAt.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });

  return (
    <main className="min-h-screen bg-white text-stone-800 print:bg-white" data-testid="cert-page">
      <div className="mx-auto max-w-2xl px-6 pb-16 pt-12">
        <header className="border-b border-stone-200 pb-6 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">{data.companyName}</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Roof Certification</h1>
          <p className="mt-1 text-sm text-stone-500" data-testid="cert-address">{data.address}</p>
          <p className="mt-0.5 text-xs text-stone-400">
            Inspected{data.inspectorFirstName ? ` by ${data.inspectorFirstName}` : ""} · Delivered {deliveredOn}
          </p>
          {data.ageRange && (
            <p className="mt-3 inline-block rounded-full bg-stone-100 px-3 py-1 text-sm" data-testid="cert-age-range">
              Estimated roof age: {data.ageRange.minYears === data.ageRange.maxYears
                ? `${data.ageRange.minYears} years`
                : `${data.ageRange.minYears}–${data.ageRange.maxYears} years`}
            </p>
          )}
        </header>

        {data.narrative && (
          <section className="mt-8">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Condition summary</h2>
            <p className="mt-2 leading-relaxed text-stone-700" data-testid="cert-narrative">{data.narrative}</p>
          </section>
        )}

        {data.zones.length > 0 && (
          <section className="mt-8" data-testid="cert-zones">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Zone-by-zone condition</h2>
            <div className="mt-3 space-y-4">
              {data.zones.map((z) => (
                <div key={z.zoneKey} className="rounded-xl border border-stone-200 p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{z.zoneLabel}</span>
                    {z.grade && (
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${GRADE_STYLE[z.grade] ?? "bg-stone-100 text-stone-600 ring-stone-200"}`}>
                        {GRADE_LABEL[z.grade] ?? z.grade}
                      </span>
                    )}
                  </div>
                  {z.summary && <p className="mt-1.5 text-sm text-stone-600">{z.summary}</p>}
                  {z.photos.length > 0 && (
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {z.photos.map((p) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={p.documentId} src={`/api/cert/${code}/photo/${p.documentId}`}
                             alt={`${z.zoneLabel} condition photo`} loading="lazy"
                             className="aspect-video w-full rounded-lg object-cover ring-1 ring-stone-200" />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {data.conditionNotes.length > 0 && (
          <section className="mt-8" data-testid="cert-condition-notes">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Documented conditions</h2>
            <ul className="mt-3 space-y-2">
              {data.conditionNotes.map((n, i) => (
                <li key={i} className="rounded-lg bg-stone-50 p-3 text-sm">
                  <span className="font-medium">{n.whatItIs}</span>
                  {n.ifIgnored && <span className="text-stone-600"> — if unaddressed: {n.ifIgnored}</span>}
                  {n.timeframe && <span className="text-stone-500"> ({n.timeframe})</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="mt-10 border-t border-stone-200 pt-4 text-center text-xs text-stone-400">
          {data.licenses.length > 0 && (
            <p data-testid="cert-licenses">
              {data.licenses.map((l) => `${l.state} License ${l.licenseNumber}`).join(" · ")}
            </p>
          )}
          <p className="mt-1">
            This certification documents observed roof condition as of the inspection date. It is not a warranty.
          </p>
        </footer>
      </div>
    </main>
  );
}
