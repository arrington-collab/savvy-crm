import { describe, it, expect } from "vitest";
import { makeFakeRoofr } from "./roofr";

describe("makeFakeRoofr", () => {
  it("orders then returns a ready report with areas + pitch", async () => {
    const roofr = makeFakeRoofr();
    const { orderId } = await roofr.orderMeasurement({ address: "1 Main St" });
    expect(orderId).toMatch(/^roofr_ord_/);
    const rep = await roofr.getReport(orderId);
    expect(rep.ready).toBe(true);
    expect(rep.areas.squares).toBeGreaterThan(0);
    expect(rep.areas.predominantPitch).toMatch(/\/12$/);
    expect(rep.costCents).toBeGreaterThan(0);
  });
});
