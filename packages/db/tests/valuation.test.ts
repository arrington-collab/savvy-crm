import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { job } from "../src/schema/jobs";
import { invoice } from "../src/schema/finance";
import { valuationSnapshot } from "../src/schema/valuation";
import { makeTenant, makeJobWithCustomer } from "./helpers";
import { gatherValuationInputs, listValuationSnapshots, recordValuationSnapshot } from "../src/lifecycle/valuation";

const NOW = new Date("2026-07-01T15:00:00Z");
const PERIOD = "2026-06";

async function seedCompletedJob(tenantId: string, over?: {
  valueFinal?: number; costCents?: number | null; type?: string; monthsAgo?: number;
}) {
  const { jobId, customerId } = await makeJobWithCustomer(tenantId);
  await adminDb.update(job).set({
    stage: "complete",
    type: (over?.type ?? "retail") as "retail",
    valueFinal: over?.valueFinal ?? 2_000_000,
    costCents: over?.costCents === undefined ? 1_100_000 : over.costCents,
    closedAt: new Date(NOW.getTime() - (over?.monthsAgo ?? 2) * 30 * 86_400_000),
  }).where(eq(job.id, jobId));
  return { jobId, customerId };
}

describe("gatherValuationInputs — quality flags tell the truth", () => {
  it("a tenant with real completed-job costing gets real TTM revenue and margin", async () => {
    const { tenantId } = await makeTenant();
    for (let i = 0; i < 4; i++) await seedCompletedJob(tenantId, { monthsAgo: i * 2 + 1 });

    const inputs = await gatherValuationInputs(tenantId, NOW);
    expect(inputs.ttmRevenueCents).toEqual({ value: 8_000_000, quality: "real" });
    expect(inputs.ttmGrossMarginPct.quality).toBe("real");
    expect(inputs.ttmGrossMarginPct.value).toBe(45); // (2.0M-1.1M)/2.0M
    expect(inputs.maintenanceMrrCents.quality).toBe("missing"); // Phase 20 unbuilt
  });

  it("jobs with unknown costs degrade margin quality, never invent a number", async () => {
    const { tenantId } = await makeTenant();
    await seedCompletedJob(tenantId, { monthsAgo: 1 });
    await seedCompletedJob(tenantId, { monthsAgo: 3, costCents: null });

    const inputs = await gatherValuationInputs(tenantId, NOW);
    expect(inputs.ttmGrossMarginPct.quality).toBe("estimated"); // known-cost subset only
  });

  it("backlog counts approved-but-unbuilt jobs only", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(tenantId);
    await adminDb.update(job).set({ stage: "approved", valueEstimate: 3_500_000 }).where(eq(job.id, jobId));
    await seedCompletedJob(tenantId); // complete — not backlog

    const inputs = await gatherValuationInputs(tenantId, NOW);
    expect(inputs.backlogCents).toEqual({ value: 3_500_000, quality: "real" });
  });
});

describe("recordValuationSnapshot — the honesty trail persists", () => {
  it("SPEC RED PATH (valuation.no_placeholder): a data-thin tenant stores insufficient_data with NULL values", async () => {
    const { tenantId } = await makeTenant(); // zero jobs

    await recordValuationSnapshot(tenantId, PERIOD, NOW);

    const [snap] = await adminDb.select().from(valuationSnapshot)
      .where(and(eq(valuationSnapshot.tenantId, tenantId), eq(valuationSnapshot.periodKey, PERIOD)));
    expect(snap!.status).toBe("insufficient_data");
    expect(snap!.valueLowCents).toBeNull();
    expect(snap!.valueLikelyCents).toBeNull();
    expect((snap!.reasons as string[]).length).toBeGreaterThan(0);
    expect(snap!.methodologyVersion).toBeTruthy();
  });

  it("a healthy tenant stores an ok range with the full adjustment ledger", async () => {
    const { tenantId } = await makeTenant();
    for (let i = 0; i < 8; i++) await seedCompletedJob(tenantId, { monthsAgo: (i % 11) + 1 });

    await recordValuationSnapshot(tenantId, PERIOD, NOW);

    const [snap] = await adminDb.select().from(valuationSnapshot)
      .where(and(eq(valuationSnapshot.tenantId, tenantId), eq(valuationSnapshot.periodKey, PERIOD)));
    expect(snap!.status).toBe("ok");
    expect(snap!.valueLowCents!).toBeGreaterThan(0);
    expect(snap!.valueHighCents!).toBeGreaterThan(snap!.valueLowCents!);
    expect((snap!.adjustments as unknown[]).length).toBeGreaterThan(0); // at least data_gaps
  });

  it("monthly idempotency: one row per tenant+period, re-runs refresh in place", async () => {
    const { tenantId } = await makeTenant();
    await recordValuationSnapshot(tenantId, PERIOD, NOW);
    await recordValuationSnapshot(tenantId, PERIOD, NOW);

    const rows = await adminDb.select().from(valuationSnapshot)
      .where(and(eq(valuationSnapshot.tenantId, tenantId), eq(valuationSnapshot.periodKey, PERIOD)));
    expect(rows).toHaveLength(1);
  });
});

describe("listValuationSnapshots", () => {
  it("returns newest-first history for the trend line and quarterly delta", async () => {
    const { tenantId } = await makeTenant();
    await recordValuationSnapshot(tenantId, "2026-04", new Date("2026-05-01T15:00:00Z"));
    await recordValuationSnapshot(tenantId, "2026-05", new Date("2026-06-01T15:00:00Z"));
    await recordValuationSnapshot(tenantId, "2026-06", NOW);

    const snaps = await listValuationSnapshots(tenantId, 2);
    expect(snaps.map((s) => s.periodKey)).toEqual(["2026-06", "2026-05"]);
  });
});
