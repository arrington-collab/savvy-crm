import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, isNull } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { tenant } from "../src/schema/tenancy";
import { priceBookItem, priceBookVersion, tierProduct } from "../src/schema/pricing";
import { ensureTenantForOrg } from "../src/lifecycle/provisioning";
import { ensurePriceBook } from "../src/lifecycle/price-book";
import {
  ensureTierProducts,
  getCurrentPriceBook,
  applyPriceBookVersion,
  tierProductsNeedingCosts,
  MarginFloorConfirmationRequiredError,
} from "../src/lifecycle/price-book";

let tenantId: string;

beforeAll(async () => {
  const t = await ensureTenantForOrg({ clerkOrgId: `org_pbv_${Date.now()}`, name: "PBV Test" });
  tenantId = t.id;
  await ensurePriceBook(tenantId);
});

afterAll(async () => {
  await adminDb.delete(priceBookItem).where(eq(priceBookItem.tenantId, tenantId));
  await adminDb.delete(priceBookVersion).where(eq(priceBookVersion.tenantId, tenantId));
  await adminDb.delete(tierProduct).where(eq(tierProduct.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

describe("ensureTierProducts", () => {
  it("seeds the three owner-decided products with UNFILLED costs, better recommended; idempotent", async () => {
    const first = await ensureTierProducts(tenantId);
    expect(first.seeded).toBe(3);
    const again = await ensureTierProducts(tenantId);
    expect(again.seeded).toBe(0);

    const rows = await adminDb.select().from(tierProduct).where(eq(tierProduct.tenantId, tenantId));
    expect(rows).toHaveLength(3);
    const byTier = Object.fromEntries(rows.map((r) => [r.tier, r]));
    expect(byTier.good!.productName).toBe("IKO Cambridge");
    expect(byTier.better!.productName).toBe("IKO Dynasty");
    expect(byTier.better!.recommended).toBe(true);
    expect(byTier.best!.productName).toBe("TAMKO Titan XT");
    expect(byTier.best!.manufacturer).toBe("TAMKO");
    // never invent costs — owner fills these
    for (const r of rows) {
      expect(r.unitPriceCents).toBeNull();
      expect(r.unitCostCents).toBeNull();
    }
  });

  it("tierProductsNeedingCosts lists every unfilled slot (the 'needs costs' card source)", async () => {
    const needs = await tierProductsNeedingCosts(tenantId);
    expect(needs).toContain("good:price");
    expect(needs).toContain("better:cost");
    expect(needs).toContain("best:price");
  });
});

describe("price book versioning", () => {
  it("with no versions, getCurrentPriceBook returns the live (null-version) items", async () => {
    const { versionId, items } = await getCurrentPriceBook(tenantId);
    expect(versionId).toBeNull();
    expect(items.length).toBeGreaterThan(5);
    expect(items.every((i) => i.versionId === null)).toBe(true);
  });

  it("applyPriceBookVersion mints version 1 as a full clone with the changes applied", async () => {
    const res = await applyPriceBookVersion({
      tenantId,
      source: "manual",
      note: "first real costs",
      changes: [{ key: "field-shingles", unitPriceCents: 13000, unitCostCents: 8000 }],
      defaultMarginFloorBps: 1500,
    });
    expect(res.versionNo).toBe(1);

    const { versionId, items } = await getCurrentPriceBook(tenantId);
    expect(versionId).toBe(res.versionId);
    const shingles = items.find((i) => i.key === "field-shingles")!;
    expect(shingles.unitPriceCents).toBe(13000);
    expect(shingles.unitCostCents).toBe(8000);
    // untouched items cloned verbatim
    const drip = items.find((i) => i.key === "drip-edge");
    expect(drip).toBeDefined();

    // live (null-version) originals still exist, untouched (audit trail)
    const live = await adminDb
      .select()
      .from(priceBookItem)
      .where(and(eq(priceBookItem.tenantId, tenantId), isNull(priceBookItem.versionId)));
    const liveShingles = live.find((i) => i.key === "field-shingles")!;
    expect(liveShingles.unitPriceCents).not.toBe(13000);
  });

  it("a second apply mints version 2 off the current version and moves the pointer", async () => {
    const res = await applyPriceBookVersion({
      tenantId,
      source: "ai_parse",
      note: "supplier sheet 2026-07",
      changes: [{ key: "drip-edge", unitPriceCents: 260 }],
      defaultMarginFloorBps: 1500,
    });
    expect(res.versionNo).toBe(2);

    const { items } = await getCurrentPriceBook(tenantId);
    // carries version 1's shingle change forward AND version 2's drip change
    expect(items.find((i) => i.key === "field-shingles")!.unitPriceCents).toBe(13000);
    expect(items.find((i) => i.key === "drip-edge")!.unitPriceCents).toBe(260);

    const versions = await adminDb
      .select()
      .from(priceBookVersion)
      .where(eq(priceBookVersion.tenantId, tenantId));
    expect(versions).toHaveLength(2);
    expect(versions.filter((v) => v.current)).toHaveLength(1);
    expect(versions.find((v) => v.current)!.versionNo).toBe(2);
  });

  it("RED PATH: a change that pushes an item under its margin floor requires explicit confirm", async () => {
    // price 100, cost 95 → 5% margin, floor 15%
    await expect(
      applyPriceBookVersion({
        tenantId,
        source: "manual",
        changes: [{ key: "drip-edge", unitPriceCents: 100, unitCostCents: 95 }],
        defaultMarginFloorBps: 1500,
      }),
    ).rejects.toThrowError(MarginFloorConfirmationRequiredError);

    // no version row was minted by the refused apply
    const versions = await adminDb
      .select()
      .from(priceBookVersion)
      .where(eq(priceBookVersion.tenantId, tenantId));
    expect(versions).toHaveLength(2);

    // with explicit confirm it applies and reports what's under floor
    const res = await applyPriceBookVersion({
      tenantId,
      source: "manual",
      changes: [{ key: "drip-edge", unitPriceCents: 100, unitCostCents: 95 }],
      defaultMarginFloorBps: 1500,
      confirmUnderFloor: true,
    });
    expect(res.versionNo).toBe(3);
    expect(res.underFloor.map((u) => u.key)).toContain("drip-edge");
  });
});
