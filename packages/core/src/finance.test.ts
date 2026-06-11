import { test, expect } from "vitest";
import { computeInvoiceTotal, formatInvoiceNumber, parseFinanceConfig } from "./finance";

test("computeInvoiceTotal sums qty*unitAmountCents", () => {
  expect(computeInvoiceTotal([])).toBe(0);
  expect(computeInvoiceTotal([{ description: "Roof", qty: 2, unitAmountCents: 150000 }])).toBe(300000);
  expect(computeInvoiceTotal([
    { description: "A", qty: 1, unitAmountCents: 999 },
    { description: "B", qty: 3, unitAmountCents: 100 },
  ])).toBe(1299);
});

test("formatInvoiceNumber zero-pads to 6", () => {
  expect(formatInvoiceNumber("INV-", 123)).toBe("INV-000123");
  expect(formatInvoiceNumber("INV-", 1)).toBe("INV-000001");
});

test("parseFinanceConfig fills defaults", () => {
  expect(parseFinanceConfig(undefined).invoiceNumberPrefix).toBe("INV-");
  expect(parseFinanceConfig(undefined).netDays).toBe(14);
  expect(parseFinanceConfig({ netDays: 30 }).netDays).toBe(30);
});

test("finance config defaults include dunning + commission", () => {
  const cfg = parseFinanceConfig(undefined);
  expect(cfg.timezone).toBe("America/Phoenix");
  expect(cfg.dunning).toEqual({
    enabled: true, smsEscalationDay: 30, quietHours: { startHour: 21, endHour: 8 },
  });
  expect(cfg.commission).toEqual({
    model: "flat", rate: 1000, tiers: [], period: "monthly", perRepRate: {},
  });
});

test("finance config rejects an invalid timezone", () => {
  expect(() => parseFinanceConfig({ timezone: "Not/AZone" })).toThrow();
  expect(parseFinanceConfig({ timezone: "America/New_York" }).timezone).toBe("America/New_York");
});

test("finance config merges partial overrides", () => {
  const cfg = parseFinanceConfig({ commission: { model: "tiered", rate: 800 } });
  expect(cfg.commission.model).toBe("tiered");
  expect(cfg.commission.rate).toBe(800);
  expect(cfg.commission.period).toBe("monthly"); // default still applied
});
