import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  customer,
  property,
  lead,
  measurement,
  tierProduct,
  document,
  eq,
  ensurePriceBook,
  ensureTierProducts,
  ensureEstimateLink,
  setEstimateStatus,
  createEstimateFromMeasurement,
  attachEstimateVideo,
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
  const stamp = `${Date.now().toString(36)}v`;
  const ids = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: `Video-${stamp}`, phone: "+15555559955" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Reel Rd`, city: "Phoenix" }).returning();
    const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "referral", status: "qualified" }).returning();
    const [m] = await tx.insert(measurement).values({
      tenantId, propertyId: p!.id, provider: "roofr",
      areas: { squares: 21, predominantPitch: "5/12", eaveLf: 100, rakeLf: 50 },
    }).returning();
    return { leadId: l!.id, measurementId: m!.id };
  });
  const est = await createEstimateFromMeasurement({ tenantId, leadId: ids.leadId, measurementId: ids.measurementId });
  estimateId = est!.id;
  await setEstimateStatus({ tenantId, estimateId, status: "sent" });
  ({ code } = await ensureEstimateLink({ tenantId, estimateId }));
});

test("owner batch queue shows yesterday's estimate with the zero-lookup card", async ({ page }) => {
  await page.goto("/videos/batch");
  await expect(page.getByTestId("batch-recorder").or(page.getByTestId("video-queue-empty"))).toBeVisible({ timeout: 20_000 });
  // our freshly-sent estimate must be somewhere in the queue — surface check
  await expect(page.getByTestId("batch-card")).toBeVisible();
});

test("an approved rep take renders above the tiers; unapproved takes never show", async ({ page }) => {
  // unapproved take → nothing renders
  const doc1 = await withTenant(tenantId, async (tx) => {
    const [d] = await tx.insert(document).values({ tenantId, kind: "video", label: "take-1", r2Key: `videos/e2e/${estimateId}/a.webm`, mime: "video/webm", source: "savvy" }).returning();
    return d!.id;
  });
  await attachEstimateVideo({ tenantId, estimateId, role: "rep", documentId: doc1, approved: false });
  await page.goto(`/estimate/${code}`);
  await expect(page.getByTestId("estimate-page")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("estimate-video")).toHaveCount(0);

  // approved take → the slot appears
  const doc2 = await withTenant(tenantId, async (tx) => {
    const [d] = await tx.insert(document).values({ tenantId, kind: "video", label: "take-2", r2Key: `videos/e2e/${estimateId}/b.webm`, mime: "video/webm", source: "savvy" }).returning();
    return d!.id;
  });
  await attachEstimateVideo({ tenantId, estimateId, role: "rep", documentId: doc2, approved: true });
  await page.reload();
  await expect(page.getByTestId("estimate-video")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("estimate-video")).toContainText("From your inspection visit");
});
