import { resolveRecordLink, getRecordPageData, getRecordComparison, ensureEstimateLink } from "@savvy/db";
import { RecordHero } from "./RecordHero";
import { ZoneExplorer } from "./ZoneExplorer";

export const dynamic = "force-dynamic";

const FRIEND_PHRASE = "anything we'd do for a friend or neighbor is free";

function money(cents: number | null): string {
  if (cents == null) return "";
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/**
 * The Roof Record — the homeowner's permanent, zone-mapped asset. Design brief:
 * home-inspection-meets-Apple-Health. Light, warm, generous whitespace, the
 * roof diagram is the hero. NOT a contractor report: an ACTION grade is
 * impossible without evidence, "your roof is fine" is a first-class outcome,
 * and there are no sales CTAs beyond the honest suggestions.
 */
export default async function RecordPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const link = await resolveRecordLink(code);
  const data = link ? await getRecordPageData({ tenantId: link.tenantId, inspectionId: link.inspectionId }) : null;

  if (!link || !data) {
    return (
      <main className="mx-auto min-h-screen max-w-md bg-white p-8 text-center text-stone-800" data-testid="record-invalid">
        <h1 className="text-xl font-semibold">Record unavailable</h1>
        <p className="mt-2 text-stone-500">This Roof Record link isn&apos;t ready yet. Please contact us.</p>
      </main>
    );
  }

  const estimateLink = data.estimateId
    ? await ensureEstimateLink({ tenantId: link.tenantId, estimateId: data.estimateId })
    : null;
  const comparison = await getRecordComparison({ tenantId: link.tenantId, inspectionId: link.inspectionId });
  const publishedYear = data.publishedAt.getFullYear();
  const publishedMonth = data.publishedAt.toLocaleDateString(undefined, { month: "long", year: "numeric", day: "numeric" });

  return (
    <main className="min-h-screen bg-gradient-to-b from-amber-50/60 via-white to-white text-stone-800" data-testid="record-page">
      <div className="mx-auto max-w-2xl px-5 pb-16 pt-10 sm:pt-14">

        {/* 1 — HERO: their roof, zone by zone */}
        <header className="text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700/70">{data.companyName}</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Your Roof Record</h1>
          <p className="mt-1 text-sm text-stone-500" data-testid="record-address">{data.address}</p>
          <p className="mt-0.5 text-xs text-stone-400">
            Inspected {publishedMonth}{data.inspectorFirstName ? ` by ${data.inspectorFirstName}` : ""}
          </p>
        </header>
        <section className="mt-8">
          <RecordHero sketch={data.sketch} zones={data.zones} />
        </section>

        {/* 3 — THE HEALTHY-ROOF RENDERING: a designed outcome, not an empty state */}
        {data.healthy ? (
          <section className="mt-10 rounded-3xl bg-emerald-50 px-6 py-10 text-center ring-1 ring-emerald-100" data-testid="healthy-roof">
            <div aria-hidden className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-2xl">☀️</div>
            <h2 className="mt-4 text-xl font-semibold text-emerald-900">Healthy roof.</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-emerald-800/80">
              Every zone we inspected looks the way it should. Next check: after the next major storm, or around {publishedYear + 2}.
            </p>
          </section>
        ) : null}

        {/* whole-roof narrative — the inspector-approved story */}
        {data.narrative ? (
          <section className="mt-10" data-testid="record-narrative">
            <p className="text-base leading-relaxed text-stone-600">{data.narrative}</p>
          </section>
        ) : null}

        {/* 2 — ZONE EXPLORER */}
        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-400">Zone by zone</h2>
          <div className="mt-3">
            <ZoneExplorer zones={data.zones} code={code} />
          </div>
        </section>

        {/* 4 — FREE REPAIRS DONE TODAY: the friend rule, verbatim */}
        {data.freeRepairs.length > 0 ? (
          <section className="mt-10 rounded-3xl bg-sky-50 p-6 ring-1 ring-sky-100" data-testid="free-repairs">
            <h2 className="text-base font-semibold text-sky-900">Fixed free, today</h2>
            <p className="mt-1 text-sm italic text-sky-800/80">&ldquo;{FRIEND_PHRASE}&rdquo;</p>
            <ul className="mt-4 space-y-2">
              {data.freeRepairs.map((f) => (
                <li key={f.id} className="flex items-start gap-2 text-sm text-sky-900" data-testid={`free-repair-${f.id}`}>
                  <span aria-hidden className="mt-0.5 text-sky-500">✓</span>
                  <span>{f.whatItIs}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* 5 — SUGGESTIONS: honest timeframes; replacement ONLY with replacement factors */}
        {data.suggestions.length > 0 ? (
          <section className="mt-10" data-testid="suggestions">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-400">Suggestions</h2>
            <ul className="mt-3 space-y-3">
              {data.suggestions.map((s) => (
                <li key={s.id} className="rounded-2xl bg-white p-4 ring-1 ring-stone-200" data-testid={`suggestion-${s.id}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-stone-800">{s.whatItIs}</p>
                      {s.timeframe ? <p className="mt-1 text-xs text-stone-400">{s.timeframe}</p> : null}
                    </div>
                    {s.repairEstimateCents != null ? (
                      <p className="shrink-0 text-sm font-semibold text-stone-700">{money(s.repairEstimateCents)}</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs leading-relaxed text-stone-400" data-testid="credit-terms">
              Any repair you pay for becomes a credit applied toward a replacement within 3 years.
            </p>
            {data.replacementDiscussion ? (
              <p className="mt-3 rounded-2xl bg-stone-50 p-4 text-sm leading-relaxed text-stone-600" data-testid="replacement-discussion">
                Some of what we found points toward replacement being the economical path over time.
                No urgency from our side — when you want to talk it through, we&apos;ll walk you through the numbers honestly.
              </p>
            ) : null}
          </section>
        ) : null}

        {/* before/after vs the baseline — the claim-evidence view (slice 4) */}
        {comparison ? (
          <section className="mt-10" data-testid="baseline-comparison">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-400">
              Compared with your {comparison.baselineAt.toLocaleDateString(undefined, { month: "long", year: "numeric" })} baseline
            </h2>
            <ul className="mt-3 space-y-2">
              {comparison.zones.map((z) => (
                <li key={z.zoneKey} className="rounded-2xl bg-white p-4 ring-1 ring-stone-200" data-testid={`compare-${z.zoneKey}`}>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-stone-800">{z.zoneLabel}</p>
                    <p className="text-xs">
                      <span className="text-stone-400">{z.beforeGrade ?? "—"}</span>
                      <span aria-hidden className="mx-1.5 text-stone-300">→</span>
                      <span className={z.changed ? "font-semibold text-rose-600" : "text-stone-500"}>{z.afterGrade ?? "—"}</span>
                    </p>
                  </div>
                  {(z.beforePhotos.length > 0 || z.afterPhotos.length > 0) ? (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <div>
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-stone-400">Baseline</p>
                        {z.beforePhotos.slice(0, 1).map((ph) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={ph.documentId} src={`/api/record/${code}/photo/${ph.documentId}`} alt={`${z.zoneLabel} baseline`} loading="lazy" className="aspect-video w-full rounded-lg object-cover ring-1 ring-stone-200" />
                        ))}
                      </div>
                      <div>
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-stone-400">Now</p>
                        {z.afterPhotos.slice(0, 1).map((ph) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={ph.documentId} src={`/api/record/${code}/photo/${ph.documentId}`} alt={`${z.zoneLabel} now`} loading="lazy" className="aspect-video w-full rounded-lg object-cover ring-1 ring-stone-200" />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* 6 — AGE + BASELINE: the moat sentence */}
        <section className="mt-10 rounded-3xl bg-stone-50 p-6 ring-1 ring-stone-100" data-testid="age-baseline">
          {data.ageRange ? (
            <p className="text-sm text-stone-600" data-testid="age-range">
              Roof age: <span className="font-semibold text-stone-800">~{data.ageRange.minYears}–{data.ageRange.maxYears} years</span>
              <span className="text-stone-400"> — {data.ageRange.source}</span>
            </p>
          ) : (
            <p className="text-sm text-stone-500" data-testid="age-unknown">Roof age: to be confirmed — we&apos;ll verify it against records on our next visit.</p>
          )}
          <p className="mt-3 text-sm leading-relaxed text-stone-600" data-testid="baseline-statement">
            This record documents your roof&apos;s condition as of{" "}
            <span className="font-medium text-stone-800">{publishedMonth}</span>. If a storm ever hits, this baseline protects your claim.
          </p>
        </section>

        {/* link to the estimate when one exists — the Record is not the estimate */}
        {estimateLink ? (
          <p className="mt-8 text-center text-sm">
            <a href={`/estimate/${estimateLink.code}`} className="font-medium text-amber-700 underline decoration-amber-300 underline-offset-4" data-testid="estimate-link">
              View your estimate
            </a>
          </p>
        ) : null}

        {/* 7 — footer: license strip, quiet why-us; NO sales CTAs */}
        <footer className="mt-14 border-t border-stone-100 pt-6 text-center">
          <p className="text-xs text-stone-400">{data.companyName}</p>
          {data.licenses.length > 0 ? (
            <p className="mt-1 text-[11px] text-stone-300" data-testid="license-strip">
              {data.licenses.map((l) => `${l.state} #${l.licenseNumber}`).join(" · ")}
            </p>
          ) : null}
          <p className="mt-2 text-[11px] text-stone-300">Questions? Reply to any message from us — the owner reads them.</p>
        </footer>
      </div>
    </main>
  );
}
