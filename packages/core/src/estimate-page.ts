// Estimate Experience slice 2: the pure view model behind the customer-facing
// estimate page. Homeowner-facing — plain language, nothing claimed that isn't
// in the scope, validity always visible.

import type { TierEstimate, TierKey } from "./tier-pricing";

export interface EstimatePageTier {
  tier: TierKey;
  productName: string;
  manufacturer: string;
  recommended: boolean;
  subtotalCents: number | null;
  /** Upgrade bullets ONLY — shared scope renders once, below the cards. */
  bullets: string[];
  colors: { name: string; hex: string }[];
}

export interface IncludedRow {
  key: string;
  icon: string;
  label: string;
  blurb: string;
}

// Scope-derived rows appear only when the matching line item is actually in
// the estimate; the last three are workmanship promises that always apply.
const SCOPE_ROWS: { key: string; match: (keys: Set<string>) => boolean; icon: string; label: string; blurb: string }[] = [
  { key: "tear-off", match: (k) => k.has("tear-off"), icon: "🏚️", label: "Full tear-off", blurb: "Old roofing stripped to the deck — no layovers." },
  { key: "ice-water", match: (k) => k.has("ice-water-shield") || k.has("ice-water"), icon: "🧊", label: "Ice & water shield", blurb: "Sealed along eaves and valleys where leaks start." },
  { key: "underlayment", match: (k) => k.has("underlayment"), icon: "📜", label: "Synthetic underlayment", blurb: "A second water barrier under every shingle." },
  { key: "drip-edge", match: (k) => k.has("drip-edge"), icon: "📐", label: "New drip edge", blurb: "Metal edging that keeps water off your fascia." },
  { key: "valley", match: (k) => k.has("valley-metal"), icon: "🏔️", label: "Valley metal", blurb: "Reinforced channels where roof planes meet." },
  { key: "ventilation", match: (k) => k.has("ridge-vent") || k.has("ventilation"), icon: "🌬️", label: "Balanced ventilation", blurb: "Keeps the attic cool and the shingle warranty valid." },
  { key: "cleanup", match: () => true, icon: "🧲", label: "Cleanup + magnetic nail sweep", blurb: "Your yard, driveway, and flowerbeds — nail-free." },
  { key: "permits", match: () => true, icon: "📋", label: "Permits handled", blurb: "We pull and close every required permit." },
  { key: "workmanship", match: () => true, icon: "🤝", label: "Workmanship warranty", blurb: "Our labor stands behind the manufacturer's shingle warranty." },
];

const TIER_ORDER: TierKey[] = ["good", "better", "best"];

export function buildEstimatePageModel(input: {
  companyName: string;
  customerName: string | null;
  address: string | null;
  sentAt: Date | null;
  createdAt: Date;
  now: Date;
  validityDays: number;
  tiers: TierEstimate[];
  /** Keys of the estimate's actual line items (shared scope). */
  lineItemKeys: string[];
  licenses: { state: string; city: string | null; licenseNumber: string }[];
  palettes: Partial<Record<TierKey, { name: string; hex: string }[]>>;
  financingEnabled: boolean;
}) {
  const anchor = input.sentAt ?? input.createdAt;
  const validUntil = new Date(anchor.getTime() + input.validityDays * 86_400_000);
  const expired = input.now > validUntil;

  const keySet = new Set(input.lineItemKeys);
  const included: IncludedRow[] = SCOPE_ROWS.filter((r) => r.match(keySet)).map(
    ({ key, icon, label, blurb }) => ({ key, icon, label, blurb }),
  );

  const byTier = new Map(input.tiers.map((t) => [t.tier, t]));
  const tiers: EstimatePageTier[] = TIER_ORDER.flatMap((key) => {
    const t = byTier.get(key);
    if (!t) return [];
    return [
      {
        tier: key,
        productName: t.productName,
        manufacturer: t.manufacturer,
        recommended: t.recommended,
        subtotalCents: t.subtotalCents,
        bullets: [
          `${t.manufacturer} ${t.productName} architectural shingles`,
          t.warrantyText.split(/(?<=\.)\s/)[0] ?? t.warrantyText,
        ],
        colors: input.palettes[key] ?? [],
      },
    ];
  });

  const trustLines = input.licenses.map((l) =>
    l.city ? `${l.city}, ${l.state} license ${l.licenseNumber}` : `${l.state} license ${l.licenseNumber}`,
  );

  return {
    companyName: input.companyName,
    customerName: input.customerName,
    address: input.address,
    validUntil,
    expired,
    tiers,
    included,
    trustLines,
    showMonthlyToggle: input.financingEnabled,
  };
}
