import { resolveEstimateLink, getEstimatePageData } from "@savvy/db";
import { buildEstimatePageModel, parseEstimateConfig, type TierEstimate, type TierKey } from "@savvy/core";
import { EstimateTiers } from "./EstimateTiers";

export const dynamic = "force-dynamic";

// The customer-facing estimate page. Homeowner design family: LIGHT, warm,
// mobile-first — deliberately not the operator console aesthetic.
export default async function EstimatePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
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

        {/* Tier cards + color selector (client island) */}
        <EstimateTiers
          code={code}
          tiers={model.tiers}
          initialTier={(data.estimate.selectedTier as TierKey | null) ?? null}
          initialColor={data.estimate.selectedColor}
          warranties={warranties}
          expired={model.expired}
        />

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
