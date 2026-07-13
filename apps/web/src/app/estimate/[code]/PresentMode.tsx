"use client";
import { useState } from "react";
import type { EstimatePageTier } from "@savvy/core";
import { EstimateTiers } from "./EstimateTiers";

type Areas = { squares?: number; predominantPitch?: string; facetCount?: number; ridgeLf?: number; valleyLf?: number };
type Upsell = { name: string; reason: string; unitPriceCents: number; quantity: number };

const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

// Slice 5: PRESENT MODE — the kitchen-table close. Full screen, no chrome,
// tap targets sized for a tablet across the table. The rep drives; the
// walkthrough follows the owner's close sequence: roof → suggestions →
// options/colors/close (the accept flow rides the options slide).
export function PresentMode({
  code,
  companyName,
  customerName,
  address,
  areas,
  photoIds,
  upsells,
  tiers,
  warranties,
  initialTier,
  initialColor,
  expired,
}: {
  code: string;
  companyName: string;
  customerName: string | null;
  address: string | null;
  areas: Areas;
  photoIds: string[];
  upsells: Upsell[];
  tiers: EstimatePageTier[];
  warranties: Record<string, string>;
  initialTier: EstimatePageTier["tier"] | null;
  initialColor: string | null;
  expired: boolean;
}) {
  const [step, setStep] = useState(0);
  const steps = ["Your roof", "What we'd do", "Your options"];

  return (
    <main className="fixed inset-0 z-50 flex flex-col bg-white text-stone-800" data-testid="present-mode">
      {/* Top bar: step dots + exit */}
      <header className="flex items-center justify-between border-b border-stone-100 px-6 py-4">
        <div className="flex items-center gap-2" data-testid="present-steps">
          {steps.map((label, i) => (
            <button
              key={label}
              onClick={() => setStep(i)}
              className={`rounded-full px-4 py-2 text-sm font-medium ${
                i === step ? "bg-stone-900 text-white" : "bg-stone-100 text-stone-500"
              }`}
              data-testid={`present-step-${i}`}
            >
              {label}
            </button>
          ))}
        </div>
        <a href={`/estimate/${code}`} className="text-sm text-stone-400 underline" data-testid="present-exit">
          Exit
        </a>
      </header>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        {step === 0 && (
          <section className="mx-auto max-w-3xl space-y-6" data-testid="present-roof">
            <div>
              <p className="text-sm text-stone-400">{companyName}</p>
              <h1 className="text-4xl font-semibold">{customerName ?? "Your"} roof</h1>
              {address && <p className="mt-1 text-lg text-stone-500">{address}</p>}
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {[
                { label: "Roof size", value: areas.squares ? `${areas.squares} squares` : "—" },
                { label: "Pitch", value: areas.predominantPitch ?? "—" },
                { label: "Roof planes", value: areas.facetCount ? String(areas.facetCount) : "—" },
                { label: "Valleys", value: areas.valleyLf ? `${areas.valleyLf} ft` : "None" },
              ].map((s) => (
                <div key={s.label} className="rounded-xl border border-stone-200 p-4">
                  <p className="text-xs uppercase tracking-wide text-stone-400">{s.label}</p>
                  <p className="mt-1 text-2xl font-semibold">{s.value}</p>
                </div>
              ))}
            </div>
            {photoIds.length > 0 && (
              <div className="grid grid-cols-3 gap-3">
                {photoIds.slice(0, 6).map((id) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={id} src={`/api/estimate/${code}/photo/${id}`} alt="Inspection" className="aspect-video w-full rounded-xl object-cover" />
                ))}
              </div>
            )}
          </section>
        )}

        {step === 1 && (
          <section className="mx-auto max-w-3xl space-y-4" data-testid="present-suggestions">
            <h1 className="text-4xl font-semibold">What we&apos;d do</h1>
            <p className="text-lg text-stone-500">Beyond the essentials, here&apos;s what your roof would benefit from:</p>
            {upsells.length === 0 ? (
              <p className="rounded-xl border border-stone-200 p-6 text-lg text-stone-600">
                Your roof needs the full system done right — no extras required. That&apos;s good news.
              </p>
            ) : (
              <ul className="space-y-3">
                {upsells.map((u) => (
                  <li key={u.name} className="flex items-start justify-between gap-4 rounded-xl border border-stone-200 p-5">
                    <div>
                      <p className="text-xl font-medium">{u.name}</p>
                      <p className="text-stone-500">{u.reason}</p>
                    </div>
                    <p className="whitespace-nowrap text-xl font-semibold">{usd(u.quantity * u.unitPriceCents)}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {step === 2 && (
          <section className="mx-auto max-w-3xl" data-testid="present-options">
            <h1 className="mb-4 text-4xl font-semibold">Your options</h1>
            <EstimateTiers
              code={code}
              tiers={tiers}
              initialTier={initialTier}
              initialColor={initialColor}
              warranties={warranties}
              expired={expired}
            />
          </section>
        )}
      </div>

      {/* Bottom nav: large targets */}
      <footer className="flex justify-between border-t border-stone-100 px-8 py-4">
        <button
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0}
          className="rounded-xl bg-stone-100 px-8 py-4 text-lg font-semibold text-stone-600 disabled:opacity-30"
          data-testid="present-back"
        >
          ← Back
        </button>
        <button
          onClick={() => setStep((s) => Math.min(steps.length - 1, s + 1))}
          disabled={step === steps.length - 1}
          className="rounded-xl bg-stone-900 px-8 py-4 text-lg font-semibold text-white disabled:opacity-30"
          data-testid="present-next"
        >
          Next →
        </button>
      </footer>
    </main>
  );
}
