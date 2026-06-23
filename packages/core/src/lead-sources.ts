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
