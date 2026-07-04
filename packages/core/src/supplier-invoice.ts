import { z } from "zod";

/**
 * Supplier-invoice pure types + helpers. The inbox token routes an inbound
 * email to its tenant; lines carry parsed amounts (13b) plus guard annotations
 * (13c). Kept pure so routing + shapes are unit-tested.
 */
export type SupplierInvoiceLine = {
  description: string;
  sku?: string;
  quantity: number;
  unit?: string;
  unitBilledCents: number;
  amountBilledCents: number;
  // guard annotations (written in slice 13c)
  matchedItemKey?: string | null;
  expectedUnitCostCents?: number | null;
  overageCents?: number | null;
  matchConfidence?: number | null;
};

// Per-tenant inbox address: inv-<token>@inbox.getsavvy.com. Token is [A-Za-z0-9]+.
const INBOX_RE = /(?:^|<)\s*inv-([A-Za-z0-9]+)@inbox\.getsavvy\.com\s*>?$/i;

export function parseInboxToken(toAddress: string): string | null {
  const m = INBOX_RE.exec(toAddress.trim());
  return m?.[1] ?? null;
}

/** Build a tenant's forwarding address from its token. Domain kept explicit (pure). */
export function deriveInboxAddress(token: string, domain = "inbox.getsavvy.com"): string {
  return `inv-${token}@${domain}`;
}

/** Structured extraction target for parsing a supplier invoice PDF via the AI gateway (13b). */
export const supplierInvoiceParseSchema = z.object({
  supplierName: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: z.string().nullable(), // ISO date or null
  totalCents: z.number().int(),
  lines: z.array(z.object({
    description: z.string(),
    sku: z.string().optional(),
    quantity: z.number(),
    unit: z.string().optional(),
    unitBilledCents: z.number().int(),
    amountBilledCents: z.number().int(),
  })),
  confidence: z.number().min(0).max(1),
});
export type SupplierInvoiceParse = z.infer<typeof supplierInvoiceParseSchema>;

/** Prefer real supplier-invoice actuals; fall back to the material-order estimate until any land. */
export function selectJobCost(input: { actualsCents: number | null; estimateCents: number }): number {
  return input.actualsCents && input.actualsCents > 0 ? input.actualsCents : input.estimateCents;
}
