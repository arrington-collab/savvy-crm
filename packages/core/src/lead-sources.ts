import { z } from "zod";

export type LeadSource = { value: string; label: string };

export const DEFAULT_LEAD_SOURCES: LeadSource[] = [
  { value: "referral", label: "Referral" },
  { value: "repeat", label: "Repeat / past customer" },
  { value: "door_knock", label: "Door knock" },
  { value: "storm_canvass", label: "Storm canvassing" },
  { value: "website", label: "Website" },
  { value: "google", label: "Google" },
  { value: "facebook", label: "Facebook" },
  { value: "yard_sign", label: "Yard sign" },
  { value: "carrier", label: "Insurance carrier" },
  { value: "other", label: "Other" },
];

/** defaults + tenant-added sources (value=label for customs), case-insensitive dedupe. */
export function mergeLeadSources(custom: string[] | null | undefined): LeadSource[] {
  const seen = new Set(DEFAULT_LEAD_SOURCES.map((s) => s.value.toLowerCase()));
  const extra: LeadSource[] = [];
  for (const c of custom ?? []) {
    const v = (c ?? "").trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    extra.push({ value: v, label: v });
  }
  return [...DEFAULT_LEAD_SOURCES, ...extra];
}

export const LEAD_SOURCE_VALUES = [
  "referral", "insurance_agent", "ads", "realtor", "partner", "other",
  "web", "inbound_call", "canvass", "direct_mail", "mobilization",
] as const;
export type LeadSourceValue = (typeof LEAD_SOURCE_VALUES)[number];

export const MACHINE_LEAD_SOURCES = ["web", "inbound_call", "canvass", "direct_mail", "mobilization"] as const;
export const AD_PLATFORM_VALUES = ["google_lsa", "google_ads", "meta", "nextdoor", "other"] as const;

export function isMachineSource(s: string): boolean {
  return (MACHINE_LEAD_SOURCES as readonly string[]).includes(s);
}

const referralDetail = z.object({ referrer_name: z.string().min(1), referrer_contact: z.string().optional(), referral_fee_cents: z.number().int().min(0).optional() });
const insuranceAgentDetail = z.object({ agency: z.string().min(1), agent_name: z.string().optional() });
const adsDetail = z.object({ platform: z.enum(AD_PLATFORM_VALUES) });
const realtorDetail = z.object({ name: z.string().min(1), brokerage: z.string().optional() });
const partnerDetail = z.object({ name: z.string().min(1) });
const otherDetail = z.object({ note: z.string().optional(), custom_source_key: z.string().optional(), custom_label: z.string().optional() });
const emptyDetail = z.null().or(z.object({}).strict());

/** The zod schema for a source's `source_detail`, given the chosen source. */
export function leadSourceDetailSchema(source: string) {
  switch (source) {
    case "referral": return referralDetail;
    case "insurance_agent": return insuranceAgentDetail;
    case "ads": return adsDetail;
    case "realtor": return realtorDetail;
    case "partner": return partnerDetail;
    case "other": return otherDetail;
    default: return emptyDetail; // machine sources
  }
}
