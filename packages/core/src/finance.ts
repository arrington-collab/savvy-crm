import { z } from "./schemas";
import { COMMISSION_MODEL, type CommissionModel } from "./enums";

export type LineItem = { description: string; qty: number; unitAmountCents: number };

export function computeInvoiceTotal(items: LineItem[]): number {
  return items.reduce((sum, i) => sum + i.qty * i.unitAmountCents, 0);
}

export function formatInvoiceNumber(prefix: string, seq: number): string {
  return `${prefix}${String(seq).padStart(6, "0")}`;
}

// Overnight range: a time is "quiet" if hour >= startHour OR hour < endHour (e.g. 21–8 = 9pm–8am).
const quietHoursSchema = z.object({
  startHour: z.number().int().min(0).max(23).default(21),
  endHour: z.number().int().min(0).max(23).default(8),
});

const dunningSchema = z.object({
  enabled: z.boolean().default(true),
  smsEscalationDay: z.number().int().positive().default(30), // days after invoice due date
  quietHours: quietHoursSchema.default({}),
});

// zod v3: z.record takes a single value schema (key is always string)
const commissionSettingsSchema = z.object({
  model: z.enum(COMMISSION_MODEL as unknown as [CommissionModel, ...CommissionModel[]]).default("flat"),
  rate: z.number().int().min(0).default(1000), // basis points (1000 = 10%)
  tiers: z.array(z.object({
    thresholdCents: z.number().int().min(0),
    rate: z.number().int().min(0),
  })).default([]),
  period: z.enum(["monthly", "quarterly"]).default("monthly"),
  perRepRate: z.record(z.number().int().min(0)).default({}),
});

const priceGuardSchema = z.object({
  minOverageCents: z.number().int().nonnegative().default(2500),  // $25 floor per line
  overagePct: z.number().min(0).max(1).default(0.05),             // 5% of expected line cost
  autoSendMinCents: z.number().int().nonnegative().default(2500), // min claim to unattended-send
  highConfidence: z.number().min(0).max(1).default(0.8),          // parseConfidence gate
});

const financeSchema = z.object({
  netDays: z.number().int().positive().default(14),
  // Estimate Experience slice 3: deposit collected at acceptance, % of the
  // accepted tier total. 0 = waived (tenant-config "unless config says otherwise").
  depositPercentageBps: z.number().int().min(0).max(10_000).default(5000),
  // Slice 7: insurance jobs collect differently (the carrier pays the roof;
  // the deductible is collected on its own rails). Default 0 = no acceptance
  // deposit on the insurance variant; tenant-configurable.
  insuranceDepositPercentageBps: z.number().int().min(0).max(10_000).default(0),
  invoiceNumberPrefix: z.string().default("INV-"),
  timezone: z.string()
    .refine((s) => { try { Intl.DateTimeFormat(undefined, { timeZone: s }); return true; } catch { return false; } }, "invalid IANA timezone")
    .default("America/Phoenix"),
  dunning: dunningSchema.default({}),
  commission: commissionSettingsSchema.default({}),
  priceGuard: priceGuardSchema.default({}),
});

export type FinanceConfig = z.infer<typeof financeSchema>;
export type CommissionConfig = z.infer<typeof commissionSettingsSchema>;

export function parseFinanceConfig(raw: unknown): FinanceConfig {
  return financeSchema.parse(raw ?? {});
}
