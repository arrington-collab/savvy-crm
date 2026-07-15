import { z } from "zod";

// Partner Ledger (spec: docs/superpowers/specs/prompts-partner-ledger.md).
// Attribution hygiene or nothing: partners are PICKED (typeahead, create-once),
// never free-typed — or the ledger fragments into "Jane Smith / jane smith /
// J. Smith RE-MAX". The folding here is the single identity rule.

export const PARTNER_CLASS_VALUES = ["realtor", "insurance_agent", "property_manager", "other"] as const;
export type PartnerClass = (typeof PARTNER_CLASS_VALUES)[number];

export const PARTNER_STATUS_VALUES = ["active", "paused", "archived"] as const;

/** Lead sources whose leads MUST carry a partner_id (the attribution invariant). */
export const PARTNER_SOURCE_VALUES = ["realtor", "insurance_agent", "partner"] as const;

export function isPartnerSource(s: string): boolean {
  return (PARTNER_SOURCE_VALUES as readonly string[]).includes(s);
}

export function partnerClassForSource(source: string): PartnerClass {
  if (source === "realtor") return "realtor";
  if (source === "insurance_agent") return "insurance_agent";
  return "other";
}

// Trailing legal-entity suffixes only — never brand words like "Realty"/"Group"
// that distinguish real orgs. Stripped repeatedly, but a bare suffix-only name
// is kept as-is (guard: tokens.length > 1).
const ORG_SUFFIXES = new Set(["llc", "inc", "co", "corp", "ltd", "llp", "lp", "pllc", "pc"]);

/** Case/whitespace/punctuation/org-suffix folding — "RE/MAX" == "re-max" == "Re Max". */
export function normalizePartnerName(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 1 && ORG_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join(" ");
}

/** Create-once identity within a tenant: folded name + folded org. */
export function partnerKey(name: string, org?: string | null): string {
  return `${normalizePartnerName(name)}|${normalizePartnerName(org ?? "")}`;
}

/** Inline create-once payload (typeahead "add new" / API intake). */
export const inlinePartnerSchema = z.object({
  name: z.string().trim().min(1).max(160),
  org: z.string().trim().max(160).optional(),
  class: z.enum(PARTNER_CLASS_VALUES).optional(),
});
export type InlinePartnerInput = z.infer<typeof inlinePartnerSchema>;

/**
 * Extract a partner reference from legacy free-text source_detail (backfill).
 * Returns null when there is nothing attributable — those leads surface in the
 * partner.attribution evidence check instead of being guessed at.
 */
export function partnerRefFromSourceDetail(source: string, detail: unknown): { name: string; org?: string } | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  const s = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  if (source === "realtor") {
    const name = s(d.name);
    return name ? { name, org: s(d.brokerage) } : null;
  }
  if (source === "insurance_agent") {
    const agency = s(d.agency);
    const agent = s(d.agent_name);
    if (agent) return { name: agent, org: agency };
    return agency ? { name: agency } : null;
  }
  if (source === "partner") {
    const name = s(d.name);
    return name ? { name } : null;
  }
  return null;
}

/** Shared refine rule: partner-class sources must carry a partner reference. */
export const hasPartnerRef = (d: { source: string; partnerId?: string; partner?: unknown }): boolean =>
  !isPartnerSource(d.source) || Boolean(d.partnerId || d.partner);

export const partnerRefIssue: { message: string; path: (string | number)[] } = {
  message: "Pick a partner for this source",
  path: ["partnerId"],
};
