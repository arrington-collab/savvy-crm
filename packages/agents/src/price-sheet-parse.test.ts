import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminDb, adminPool, tenant, agentRun, eq } from "@savvy/db";
import { ensureTenantForOrg, ensurePriceBook } from "@savvy/db";
import { parsePriceSheet } from "./price-sheet-parse";

let tenantId: string;

beforeAll(async () => {
  const t = await ensureTenantForOrg({ clerkOrgId: `org_sheet_${Date.now()}`, name: "Sheet Test" });
  tenantId = t.id;
  await ensurePriceBook(tenantId);
});

afterAll(async () => {
  const { priceBookItem, tenantTaskConfig } = await import("@savvy/db");
  await adminDb.delete(agentRun).where(eq(agentRun.tenantId, tenantId));
  await adminDb.delete(priceBookItem).where(eq(priceBookItem.tenantId, tenantId));
  await adminDb.delete(tenantTaskConfig).where(eq(tenantTaskConfig.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminPool.end();
});

describe("parsePriceSheet", () => {
  it("turns AI-extracted lines into a grounded cost diff (bogus keys fall back to name match / unmatched)", async () => {
    const fakeAi = {
      completeObject: async () => ({
        object: {
          lines: [
            { name: "Field shingles arch.", unitCostCents: 9200, matchedKey: "field-shingles" },
            { name: "Drip edge", unitCostCents: 120, matchedKey: "not-a-real-key" }, // bogus → name match
            { name: "Mystery sealant", unitCostCents: 700, matchedKey: null }, // truly unknown
          ],
        },
        model: "stub-model",
      }),
    };

    const out = await parsePriceSheet({ tenantId, rawText: "ABC SUPPLY PRICE SHEET ..." }, fakeAi);
    expect(out.model).toBe("stub-model");
    const keys = out.diff.changes.map((c) => c.key).sort();
    expect(keys).toEqual(["drip-edge", "field-shingles"]);
    expect(out.diff.changes.find((c) => c.key === "field-shingles")!.newCostCents).toBe(9200);
    expect(out.diff.unmatched.map((u) => u.name)).toEqual(["Mystery sealant"]);

    const runs = await adminDb.select().from(agentRun).where(eq(agentRun.tenantId, tenantId));
    expect(runs.some((r) => r.taskKey === "price-book.sheet-parse" && r.status === "ok")).toBe(true);
  });

  it("logs an error agent_run and rethrows when the AI call fails", async () => {
    const boomAi = { completeObject: async () => { throw new Error("gateway down"); } };
    await expect(parsePriceSheet({ tenantId, rawText: "x" }, boomAi)).rejects.toThrow("gateway down");
    const runs = await adminDb.select().from(agentRun).where(eq(agentRun.tenantId, tenantId));
    expect(runs.some((r) => r.taskKey === "price-book.sheet-parse" && r.status === "error")).toBe(true);
  });
});
