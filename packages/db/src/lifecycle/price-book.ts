import { eq, isNull, desc } from "drizzle-orm";
import { withTenant } from "../tenant";
import { priceBookItem, priceBookVersion, tierProduct } from "../schema/pricing";
import { DEFAULT_PRICE_BOOK, DEFAULT_TIER_PRODUCTS, proposePriceBookDiff } from "@savvy/core";

/** Seeds the built-in catalog for a tenant the first time. Idempotent via onConflictDoNothing. */
export async function ensurePriceBook(tenantId: string): Promise<{ seeded: number }> {
  return withTenant(tenantId, async (tx) => {
    const existing = await tx.select({ id: priceBookItem.id }).from(priceBookItem).limit(1);
    if (existing.length > 0) return { seeded: 0 };
    const rows = DEFAULT_PRICE_BOOK.map((d) => ({ ...d, tenantId }));
    const inserted = await tx
      .insert(priceBookItem)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: priceBookItem.id });
    return { seeded: inserted.length };
  });
}

/** Seeds the Good/Better/Best tier products (owner decisions locked 2026-07-08)
 *  with NULL price/cost slots — we never invent costs. Idempotent. */
export async function ensureTierProducts(tenantId: string): Promise<{ seeded: number }> {
  return withTenant(tenantId, async (tx) => {
    const existing = await tx.select({ id: tierProduct.id }).from(tierProduct).limit(1);
    if (existing.length > 0) return { seeded: 0 };
    const inserted = await tx
      .insert(tierProduct)
      .values(DEFAULT_TIER_PRODUCTS.map((d) => ({ ...d, tenantId })))
      .onConflictDoNothing()
      .returning({ id: tierProduct.id });
    return { seeded: inserted.length };
  });
}

/** Unfilled owner slots ("good:price", "best:cost", …) — the source for the
 *  "price book needs costs" card. Empty array = fully priced. */
export async function tierProductsNeedingCosts(tenantId: string): Promise<string[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.select().from(tierProduct).where(eq(tierProduct.active, true));
    const needs: string[] = [];
    for (const r of rows) {
      if (r.unitPriceCents == null) needs.push(`${r.tier}:price`);
      if (r.unitCostCents == null) needs.push(`${r.tier}:cost`);
    }
    return needs;
  });
}

export type PriceBookItemRow = typeof priceBookItem.$inferSelect;
type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/** Tx-scoped variant for callers already inside withTenant (the estimate draft
 *  path). Selecting `active=true` across the whole table would return live
 *  originals PLUS every version's clones — always scope to one book. */
export async function getCurrentPriceBookTx(
  tx: Tx,
): Promise<{ versionId: string | null; items: PriceBookItemRow[] }> {
  const [cur] = await tx
    .select()
    .from(priceBookVersion)
    .where(eq(priceBookVersion.current, true))
    .limit(1);
  if (!cur) {
    const items = await tx.select().from(priceBookItem).where(isNull(priceBookItem.versionId));
    return { versionId: null, items };
  }
  const items = await tx.select().from(priceBookItem).where(eq(priceBookItem.versionId, cur.id));
  return { versionId: cur.id, items };
}

/** The book new estimates price from: the current version's items, or the
 *  live (null-version) originals before the first version is minted. */
export async function getCurrentPriceBook(
  tenantId: string,
): Promise<{ versionId: string | null; items: PriceBookItemRow[] }> {
  return withTenant(tenantId, (tx) => getCurrentPriceBookTx(tx));
}

export interface PriceBookChange {
  key: string;
  unitPriceCents?: number;
  unitCostCents?: number;
}

export interface UnderFloorEntry {
  key: string;
  unitPriceCents: number;
  unitCostCents: number;
  marginBps: number;
  floorBps: number;
}

/** Applying a version that pushes an item under its margin floor requires
 *  explicit owner confirmation — never a silent under-floor. */
export class MarginFloorConfirmationRequiredError extends Error {
  constructor(public underFloor: UnderFloorEntry[]) {
    super(`price change puts ${underFloor.length} item(s) under margin floor — owner confirm required`);
    this.name = "MarginFloorConfirmationRequiredError";
  }
}

function itemMarginBps(priceCents: number, costCents: number): number {
  if (priceCents <= 0) return 0;
  return Math.round(((priceCents - costCents) / priceCents) * 10_000);
}

/** Mints a NEW price book version (never edits in place): clones the current
 *  book, applies the changes, and moves the current pointer. Sent estimates
 *  keep their stamped version — this is the audit trail. */
