import { describe, expect, it } from "vitest";
import type { EstimateLineItem } from "./estimate-engine";
import {
  MATERIAL_ORDER_STATUS,
  DELIVERY_BUFFER_DAYS,
  materialLinesFromEstimate,
  materialOrderSubtotalCents,
  neededByFromInstall,
  materialDeliveryFlag,
  type MaterialOrderLine,
} from "./material-order";

const lineItems: EstimateLineItem[] = [
  { key: "shingles", name: "Architectural shingles", category: "material", unit: "square", quantity: 30, unitPriceCents: 12000, amountCents: 360000 },
  { key: "underlayment", name: "Synthetic underlayment", category: "material", unit: "square", quantity: 30, unitPriceCents: 2000, amountCents: 60000 },
  { key: "labor", name: "Tear-off + install", category: "labor", unit: "square", quantity: 30, unitPriceCents: 9000, amountCents: 270000 },
  { key: "ridgevent", name: "Ridge vent", category: "accessory", unit: "lf", quantity: 40, unitPriceCents: 800, amountCents: 32000 },
];

describe("MATERIAL_ORDER_STATUS", () => {
  it("is the four-state lifecycle", () => {
    expect(MATERIAL_ORDER_STATUS).toEqual(["draft", "ordered", "delivered", "canceled"]);
  });
});

describe("materialLinesFromEstimate", () => {
  it("keeps only material lines and projects the BOM fields", () => {
    const lines = materialLinesFromEstimate(lineItems);
    expect(lines.map((l) => l.key)).toEqual(["shingles", "underlayment"]);
    expect(lines[0]).toEqual({
      key: "shingles", name: "Architectural shingles", quantity: 30,
      unit: "square", unitPriceCents: 12000, amountCents: 360000,
    } satisfies MaterialOrderLine);
  });
  it("returns [] when there are no material lines", () => {
    expect(materialLinesFromEstimate([lineItems[2]!])).toEqual([]);
  });
});

describe("materialOrderSubtotalCents", () => {
  it("sums line amountCents", () => {
    expect(materialOrderSubtotalCents(materialLinesFromEstimate(lineItems))).toBe(420000);
  });
  it("is 0 for no lines", () => {
    expect(materialOrderSubtotalCents([])).toBe(0);
  });
});

describe("neededByFromInstall", () => {
  it("subtracts the buffer days from the install date", () => {
    const install = new Date("2026-07-10T00:00:00.000Z");
    expect(neededByFromInstall(install)).toEqual(new Date("2026-07-08T00:00:00.000Z"));
    expect(DELIVERY_BUFFER_DAYS).toBe(2);
  });
  it("returns null when there is no install date", () => {
    expect(neededByFromInstall(null)).toBeNull();
  });
});

describe("materialDeliveryFlag", () => {
  it("no_install when nothing is scheduled", () => {
    expect(materialDeliveryFlag({ neededByAt: null, installAt: null })).toBe("no_install");
  });
  it("no_install when there is no needed-by even if install exists", () => {
    expect(materialDeliveryFlag({ neededByAt: null, installAt: new Date("2026-07-10T00:00:00Z") })).toBe("no_install");
  });
  it("misaligned when delivery target is after the install date", () => {
    expect(materialDeliveryFlag({
      neededByAt: new Date("2026-07-11T00:00:00Z"),
      installAt: new Date("2026-07-10T00:00:00Z"),
    })).toBe("misaligned");
  });
  it("none when delivery lands on or before install", () => {
    expect(materialDeliveryFlag({
      neededByAt: new Date("2026-07-08T00:00:00Z"),
      installAt: new Date("2026-07-10T00:00:00Z"),
    })).toBe("none");
  });
});
