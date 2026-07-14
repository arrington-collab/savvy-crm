import { z } from "zod";

// Estimate Experience slice 5b: the owner's day-after video batch — pure
// assembly logic. The queue item carries EVERYTHING needed to record ten
// videos in twenty minutes with zero lookup; delivery is personalized-first
// with the generic tenant video as the always-there fallback.

export interface QueueTier {
  tier: string;
  productName: string;
  subtotalCents: number | null;
  recommended?: boolean;
}

const COMMON_NAMES = /^[a-z]+$/i;

/** A phonetic hint is only worth generating when the name might trip the
 *  owner mid-recording — non-obvious spellings, not "John Smith". */
export function needsPhoneticHint(fullName: string): boolean {
  const parts = fullName.trim().split(/\s+/);
  return parts.some((p) => {
    if (!COMMON_NAMES.test(p)) return true;
    const lower = p.toLowerCase();
    // Heuristic: letter clusters that commonly diverge from English phonics.
    return /(bh|dh|gh(?!t)|x[aeiou]|cz|sz|ng(?=[aeiou])|ao|uy|ii|jz|tl)/.test(lower);
  });
}

const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export interface VideoQueueItem {
  headline: string;
  repLine: string;
  priceLine: string;
  nugget: string;
  phoneticNeeded: boolean;
}

export function buildVideoQueueItem(input: {
  customerName: string;
  repName: string | null;
  city: string | null;
  selectedTier: string | null;
  tiers: QueueTier[];
  isInsurance: boolean;
  recentQuestion: string | null;
}): VideoQueueItem {
  const tier =
    input.tiers.find((t) => t.tier === input.selectedTier) ??
    input.tiers.find((t) => t.recommended) ??
    input.tiers[0] ??
    null;

  const priceLine = tier
    ? `${tier.productName}${tier.subtotalCents != null ? ` — ${usd(tier.subtotalCents)}` : ""}`
    : "estimate sent";

  // Their live concern beats any generic context.
  const nugget = input.recentQuestion
    ? `They asked: "${input.recentQuestion}"`
    : input.isInsurance
      ? "Insurance claim job — the carrier's already on board."
      : "Retail job — they're comparing bids.";

  return {
    headline: `${input.customerName}${input.city ? ` — ${input.city}` : ""}`,
    repLine: input.repName ? `${input.repName} visited them yesterday.` : "Estimate sent yesterday.",
    priceLine,
    nugget,
    phoneticNeeded: needsPhoneticHint(input.customerName),
  };
}

/** Personalized approved take → it. Anything unapproved NEVER sends. No take
 *  by send time → the generic tenant video. Neither → nothing sends. */
export function pickDeliveryVideo(
  videos: { role: string; approvedAt: Date | null; documentId: string }[],
  genericDocumentId: string | null,
): { documentId: string; personalized: boolean } | null {
  const take = videos.find((v) => v.role === "owner" && v.approvedAt != null);
  if (take) return { documentId: take.documentId, personalized: true };
  if (genericDocumentId) return { documentId: genericDocumentId, personalized: false };
  return null;
}

// Tenant config for the day-after program (settings.ownerVideo).
const ownerVideoSchema = z.object({
  deliveryHourLocal: z.number().int().min(8).max(20).default(12),
  genericDocumentId: z.string().nullable().default(null),
});
export type OwnerVideoConfig = z.infer<typeof ownerVideoSchema>;
export function parseOwnerVideoConfig(raw: unknown): OwnerVideoConfig {
  return ownerVideoSchema.parse(raw ?? {});
}
