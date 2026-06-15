import { describe, it, expect } from "vitest";
import { makeFakeQbo } from "./qbo";

describe("makeFakeQbo", () => {
  it("returns deterministic ids and records calls", async () => {
    const qbo = makeFakeQbo();
    const c = await qbo.upsertCustomer({ connectionId: "x", customer: { id: "cust1", name: "Acme" } });
    const i = await qbo.upsertInvoice({ connectionId: "x", qboCustomerId: c.qboId, invoice: { number: "INV-1", lineItems: [], amountCents: 1000, dueAt: null } });
    const p = await qbo.recordPayment({ connectionId: "x", qboInvoiceId: i.qboId, amountCents: 1000, receivedAt: "2026-06-10" });
    expect(c.qboId).toMatch(/^qbo_cust_/);
    expect(i.qboId).toMatch(/^qbo_inv_/);
    expect(p.qboId).toMatch(/^qbo_pmt_/);
    expect(qbo.calls.map((x) => x.op)).toEqual(["customer", "invoice", "payment"]);
  });
});
