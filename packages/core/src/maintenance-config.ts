import { z } from "zod";

// Phase 20 — maintenance & recurring revenue. The annual tune-up price is a
// LIBRARY DEFAULT the owner edits, not a business number we invented: $348/yr
// ($29/mo equivalent) seeded as a starting point, shown editable in settings.

const MAINT_COPY = {
  offer: "Hi {{firstName}} — keep your roof under warranty-grade care: our annual maintenance membership includes a yearly tune-up visit with photos and a condition report. Want the details?",
  renewal: "Hi {{firstName}} — your roof maintenance membership renews soon. Your annual tune-up visit comes with it; want us to get it on the calendar?",
  winback: "Hi {{firstName}} — we'd love to have you back on the maintenance plan; your next tune-up visit is one text away. Want to restart?",
  report: "Hi {{firstName}} — your annual roof tune-up report is ready: {{reportUrl}}. Photos, condition notes, and anything worth watching are all in there.",
} as const;

const maintenanceConfigSchema = z.object({
  enabled: z.boolean().catch(true).default(true),
  annualPriceCents: z.number().int().min(0).catch(34_800).default(34_800),
  // Offer sweep knobs (#306): all Library-editable.
  offerAfterCompletionDays: z.number().int().min(1).catch(45).default(45),
  inspectionNoSaleAfterDays: z.number().int().min(1).catch(30).default(30),
  renewalLeadDays: z.number().int().min(1).catch(45).default(45),
  winbackAfterDays: z.number().int().min(1).catch(30).default(30),
  // Visit sweep (#307): due after this many months since the last annual visit
  // (or membership start), batched per day, scheduled this many days out.
  visitDueMonths: z.number().int().min(1).catch(11).default(11),
  visitsPerDay: z.number().int().min(1).catch(6).default(6),
  visitLeadDays: z.number().int().min(1).catch(7).default(7),
  copy: z.object({
    offer: z.string().catch(MAINT_COPY.offer).default(MAINT_COPY.offer),
    renewal: z.string().catch(MAINT_COPY.renewal).default(MAINT_COPY.renewal),
    winback: z.string().catch(MAINT_COPY.winback).default(MAINT_COPY.winback),
    report: z.string().catch(MAINT_COPY.report).default(MAINT_COPY.report),
  }).catch({ ...MAINT_COPY }).default({ ...MAINT_COPY }),
});
export type MaintenanceConfig = z.infer<typeof maintenanceConfigSchema>;

export function parseMaintenanceConfig(raw: unknown): MaintenanceConfig {
  const r = maintenanceConfigSchema.safeParse(raw ?? {});
  return r.success ? r.data : maintenanceConfigSchema.parse({});
}

/** Monthly-equivalent cents for an annual membership (floor — never overstate MRR). */
export function monthlyEquivalentCents(annualPriceCents: number): number {
  return Math.floor(annualPriceCents / 12);
}

/** Owner-digest churn line (#310); silent when the program is idle. */
export function buildMaintenanceLine(stats: {
  activeCount: number; newThisMonth30d: number; canceledThisMonth30d: number;
  topCancelReason: string | null; mrrCents: number;
}): string | null {
  if (stats.activeCount <= 0 && stats.canceledThisMonth30d <= 0) return null;
  const usd = (stats.mrrCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const parts = [
    `Maintenance: ${stats.activeCount} member${stats.activeCount === 1 ? "" : "s"} (${usd}/mo)`,
    `+${stats.newThisMonth30d}`,
    `−${stats.canceledThisMonth30d} this month`,
  ];
  if (stats.topCancelReason) parts.push(`top cancel reason: ${stats.topCancelReason}`);
  return parts.join(" · ");
}
