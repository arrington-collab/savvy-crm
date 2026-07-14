import { describe, it, expect, beforeAll } from "vitest";
import { createEstimateFromMeasurement } from "../src/lifecycle/estimate.js";
import { ensurePriceBook, ensureTierProducts, applyPriceBookVersion } from "../src/lifecycle/price-book.js";
import { withTenant } from "../src/tenant.js";
import { measurement } from "../src/schema/ops.js";
import { makeTenant, makeJobWithProperty } from "./helpers.js";
import type { TierEstimate } from "@savvy/core";

let tenantId: string;
let propertyId: string;
let jobId: string;

async function seedMeasurement(): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const [m] = await tx
      .insert(measurement)
      .values({
        tenantId,
        propertyId,
        provider: "roofr",
        areas: { squares: 25, predominantPitch: "6/12", eaveLf: 120, rakeLf: 60, ridgeLf: 40, valleyLf: 10 },
      })
      .returning();
    return m!.id;
  });
}

beforeAll(async () => {
  const t = await makeTenant();
  tenantId = t.tenantId;
  const j = await makeJobWithProperty(tenantId);
  jobId = j.jobId;
  propertyId = j.propertyId;
  await ensurePriceBook(tenantId);
  await ensureTierProducts(tenantId);
});

describe("estimate drafts stamp the price-book version + tier snapshot", () => {
  it("pre-versioning: stamps null version and a 3-entry Good/Better/Best snapshot", async () => {
    const measurementId = await seedMeasurement();
    const est = await createEstimateFromMeasurement({ tenantId, jobId, measurementId });
    expect(est).not.toBeNull();
    expect(est!.priceBookVersionId).toBeNull();
    const tiers = est!.tiers as unknown as TierEstimate[];
    expect(tiers).toHaveLength(3);
    expect(tiers.map((t) => t.tier)).toEqual(["good", "better", "best"]);
    // tier products are seeded unpriced — snapshot says so instead of inventing
    expect(tiers[0]!.subtotalCents).toBeNull();
    expect(tiers[0]!.needsCosts).toContain("good:price");
  });

  it("post-versioning: prices ONLY from the current version (no duplicate lines) and stamps its id", async () => {
    const { versionId } = await applyPriceBookVersion({
      tenantId,
      source: "manual",
      changes: [{ key: "field-shingles", unitPriceCents: 14000, unitCostCents: 9000 }],
      defaultMarginFloorBps: 1500,
    });

    const measurementId = await seedMeasurement();
    const est = await createEstimateFromMeasurement({ tenantId, jobId, measurementId });
    expect(est!.priceBookVersionId).toBe(versionId);

    // the versioned price is what got used
    const shingles = (est!.lineItems as { key: string; unitPriceCents: number }[]).find(
      (l) => l.key === "field-shingles",
    )!;
    expect(shingles.unitPriceCents).toBe(14000);

    // live originals + version clones must NOT both appear
    const keys = (est!.lineItems as { key: string }[]).map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
