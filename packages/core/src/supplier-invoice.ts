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
