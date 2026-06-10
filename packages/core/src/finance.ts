import { z } from "./schemas";

export type LineItem = { description: string; qty: number; unitAmountCents: number };

export function computeInvoiceTotal(items: LineItem[]): number {
  return items.reduce((sum, i) => sum + i.qty * i.unitAmountCents, 0);
}

export function formatInvoiceNumber(prefix: string, seq: number): string {
  return `${prefix}${String(seq).padStart(6, "0")}`;
}

const financeSchema = z.object({
  netDays: z.number().int().positive().default(14),
  invoiceNumberPrefix: z.string().default("INV-"),
});

export type FinanceConfig = { netDays: number; invoiceNumberPrefix: string };

export function parseFinanceConfig(raw: unknown): FinanceConfig {
  return financeSchema.parse(raw ?? {});
}
