/**
 * Tests for QBO sync helper functions.
 *
 * These tests use vi.mock to simulate DB state via withTenant, allowing us to
 * verify skip decisions and gateway call contracts without a real Postgres DB.
 * Integration coverage (full round-trip against a real DB) is deferred to the
 * e2e suite (Task 19).
 *
 * Test approach: UNIT with injected fake gateway + mocked DB layer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeQbo } from "@savvy/integrations";

// ---------------------------------------------------------------------------
// Mock @savvy/db so tests don't need a live Postgres connection.
// withTenant is replaced with a thin shim that runs fn with a fake tx object.
// The mock is a factory so each test can override the simulated DB rows.
// ---------------------------------------------------------------------------
const mockTenantRow: Record<string, unknown> = {};
const mockInvoiceRow: Record<string, unknown> = {};
const mockCustomerRow: Record<string, unknown> = {};
const mockPaymentRow: Record<string, unknown> = {};

// Stored qboId updates captured so idempotency test can verify them.
const updates: { table: string; set: Record<string, unknown>; where: unknown }[] = [];

vi.mock("@savvy/db", () => {
  return {
    withTenant: async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: () => ({
          from: (table: unknown) => ({
            where: (_cond: unknown) => {
              // Route by table reference identity — tables are module-level objects.
              if (table === mockTables.tenant) return Promise.resolve([mockTenantRow.id ? mockTenantRow : undefined].filter(Boolean));
              if (table === mockTables.invoice) return Promise.resolve([mockInvoiceRow.id ? mockInvoiceRow : undefined].filter(Boolean));
              if (table === mockTables.customer) return Promise.resolve([mockCustomerRow.id ? mockCustomerRow : undefined].filter(Boolean));
              if (table === mockTables.payment) return {
                orderBy: (_o: unknown) => Promise.resolve([mockPaymentRow.id ? mockPaymentRow : undefined].filter(Boolean)),
              };
              return Promise.resolve([]);
            },
          }),
        }),
        update: (table: unknown) => ({
          set: (vals: Record<string, unknown>) => ({
            where: (cond: unknown) => {
              const name = table === mockTables.invoice ? "invoice"
                : table === mockTables.customer ? "customer"
                : table === mockTables.payment ? "payment"
                : "unknown";
              updates.push({ table: name, set: vals, where: cond });
              // Simulate write-back so idempotency check can see updated qboId.
              if (table === mockTables.invoice) Object.assign(mockInvoiceRow, vals);
              if (table === mockTables.customer) Object.assign(mockCustomerRow, vals);
              if (table === mockTables.payment) Object.assign(mockPaymentRow, vals);
              return Promise.resolve();
            },
          }),
        }),
      };
      return fn(tx);
    },
    eq: (_col: unknown, _val: unknown) => ({ __eq: true }),
    and: (...args: unknown[]) => ({ __and: args }),
    // Table sentinels — objects so identity checks work.
    tenant: { __table: "tenant" },
    invoice: { __table: "invoice" },
    payment: { __table: "payment" },
    customer: { __table: "customer" },
  };
});

// Capture the table sentinels from the mock so routing works above.
const mockTables = await import("@savvy/db").then((m) => ({
  tenant: m.tenant,
  invoice: m.invoice,
  payment: m.payment,
  customer: m.customer,
}));

// Import AFTER mock is registered.
import { ensureCustomerAndInvoice, pushPaymentToQbo } from "./qbo-sync";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setTenant(overrides: Record<string, unknown> = {}) {
  Object.assign(mockTenantRow, { id: "tenant-1", qboConnectionId: "conn-abc", ...overrides });
}
function setInvoice(overrides: Record<string, unknown> = {}) {
  Object.assign(mockInvoiceRow, {
    id: "inv-1",
    qboId: null,
    customerId: "cust-1",
    number: "INV-001",
    lineItems: [],
    amountDue: 5000,
    dueAt: new Date("2026-12-31"),
    ...overrides,
  });
}
function setCustomer(overrides: Record<string, unknown> = {}) {
  Object.assign(mockCustomerRow, { id: "cust-1", name: "ACME Roofing", email: "acme@example.com", qboId: null, ...overrides });
}
function setPayment(overrides: Record<string, unknown> = {}) {
  Object.assign(mockPaymentRow, {
    id: "pmt-1",
    invoiceId: "inv-1",
    amount: 5000,
    qboId: null,
    receivedAt: new Date("2026-06-01"),
    ...overrides,
  });
}

function clearRows() {
  for (const k of Object.keys(mockTenantRow)) delete mockTenantRow[k];
  for (const k of Object.keys(mockInvoiceRow)) delete mockInvoiceRow[k];
  for (const k of Object.keys(mockCustomerRow)) delete mockCustomerRow[k];
  for (const k of Object.keys(mockPaymentRow)) delete mockPaymentRow[k];
  updates.length = 0;
}

// ---------------------------------------------------------------------------
// Tests: ensureCustomerAndInvoice
// ---------------------------------------------------------------------------
describe("ensureCustomerAndInvoice", () => {
  beforeEach(clearRows);

  it("skips when tenant has no QBO connection", async () => {
    setTenant({ qboConnectionId: null });
    const fake = makeFakeQbo();
    const result = await ensureCustomerAndInvoice("tenant-1", "inv-1", fake);
    expect(result).toEqual({ skipped: "not_connected" });
    expect(fake.calls).toHaveLength(0);
  });

  it("skips when invoice does not exist", async () => {
    setTenant();
    // mockInvoiceRow has no id → resolves to []
    const fake = makeFakeQbo();
    const result = await ensureCustomerAndInvoice("tenant-1", "inv-missing", fake);
    expect(result).toEqual({ skipped: "no_invoice" });
    expect(fake.calls).toHaveLength(0);
  });

  it("returns existing qboInvoiceId without calling gateway (idempotent)", async () => {
    setTenant();
    setInvoice({ qboId: "qbo_inv_existing" });
    const fake = makeFakeQbo();
    const result = await ensureCustomerAndInvoice("tenant-1", "inv-1", fake);
    expect(result).toEqual({ qboInvoiceId: "qbo_inv_existing" });
    expect(fake.calls).toHaveLength(0); // no gateway calls on repeat
  });

  it("upserts customer then invoice when both are new, and stores qboIds", async () => {
    setTenant();
    setInvoice();
    setCustomer();
    const fake = makeFakeQbo();
    const result = await ensureCustomerAndInvoice("tenant-1", "inv-1", fake);
    expect("qboInvoiceId" in result).toBe(true);
    // Both customer and invoice should have been upserted.
    expect(fake.calls.map((c) => c.op)).toEqual(["customer", "invoice"]);
    // qboId should have been written back to both rows.
    const custUpdate = updates.find((u) => u.table === "customer");
    expect(custUpdate?.set).toMatchObject({ qboId: expect.stringContaining("qbo_cust") });
    const invUpdate = updates.find((u) => u.table === "invoice");
    expect(invUpdate?.set).toMatchObject({ qboId: expect.stringContaining("qbo_inv") });
  });

  it("skips customer upsert when customer already has qboId", async () => {
    setTenant();
    setInvoice();
    setCustomer({ qboId: "qbo_cust_existing" });
    const fake = makeFakeQbo();
    await ensureCustomerAndInvoice("tenant-1", "inv-1", fake);
    // Only invoice upsert — customer already synced.
    expect(fake.calls.map((c) => c.op)).toEqual(["invoice"]);
  });
});

// ---------------------------------------------------------------------------
// Tests: pushPaymentToQbo
// ---------------------------------------------------------------------------
describe("pushPaymentToQbo", () => {
  beforeEach(clearRows);

  it("skips when tenant has no QBO connection", async () => {
    setTenant({ qboConnectionId: null });
    const fake = makeFakeQbo();
    const result = await pushPaymentToQbo("tenant-1", "inv-1", "qbo_inv_1", fake);
    expect(result).toEqual({ skipped: "not_connected" });
    expect(fake.calls).toHaveLength(0);
  });

  it("skips when no unsynced payment exists", async () => {
    setTenant();
    // no payment row
    const fake = makeFakeQbo();
    const result = await pushPaymentToQbo("tenant-1", "inv-1", "qbo_inv_1", fake);
    expect(result).toEqual({ skipped: "no_unsynced_payment" });
    expect(fake.calls).toHaveLength(0);
  });

  it("skips when payment already has qboId (idempotent)", async () => {
    setTenant();
    setPayment({ qboId: "qbo_pmt_existing" });
    const fake = makeFakeQbo();
    const result = await pushPaymentToQbo("tenant-1", "inv-1", "qbo_inv_1", fake);
    expect(result).toEqual({ skipped: "no_unsynced_payment" });
    expect(fake.calls).toHaveLength(0);
  });

  it("records payment and stores qboId when unsynced", async () => {
    setTenant();
    setPayment();
    const fake = makeFakeQbo();
    const result = await pushPaymentToQbo("tenant-1", "inv-1", "qbo_inv_1", fake);
    expect("qboPaymentId" in result).toBe(true);
    expect(fake.calls.map((c) => c.op)).toEqual(["payment"]);
    const pmtUpdate = updates.find((u) => u.table === "payment");
    expect(pmtUpdate?.set).toMatchObject({ qboId: expect.stringContaining("qbo_pmt") });
  });
});
