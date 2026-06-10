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
  expect(parseFinanceConfig(undefined)).toEqual({ netDays: 14, invoiceNumberPrefix: "INV-" });
  expect(parseFinanceConfig({ netDays: 30 })).toEqual({ netDays: 30, invoiceNumberPrefix: "INV-" });
});
