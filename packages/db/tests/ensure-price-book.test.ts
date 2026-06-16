import { describe, it, expect } from "vitest";
import { ensurePriceBook } from "../src/lifecycle/price-book.js";
import { withTenant } from "../src/tenant.js";
import { priceBookItem } from "../src/schema/pricing.js";
import { makeTenant } from "./helpers.js";

describe("ensurePriceBook", () => {
  it("seeds defaults once, idempotent", async () => {
    const { tenantId } = await makeTenant();
    const a = await ensurePriceBook(tenantId);
    expect(a.seeded).toBeGreaterThan(5);
    const b = await ensurePriceBook(tenantId); // no-op
    expect(b.seeded).toBe(0);
    const rows = await withTenant(tenantId, (tx) => tx.select().from(priceBookItem));
    expect(rows.length).toBe(a.seeded);
    expect(rows.find((r) => r.key === "field-shingles")?.wasteApplies).toBe(true);
  });
});
