import { resolveEstimateLink, getEstimatePageData, videosForEstimate } from "@savvy/db";
import { buildEstimatePageModel, parseEstimateConfig, parseWhyUsConfig, whyUsConfigured, measurementAreasSchema, estimateTemplateVersion, buildInsurancePanel, INSURANCE_TEMPLATE_VERSION, type TierEstimate, type TierKey } from "@savvy/core";
import { AcceptFlow } from "./AcceptFlow";
import { PresentMode } from "./PresentMode";
import { QABox } from "./QABox";
import { VideoSlot } from "./VideoSlot";
import { EstimateTiers } from "./EstimateTiers";

export const dynamic = "force-dynamic";

// The customer-facing estimate page. Homeowner design family: LIGHT, warm,
// mobile-first — deliberately not the operator console aesthetic.
export default async function EstimatePage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ present?: string; v?: string }>;
}) {
  const { code } = await params;
  const { present, v } = await searchParams;
  const link = await resolveEstimateLink(code);
  const data = link ? await getEstimatePageData(link.tenantId, link.estimateId) : null;

  if (!link || !data) {
    return (
      <main className="mx-auto max-w-md p-8 text-center bg-white text-stone-800 min-h-screen" data-testid="estimate-invalid">
        <h1 className="text-xl font-semibold">Link unavailable</h1>
        <p className="mt-2 text-stone-500">This estimate link is invalid or expired. Please contact us.</p>
      </main>
    );
  }

  const cfg = parseEstimateConfig((data.settings as { estimate?: unknown } | null)?.estimate);
  const tiers = (data.estimate.tiers ?? []) as unknown as TierEstimate[];
  const palettes = Object.fromEntries(
    data.products.map((p) => [p.tier, p.colorPalette ?? []]),
  ) as Partial<Record<TierKey, { name: string; hex: string }[]>>;
  const warranties = Object.fromEntries(data.products.map((p) => [p.tier, p.warrantyText])) as Record<string, string>;

  const model = buildEstimatePageModel({
    companyName: data.companyName,
    customerName: data.customerName,
    address: data.property ? `${data.property.address}${data.property.city ? `, ${data.property.city}` : ""}` : null,
    sentAt: data.estimate.sentAt,
    createdAt: data.estimate.createdAt,
    now: new Date(),
    validityDays: cfg.validityDays,
    tiers,
    lineItemKeys: ((data.estimate.lineItems ?? []) as { key: string }[]).map((l) => l.key),
    licenses: data.licenses,
    palettes,
    financingEnabled: false, // financing seam dormant (#148) — toggle hidden by design
  });

  const whyUs = parseWhyUsConfig((data.settings as { whyUs?: unknown } | null)?.whyUs);

  // Slice 7: the insurance variant — no tiers, no monthly toggle; scope aligned
  // to the carrier claim, upgrades as out-of-pocket add-ons.
  const variant =
    data.estimate.templateVersion ??
    estimateTemplateVersion({ source: data.estimate.source, leadSource: data.leadSource });
  const insurancePanel =
    variant === INSURANCE_TEMPLATE_VERSION
      ? buildInsurancePanel({
          claim: data.claim,
          state: data.property?.state ?? null,
          upsells: (data.estimate.upsellSuggestions ?? []) as { name: string; reason: string; unitPriceCents: number; quantity: number }[],
        })
      : null;
  const isInsurance = variant === INSURANCE_TEMPLATE_VERSION;

  // Slice 5b: approved takes only — the rep's note above the tiers, the
  // owner's day-after word featured when the SMS link (?v=1) brought them here.
  const videos = await videosForEstimate(link.tenantId, link.estimateId);
  const repTake = videos.find((x) => x.role === "rep" && x.approvedAt);
  const ownerTake = videos.find((x) => x.role === "owner" && x.approvedAt);
  const featuredVideo = v && ownerTake ? ownerTake : null;

  // PRESENT MODE: the kitchen-table close — rep-launched, full screen, no chrome.
  if (present) {
    const areas = data.measurement ? measurementAreasSchema.partial().parse(data.measurement.areas ?? {}) : {};
    return (
      <PresentMode
        code={code}
        companyName={model.companyName}
        customerName={model.customerName}
        address={model.address}
        areas={areas}
        photoIds={data.photos.map((p) => p.id)}
        upsells={(data.estimate.upsellSuggestions ?? []) as { name: string; reason: string; unitPriceCents: number; quantity: number }[]}
        tiers={model.tiers}
        warranties={warranties}
        initialTier={(data.estimate.selectedTier as TierKey | null) ?? null}
        initialColor={data.estimate.selectedColor}
        expired={model.expired}
      />
    );
  }

  return (
    <main className="mx-auto max-w-2xl bg-white text-stone-800 min-h-screen" data-testid="estimate-page">
      <div className="p-6 space-y-8">
        {/* Hero */}
        <header className="space-y-1">
          <p className="text-sm text-stone-500">{model.companyName}</p>
          <h1 className="text-2xl font-semibold">Your roof estimate</h1>
          {model.customerName && <p className="text-stone-600">{model.customerName}</p>}
          {model.address && <p className="text-sm text-stone-500">{model.address}</p>}
        </header>

        {model.expired && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm" data-testid="estimate-expired">
            This estimate has expired — prices may have changed. Reply to our message or call us and
            we&apos;ll refresh it at current pricing.
          </div>
        )}

        {featuredVideo && (
          <VideoSlot code={code} documentId={featuredVideo.documentId} title="A quick word from our owner" featured />
        )}
        {repTake && !featuredVideo && (
          <VideoSlot code={code} documentId={repTake.documentId} title="From your inspection visit" featured={false} />
        )}

        {/* Retail: tier cards + colors. Insurance: claim-aligned scope + add-ons. */}
        {isInsurance ? (
          <section className="space-y-4" data-testid="insurance-scope">
            {insurancePanel && (
              <div className="space-y-1 rounded-xl border border-stone-200 p-4" data-testid="claim-panel">
                <p className="font-semibold">{insurancePanel.carrierLine}</p>
                {insurancePanel.claimLine && <p className="text-sm text-stone-500">{insurancePanel.claimLine}</p>}
                {insurancePanel.approvedLine && <p className="text-sm text-stone-600">{insurancePanel.approvedLine}</p>}
                {insurancePanel.deductibleLine && (
                  <p className="mt-2 rounded-lg bg-stone-50 p-3 text-sm text-stone-600" data-testid="deductible-line">
                    {insurancePanel.deductibleLine}
                  </p>
                )}
              </div>
            )}
            {insurancePanel && insurancePanel.addOns.length > 0 && (
              <div className="space-y-2" data-testid="insurance-addons">
                <h2 className="text-lg font-semibold">Worth adding while we&apos;re up there</h2>
                <p className="text-sm text-stone-500">Out-of-pocket upgrades — your call, no pressure:</p>
                <ul className="space-y-2">
                  {insurancePanel.addOns.map((a) => (
                    <li key={a.name} className="flex items-start justify-between gap-3 rounded-lg border border-stone-200 p-3">
                      <span>
                        <span className="block text-sm font-medium">{a.name}</span>
                        <span className="block text-xs text-stone-500">{a.reason}</span>
                      </span>
                      <span className="whitespace-nowrap text-sm font-semibold">
                        +{(a.totalCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <AcceptFlow code={code} tier={null} color={null} expired={model.expired} requireSelection={false} />
          </section>
        ) : (
          <EstimateTiers
            code={code}
            tiers={model.tiers}
            initialTier={(data.estimate.selectedTier as TierKey | null) ?? null}
            initialColor={data.estimate.selectedColor}
            warranties={warranties}
            expired={model.expired}
          />
        )}

        {/* What's included */}
        <section className="space-y-3" data-testid="estimate-included">
          <h2 className="text-lg font-semibold">Every option includes</h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {model.included.map((r) => (
              <li key={r.key} className="flex gap-3 rounded-lg border border-stone-200 p-3">
                <span aria-hidden className="text-xl">{r.icon}</span>
                <span>
                  <span className="block text-sm font-medium">{r.label}</span>
                  <span className="block text-xs text-stone-500">{r.blurb}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* Inspection photos (QC-passed only) */}
        {data.photos.length > 0 && (
          <section className="space-y-3" data-testid="estimate-photos">
            <h2 className="text-lg font-semibold">From your inspection</h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {data.photos.slice(0, 9).map((p) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={p.id}
                  src={`/api/estimate/${code}/photo/${p.id}`}
                  alt={p.label ?? "Inspection photo"}
                  className="aspect-square w-full rounded-lg object-cover"
                  loading="lazy"
                />
              ))}
            </div>
          </section>
        )}

        {/* Why Us — the owner's Library content block */}
        {whyUsConfigured(whyUs) && (
          <section className="space-y-3 rounded-xl bg-stone-50 p-5" data-testid="estimate-why-us">
            <h2 className="text-lg font-semibold">Why {model.companyName}</h2>
            {whyUs.story && <p className="text-sm text-stone-600">{whyUs.story}</p>}
            {whyUs.yearsLine && <p className="text-sm font-medium text-stone-700">{whyUs.yearsLine}</p>}
            {whyUs.workmanshipPromise && (
              <p className="text-sm text-stone-600 italic">&ldquo;{whyUs.workmanshipPromise}&rdquo;</p>
            )}
            {whyUs.timeline.length > 0 && (
              <ol className="space-y-1 text-sm text-stone-600">
                {whyUs.timeline.map((t, i) => (
                  <li key={i}>
                    {i + 1}. {t}
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}

        {/* Ask a question — grounded in this estimate only */}
        <QABox code={code} />

        {/* Trust strip */}
        <section className="rounded-lg bg-stone-50 p-4 text-sm text-stone-600" data-testid="estimate-trust">
          <p className="font-medium text-stone-700">Licensed & insured</p>
          <p>{model.trustLines.join(" · ")}</p>
        </section>

        {/* Validity */}
        <p className="text-sm text-stone-500" data-testid="estimate-validity">
          Price valid through{" "}
          {model.validUntil.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.
        </p>
      </div>
    </main>
  );
}
