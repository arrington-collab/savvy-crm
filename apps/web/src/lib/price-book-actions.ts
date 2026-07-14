"use server";
import { revalidatePath } from "next/cache";
import {
  withTenant,
  priceBookItem,
  tierProduct,
  eq,
  applyPriceBookVersion,
  MarginFloorConfirmationRequiredError,
  type PriceBookChange,
  type UnderFloorEntry,
} from "@savvy/db";
import { parsePriceSheet, type PriceSheetParseResult } from "@savvy/agents";
import { parseEstimateConfig } from "@savvy/core";
import { tenant as tenantTable } from "@savvy/db";
import { getTenantId } from "./tenant";

export async function updatePriceBookItem(input: {
  id: string;
  unitPriceCents: number;
  unitCostCents: number;
  wasteApplies: boolean;
  active: boolean;
  sourceFields: string[];
}) {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx
      .update(priceBookItem)
      .set({
        unitPriceCents: input.unitPriceCents,
        unitCostCents: input.unitCostCents,
        wasteApplies: input.wasteApplies,
        active: input.active,
        sourceFields: input.sourceFields,
      })
      .where(eq(priceBookItem.id, input.id)),
  );
}

/** Owner fills tier product slots (price/cost per square, warranty, palette). */
export async function saveTierProduct(input: {
  id: string;
  unitPriceCents: number | null;
  unitCostCents: number | null;
  warrantyText: string;
  colorPalette: { name: string; hex: string }[];
}) {
  const tenantId = await getTenantId();
  await withTenant(tenantId, (tx) =>
    tx
      .update(tierProduct)
      .set({
        unitPriceCents: input.unitPriceCents,
        unitCostCents: input.unitCostCents,
        warrantyText: input.warrantyText,
        colorPalette: input.colorPalette,
      })
      .where(eq(tierProduct.id, input.id)),
  );
  revalidatePath("/settings/price-book");
}

async function tenantMarginFloorBps(tenantId: string): Promise<number> {
  const [t] = await withTenant(tenantId, (tx) =>
    tx.select({ settings: tenantTable.settings }).from(tenantTable).where(eq(tenantTable.id, tenantId)),
  );
  return parseEstimateConfig((t?.settings as { estimate?: unknown })?.estimate).marginFloorBps;
}

/** Paste a supplier price sheet → AI-parse → proposed cost diff. Read-only. */
export async function parsePriceSheetAction(rawText: string): Promise<PriceSheetParseResult> {
  const tenantId = await getTenantId();
  const floor = await tenantMarginFloorBps(tenantId);
  return parsePriceSheet({ tenantId, rawText, defaultMarginFloorBps: floor });
}

export type ApplyDiffResult =
  | { ok: true; versionNo: number; underFloor: UnderFloorEntry[] }
  | { ok: false; needsConfirm: true; underFloor: UnderFloorEntry[] };

/** Apply a reviewed diff as a NEW price book version (never in place). The
 *  margin-floor red path surfaces as needsConfirm instead of applying. */
export async function applyPriceBookDiffAction(input: {
  changes: PriceBookChange[];
  source: "manual" | "ai_parse" | "drift";
  note?: string;
  confirmUnderFloor?: boolean;
}): Promise<ApplyDiffResult> {
  const tenantId = await getTenantId();
  const floor = await tenantMarginFloorBps(tenantId);
  try {
    const res = await applyPriceBookVersion({
      tenantId,
      source: input.source,
      note: input.note,
      changes: input.changes,
      defaultMarginFloorBps: floor,
      confirmUnderFloor: input.confirmUnderFloor,
    });
    revalidatePath("/settings/price-book");
    return { ok: true, versionNo: res.versionNo, underFloor: res.underFloor };
  } catch (e) {
    if (e instanceof MarginFloorConfirmationRequiredError) {
      return { ok: false, needsConfirm: true, underFloor: e.underFloor };
    }
    throw e;
  }
}
