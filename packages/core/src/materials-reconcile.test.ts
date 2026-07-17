import { describe, it, expect } from "vitest";
import { reconcileMaterialLines, parseProcurementConfig } from "./materials-reconcile";

describe("parseProcurementConfig", () => {
  it("defaults: 10% variance threshold, 14-day return window", () => {
    const cfg = parseProcurementConfig(undefined);
    expect(cfg.varianceThresholdPct).toBe(10);
    expect(cfg.returnWindowDays).toBe(14);
  });
});

describe("reconcileMaterialLines", () => {
  const ordered = [
    { key: "field-shingles", name: "Field shingles", quantity: 30, unitCostCents: 3500 },
    { key: "underlayment", name: "Underlayment", quantity: 10, unitCostCents: 8000 },
  ];

  it("ordered vs invoiced vs used, per key — within threshold stays clean", () => {
    const rows = reconcileMaterialLines({
      ordered,
      invoiced: [{ key: "field-shingles", quantity: 31 }, { key: "underlayment", quantity: 10 }],
      leftover: [{ key: "field-shingles", quantity: 2 }],
    }, 10);
    const shingles = rows.lines.find((l) => l.key === "field-shingles")!;
    expect(shingles.orderedQty).toBe(30);
    expect(shingles.invoicedQty).toBe(31);
    expect(shingles.leftoverQty).toBe(2);
    expect(shingles.usedQty).toBe(29); // invoiced − leftover
    expect(shingles.flagged).toBe(false); // 3.3% variance < 10%
    expect(rows.flagged).toBe(false);
  });

  it("variance beyond the threshold flags the line and the job", () => {
    const rows = reconcileMaterialLines({
      ordered,
      invoiced: [{ key: "field-shingles", quantity: 36 }], // +20%
      leftover: [],
    }, 10);
    const shingles = rows.lines.find((l) => l.key === "field-shingles")!;
    expect(shingles.variancePct).toBe(20);
    expect(shingles.flagged).toBe(true);
    expect(rows.flagged).toBe(true);
  });

  it("an invoiced-only key (never ordered) is always flagged; leftover-only is carried", () => {
    const rows = reconcileMaterialLines({
      ordered,
      invoiced: [{ key: "mystery-sku", quantity: 5 }],
      leftover: [{ key: "underlayment", quantity: 1 }],
    }, 10);
    expect(rows.lines.find((l) => l.key === "mystery-sku")!.flagged).toBe(true);
    expect(rows.lines.find((l) => l.key === "underlayment")!.leftoverQty).toBe(1);
  });
});
