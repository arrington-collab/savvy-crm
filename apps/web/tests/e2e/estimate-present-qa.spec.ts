import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  adminDb,
  customer,
  property,
  lead,
  measurement,
  tierProduct,
  tenant,
  estimateEvent,
  eq,
  and,
  inArray,
  sql,
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
  // Why Us content block (owner-editable Library config)
  await adminDb
    .update(tenant)
    .set({
      settings: sql`coalesce(${tenant.settings}, '{}'::jsonb) || '{"whyUs": {"story": "Two brothers, one promise: roofs done right.", "yearsLine": "Family-run in Phoenix since 2009", "workmanshipPromise": "If it leaks, we fix it. Period.", "timeline": ["Sign & schedule", "Materials arrive", "One-day install", "Final walkthrough"]}}'::jsonb`,
    })
    .where(eq(tenant.id, tenantId));

  const stamp = `${Date.now().toString(36)}p`;
  const ids = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: `Present-${stamp}`, phone: "+15555559944" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Table Ct`, city: "Phoenix", state: "AZ" }).returning();
    const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "referral", status: "qualified" }).returning();
    const [m] = await tx.insert(measurement).values({
      tenantId, propertyId: p!.id, provider: "roofr",
      areas: { squares: 26, predominantPitch: "7/12", eaveLf: 130, rakeLf: 70, ridgeLf: 45, facetCount: 6 },
    }).returning();
    return { leadId: l!.id, measurementId: m!.id };
  });
  const est = await createEstimateFromMeasurement({ tenantId, leadId: ids.leadId, measurementId: ids.measurementId });
  estimateId = est!.id;
  await setEstimateStatus({ tenantId, estimateId, status: "sent" });
  ({ code } = await ensureEstimateLink({ tenantId, estimateId }));
});

test("present mode: full-screen walkthrough — roof → suggestions → options with the accept flow", async ({ page }) => {
  await page.goto(`/estimate/${code}?present=1`);
  await expect(page.getByTestId("present-mode")).toBeVisible({ timeout: 20_000 });

  // Step 1: the roof — measurement stats
  await expect(page.getByTestId("present-roof")).toContainText("26 squares");
  await expect(page.getByTestId("present-roof")).toContainText("7/12");

  // Step 2: suggestions
  await page.getByTestId("present-next").click();
  await expect(page.getByTestId("present-suggestions")).toBeVisible();

  // Step 3: options — the same tier cards + accept flow, at the table
  await page.getByTestId("present-next").click();
  await expect(page.getByTestId("present-options")).toBeVisible();
  await expect(page.getByTestId("tier-card-better")).toContainText("IKO Dynasty");
  await expect(page.getByTestId("accept-cta")).toBeVisible();

  // Exit returns to the normal page
  await page.getByTestId("present-exit").click();
  await expect(page.getByTestId("estimate-page")).toBeVisible({ timeout: 20_000 });
});

test("why-us block renders the owner's Library content on the estimate page", async ({ page }) => {
  await page.goto(`/estimate/${code}`);
  await expect(page.getByTestId("estimate-why-us")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("estimate-why-us")).toContainText("Family-run in Phoenix since 2009");
  await expect(page.getByTestId("estimate-why-us")).toContainText("If it leaks, we fix it");
});

test("page Q&A answers (or escalates) and logs the exchange as objection data", async ({ page }) => {
  await page.goto(`/estimate/${code}`);
  await expect(page.getByTestId("estimate-qa")).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("qa-input").fill("What warranty comes with the middle option?");
  await page.getByTestId("qa-send").click();

  // Either a grounded answer or the escalation handoff — both are valid
  // outcomes with the e2e AI stub; the invariant is a bubble + a logged event.
  await expect(page.getByTestId("qa-answer").or(page.getByTestId("qa-escalated"))).toBeVisible({ timeout: 30_000 });

  await expect
    .poll(
      async () => {
        const rows = await withTenant(tenantId, (tx) =>
          tx
            .select({ kind: estimateEvent.kind })
            .from(estimateEvent)
            .where(and(eq(estimateEvent.estimateId, estimateId), inArray(estimateEvent.kind, ["question", "question_escalated"]))),
        );
        return rows.length;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
});