export async function applyPriceBookVersion(input: {
  tenantId: string;
  source: "manual" | "ai_parse" | "drift";
  note?: string;
  changes: PriceBookChange[];
  defaultMarginFloorBps: number;
  confirmUnderFloor?: boolean;
}): Promise<{ versionId: string; versionNo: number; underFloor: UnderFloorEntry[] }> {
  return withTenant(input.tenantId, async (tx) => {
    // Base book = current version (or the live originals pre-versioning).
    const [cur] = await tx
      .select()
      .from(priceBookVersion)
      .where(eq(priceBookVersion.current, true))
      .limit(1);
    const base = cur
      ? await tx.select().from(priceBookItem).where(eq(priceBookItem.versionId, cur.id))
      : await tx.select().from(priceBookItem).where(isNull(priceBookItem.versionId));

    const changeByKey = new Map(input.changes.map((c) => [c.key, c]));

    // Margin-floor red path: evaluate the CHANGED items' post-change margins.
    const underFloor: UnderFloorEntry[] = [];
    for (const item of base) {
      const c = changeByKey.get(item.key);
      if (!c) continue;
      const price = c.unitPriceCents ?? item.unitPriceCents;
      const cost = c.unitCostCents ?? item.unitCostCents;
      const floor = item.marginFloorBps ?? input.defaultMarginFloorBps;
      const margin = itemMarginBps(price, cost);
      if (margin < floor) {
        underFloor.push({ key: item.key, unitPriceCents: price, unitCostCents: cost, marginBps: margin, floorBps: floor });
      }
    }
    if (underFloor.length > 0 && !input.confirmUnderFloor) {
      throw new MarginFloorConfirmationRequiredError(underFloor);
    }

    const [latest] = await tx
      .select({ versionNo: priceBookVersion.versionNo })
      .from(priceBookVersion)
      .orderBy(desc(priceBookVersion.versionNo))
      .limit(1);
    const versionNo = (latest?.versionNo ?? 0) + 1;

    await tx.update(priceBookVersion).set({ current: false }).where(eq(priceBookVersion.current, true));
    const [ver] = await tx
      .insert(priceBookVersion)
      .values({ tenantId: input.tenantId, versionNo, source: input.source, note: input.note, current: true })
      .returning();

    await tx.insert(priceBookItem).values(
      base.map((item) => {
        const { id: _id, createdAt: _createdAt, ...rest } = item;
        const c = changeByKey.get(item.key);
        return {
          ...rest,
          versionId: ver!.id,
          unitPriceCents: c?.unitPriceCents ?? item.unitPriceCents,
          unitCostCents: c?.unitCostCents ?? item.unitCostCents,
        };
      }),
    );

    return { versionId: ver!.id, versionNo, underFloor };
  });
}

/** #136 wiring: derive a proposed cost diff from recent guard-matched
 *  supplier-invoice lines vs the current book. Latest billed cost per key wins.
 *  Read-only — the Library UI prefills applyPriceBookVersion with the result. */
export async function deriveCostDriftDiff(
  tenantId: string,
  opts: { defaultMarginFloorBps: number; windowDays?: number },
): Promise<ReturnType<typeof proposePriceBookDiff>> {
  const { supplierInvoice } = await import("../schema/supplier-invoice");
  const { gte } = await import("drizzle-orm");
  const since = new Date(Date.now() - (opts.windowDays ?? 30) * 86_400_000);

  return withTenant(tenantId, async (tx) => {
    const invoices = await tx
      .select({ lines: supplierInvoice.lines, createdAt: supplierInvoice.createdAt })
      .from(supplierInvoice)
      .where(gte(supplierInvoice.createdAt, since));

    // Latest billed unit cost per matched key (only guard-matched lines count —
    // unmatched descriptions are never guessed into the book).
    const latest = new Map<string, { at: Date; unitCostCents: number; name: string }>();
    for (const inv of invoices) {
      for (const line of inv.lines ?? []) {
        if (!line.matchedItemKey) continue;
        const prev = latest.get(line.matchedItemKey);
        if (!prev || inv.createdAt > prev.at) {
          latest.set(line.matchedItemKey, { at: inv.createdAt, unitCostCents: line.unitBilledCents, name: line.description });
        }
      }
    }

    const { items } = await getCurrentPriceBookTx(tx);
    return proposePriceBookDiff({
      parsedLines: [...latest.entries()].map(([key, v]) => ({ key, name: v.name, unitCostCents: v.unitCostCents })),
      book: items.filter((i) => i.active),
      defaultMarginFloorBps: opts.defaultMarginFloorBps,
    });
  });
}
