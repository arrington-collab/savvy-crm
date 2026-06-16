import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { priceBookItem } from "../src/schema/pricing.js";
import { makeTenant } from "./helpers.js";

describe("price_book_item", () => {
  it("inserts and reads back, tenant-scoped", async () => {
    const { tenantId } = await makeTenant();
    const row = await withTenant(tenantId, async (tx) => {
      const [r] = await tx.insert(priceBookItem).values({
        tenantId, key: "field-shingles", name: "Field shingles", category: "material",
        unit: "square", unitPriceCents: 12000, sourceFields: ["squares"], wasteApplies: true,
      }).returning();
      return r;
    });
    expect(row.wasteApplies).toBe(true);
    expect(row.sourceFields).toEqual(["squares"]);
  });
});
