import { describe, it, expect, beforeAll } from "vitest";
import { createEstimateFromMeasurement, setEstimateStatus } from "../src/lifecycle/estimate.js";
import { ensurePriceBook, ensureTierProducts } from "../src/lifecycle/price-book.js";
import { ensureEstimateLink, setEstimateSelection } from "../src/lifecycle/estimate-page.js";
import { withTenant } from "../src/tenant.js";
import { bookingLink } from "../src/schema/index.js";
import { estimate } from "../src/schema/finance.js";
import { measurement } from "../src/schema/ops.js";
import { tierProduct } from "../src/schema/pricing.js";
import { eq, and } from "drizzle-orm";
import { makeTenant, makeJobWithProperty } from "./helpers.js";

let tenantId: string;
let estimateId: string;

beforeAll(async () => {
  const t = await makeTenant();
  tenantId = t.tenantId;
  const { jobId, propertyId } = await makeJobWithProperty(tenantId);
  await ensurePriceBook(tenantId);
  await ensureTierProducts(tenantId);
  // price the tiers so the snapshot has real subtotals + selectable state
  await withTenant(tenantId, (tx) =>
    tx.update(tierProduct).set({ unitPriceCents: 20000, unitCostCents: 12000 }),
  );
  const measurementId = await withTenant(tenantId, async (tx) => {
    const [m] = await tx.insert(measurement).values({
      tenantId, propertyId, provider: "roofr",
      areas: { squares: 20, predominantPitch: "6/12", eaveLf: 100, rakeLf: 50, ridgeLf: 30 },
    }).returning();
    return m!.id;
  });
  const est = await createEstimateFromMeasurement({ tenantId, jobId, measurementId });
  estimateId = est!.id;
});

describe("estimate page link", () => {
  it("mints exactly one link per estimate, idempotently, and auto-mints on send", async () => {
    const first = await ensureEstimateLink({ tenantId, estimateId });
    const again = await ensureEstimateLink({ tenantId, estimateId });
    expect(again.code).toBe(first.code);

    // sending also ensures a link (chokepoint), still just one row
    await setEstimateStatus({ tenantId, estimateId, status: "sent" });
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(bookingLink).where(and(eq(bookingLink.tenantId, tenantId), eq(bookingLink.kind, "estimate"))),
    );
    expect(rows).toHaveLength(1);
  });

  it("send alone mints the link (no prior ensureEstimateLink call)", async () => {
    // a SECOND estimate that has never been touched by ensureEstimateLink
    const { jobId: j2 } = await makeJobWithProperty(tenantId);
    const m2 = await withTenant(tenantId, async (tx) => {
      const [prop] = await tx.select({ propertyId: estimate.propertyId }).from(estimate).where(eq(estimate.id, estimateId));
      const [m] = await tx.insert(measurement).values({
        tenantId, propertyId: prop!.propertyId!, provider: "roofr",
        areas: { squares: 15, predominantPitch: "4/12", eaveLf: 80, rakeLf: 40 },
      }).returning();
      return m!.id;
    });
    const est2 = await createEstimateFromMeasurement({ tenantId, jobId: j2, measurementId: m2 });
    await setEstimateStatus({ tenantId, estimateId: est2!.id, status: "sent" });

    const { estimateLinkToken } = await import("../src/lifecycle/estimate-page.js");
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(bookingLink).where(eq(bookingLink.token, estimateLinkToken(tenantId, est2!.id))),
    );
    expect(rows).toHaveLength(1);
  });
});

describe("setEstimateSelection", () => {
  it("stores a valid tier+color pick and rejects colors outside the tier's palette", async () => {
    const ok = await setEstimateSelection({ tenantId, estimateId, tier: "better", color: "Granite Black" });
    expect(ok).toEqual({ ok: true });
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(estimate).where(eq(estimate.id, estimateId)));
    expect(row!.selectedTier).toBe("better");
    expect(row!.selectedColor).toBe("Granite Black");

    const bad = await setEstimateSelection({ tenantId, estimateId, tier: "better", color: "Neon Pink" });
    expect(bad).toEqual({ ok: false, error: "invalid_color" });

    const badTier = await setEstimateSelection({ tenantId, estimateId, tier: "platinum" as never, color: "Granite Black" });
    expect(badTier).toEqual({ ok: false, error: "invalid_tier" });
  });
});
