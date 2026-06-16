/**
 * Tests for the Roofr order measurement helper.
 *
 * Uses vi.mock for the DB layer (same approach as qbo-sync.test.ts) so no live
 * Postgres connection is needed. The Roofr gateway is injected via makeFakeRoofr.
 *
 * Test approach: UNIT with injected fake gateway + mocked DB layer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeRoofr } from "@savvy/integrations";

// ---------------------------------------------------------------------------
// Mock @savvy/db — withTenant runs fn with a fake tx that captures inserts.
// ---------------------------------------------------------------------------
const inserted: Record<string, unknown>[] = [];
const propertyRow: Record<string, unknown> = {};

vi.mock("@savvy/db", () => {
  return {
    withTenant: async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: () => ({
          from: (table: unknown) => ({
            where: (_cond: unknown) => {
              if (table === mockTables.property) {
                return Promise.resolve([propertyRow.id ? propertyRow : undefined].filter(Boolean));
              }
              return Promise.resolve([]);
            },
          }),
        }),
        insert: (_table: unknown) => ({
          values: (vals: Record<string, unknown>) => ({
            returning: () => {
              const row = { id: `m-${crypto.randomUUID()}`, ...vals };
              inserted.push(row);
              return Promise.resolve([row]);
            },
          }),
        }),
      };
      return fn(tx);
    },
    eq: (_col: unknown, _val: unknown) => ({ __eq: true }),
    // Table sentinels — identity-checked in the mock above.
    measurement: { __table: "measurement" },
    property: { __table: "property" },
  };
});

const mockTables = await import("@savvy/db").then((m) => ({
  measurement: m.measurement,
  property: m.property,
}));

// Import AFTER mock is registered.
import { orderAndPersistMeasurement } from "./roofr-order";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setProperty(overrides: Record<string, unknown> = {}) {
  Object.assign(propertyRow, { id: "prop-1", address: "123 Oak Lane", ...overrides });
}

function clearState() {
  for (const k of Object.keys(propertyRow)) delete propertyRow[k];
  inserted.length = 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("orderAndPersistMeasurement", () => {
  beforeEach(clearState);

  it("orders via the gateway, persists a measurement row with $3 markup cost", async () => {
    setProperty();
    const fake = makeFakeRoofr();

    const result = await orderAndPersistMeasurement("tenant-1", "job-1", "prop-1", fake);

    // Should have called order + getReport
    expect(fake.calls).toContain("order:roofr_ord_1");
    expect(fake.calls).toContain("report:roofr_ord_1");

    // Should have persisted a measurement row
    expect(inserted).toHaveLength(1);
    const row = inserted[0]!;
    expect(row.provider).toBe("roofr");
    expect(row.tenantId).toBe("tenant-1");
    expect(row.propertyId).toBe("prop-1");

    // costCents should include the $3 (300 cents) markup: fake returns 2500 + 300
    expect(row.costCents).toBe(2800);

    // areas and pitch should be stored
    expect((row.areas as Record<string, unknown>).squares).toBe(24.5);
    expect(row.pitch).toBe("7/12");

    // Result has measurementId
    expect("measurementId" in result).toBe(true);
    if ("measurementId" in result) {
      expect(result.measurementId).toMatch(/^m-/);
    }
  });

  it("returns pending when the report is not ready", async () => {
    setProperty();
    // Build a gateway that returns ready:false
    const notReadyGateway = {
      calls: [] as string[],
      async orderMeasurement() {
        return { orderId: "roofr_ord_not_ready" };
      },
      async getReport(orderId: string) {
        this.calls.push(`report:${orderId}`);
        return {
          ready: false,
          areas: {
            squares: 0, predominantPitch: "0/12", ridgeLf: 0, hipLf: 0, valleyLf: 0,
            eaveLf: 0, rakeLf: 0, stepFlashingLf: 0, penetrationCount: 0, facetCount: 0,
          },
          reportUrl: "",
          costCents: 0,
        };
      },
    };

    const result = await orderAndPersistMeasurement("tenant-1", "job-1", "prop-1", notReadyGateway);

    expect("pending" in result).toBe(true);
    if ("pending" in result) {
      expect(result.orderId).toBe("roofr_ord_not_ready");
    }
    // No measurement row should be inserted when report is not ready
    expect(inserted).toHaveLength(0);
  });

  it("uses the property address from the database for the order", async () => {
    setProperty({ address: "456 Maple Ave" });
    const fake = makeFakeRoofr();

    // Intercept the orderMeasurement call to capture the address used
    const originalOrder = fake.orderMeasurement.bind(fake);
    const capturedAddresses: string[] = [];
    fake.orderMeasurement = async (o: { address: string }) => {
      capturedAddresses.push(o.address);
      return originalOrder(o);
    };

    await orderAndPersistMeasurement("tenant-1", "job-1", "prop-1", fake);

    expect(capturedAddresses[0]).toBe("456 Maple Ave");
  });
});
