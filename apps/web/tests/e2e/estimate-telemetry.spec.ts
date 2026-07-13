import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  customer,
  property,
  lead,
  measurement,
  tierProduct,
  estimateEvent,
  eq,
  and,
  ensurePriceBook,
  ensureTierProducts,
  ensureEstimateLink,
  setEstimateStatus,
  createEstimateFromMeasurement,
  withTenant,
} from "@savvy/db";

const tenantId = process.env.TEST_TENANT_ID ?? JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")).id;

let code: string;
let estimateId: string;

test.beforeAll(async () => {
  await ensurePriceBook(tenantId);
  await ensureTierProducts(tenantId);
  await withTenant(tenantId, (tx) =>
    tx.update(tierProduct).set({ unitPriceCents: 21000, unitCostCents: 12500 }).where(eq(tierProduct.tenantId, tenantId)),
  );
  const stamp = `${Date.now().toString(36)}t`;
  const ids = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: `Telem-${stamp}`, phone: "+15555559933" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Beacon Rd`, city: "Phoenix", state: "AZ" }).returning();
    const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "referral", status: "qualified" }).returning();
    const [m] = await tx.insert(measurement).values({
      tenantId, propertyId: p!.id, provider: "roofr",
      areas: { squares: 18, predominantPitch: "5/12", eaveLf: 90, rakeLf: 45 },
    }).returning();
    return { leadId: l!.id, measurementId: m!.id };
  });
  const est = await createEstimateFromMeasurement({ tenantId, leadId: ids.leadId, measurementId: ids.measurementId });
  estimateId = est!.id;
  await setEstimateStatus({ tenantId, estimateId, status: "sent" });
  ({ code } = await ensureEstimateLink({ tenantId, estimateId }));
});

test("page beacons land as first-party estimate events (open, tier_view, color_play)", async ({ page }) => {
  await page.goto(`/estimate/${code}`);
  await expect(page.getByTestId("estimate-page")).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("tier-card-best").click();
  await page.getByTestId("tier-card-better").click();
  await page.getByTestId("color-granite-black").click();
  await expect(page.getByTestId("color-granite-black")).toContainText("✓");

  await expect
    .poll(
      async () => {
        const rows = await withTenant(tenantId, (tx) =>
          tx
            .select({ kind: estimateEvent.kind })
            .from(estimateEvent)
            .where(and(eq(estimateEvent.tenantId, tenantId), eq(estimateEvent.estimateId, estimateId))),
        );
        return rows.map((r) => r.kind).sort();
      },
      { timeout: 15_000 },
    )
    .toEqual(expect.arrayContaining(["open", "tier_view", "color_play"]));
});
