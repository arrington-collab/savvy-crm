import { z } from "./schemas";
import { COMMISSION_MODEL } from "./enums";

export type LineItem = { description: string; qty: number; unitAmountCents: number };

export function computeInvoiceTotal(items: LineItem[]): number {
  return items.reduce((sum, i) => sum + i.qty * i.unitAmountCents, 0);
}

export function formatInvoiceNumber(prefix: string, seq: number): string {
  return `${prefix}${String(seq).padStart(6, "0")}`;
}

const quietHoursSchema = z.object({
  startHour: z.number().int().min(0).max(23).default(21),
  endHour: z.number().int().min(0).max(23).default(8),
});

const dunningSchema = z.object({
  enabled: z.boolean().default(true),
  smsEscalationDay: z.number().int().positive().default(30),
  quietHours: quietHoursSchema.default({}),
});

// zod v3: z.record takes a single value schema (key is always string)
const commissionSettingsSchema = z.object({
  model: z.enum([...COMMISSION_MODEL] as [string, ...string[]]).default("flat"),
  rate: z.number().int().min(0).default(1000), // basis points (1000 = 10%)
  tiers: z.array(z.object({
    thresholdCents: z.number().int().min(0),
    rate: z.number().int().min(0),
  })).default([]),
  period: z.enum(["monthly", "quarterly"]).default("monthly"),
  perRepRate: z.record(z.number().int().min(0)).default({}),
});

const financeSchema = z.object({
  netDays: z.number().int().positive().default(14),
  invoiceNumberPrefix: z.string().default("INV-"),
  timezone: z.string().default("America/Phoenix"),
  dunning: dunningSchema.default({}),
  commission: commissionSettingsSchema.default({}),
});

export type FinanceConfig = z.infer<typeof financeSchema>;
export type CommissionConfig = z.infer<typeof commissionSettingsSchema>;

export function parseFinanceConfig(raw: unknown): FinanceConfig {
  return financeSchema.parse(raw ?? {});
}
