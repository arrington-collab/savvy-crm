import { test, expect } from "vitest";
import { computeChangeOrderTotal } from "./change-order";

test("sums amountCents into subtotal === total", () => {
  const r = computeChangeOrderTotal([{ amountCents: 12000 }, { amountCents: 8000 }]);
  expect(r).toEqual({ subtotal: 20000, total: 20000 });
});

test("empty lines -> zero", () => {
  expect(computeChangeOrderTotal([])).toEqual({ subtotal: 0, total: 0 });
});

test("supports a negative (credit) line", () => {
  const r = computeChangeOrderTotal([{ amountCents: 10000 }, { amountCents: -3000 }]);
  expect(r).toEqual({ subtotal: 7000, total: 7000 });
});
