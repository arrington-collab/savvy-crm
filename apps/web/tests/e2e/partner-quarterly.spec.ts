import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  adminDb, eq, and,
  partner, partnerReport, customer, property, lead, job,
  findOrCreatePartner, generateQuarterlyPartnerReports,
} from "@savvy/db";

const tenantId = process.env.TEST_TENANT_ID ?? JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")).id;
const stamp = Date.now().toString(36);

test("quarterly cycle: generation → thank-you page (no shame mechanics) → internal ranking", async ({ page }) => {
  // An A-graded partner with one prior-quarter referral that became a project.
  const { id: pid } = await findOrCreatePartner(tenantId, { name: `Quarterly Ada ${stamp}`, org: "Q Realty", class: "realtor" });
  await adminDb.update(partner)
    .set({ grade: "A", gradedAt: new Date(), createdAt: new Date(Date.now() - 200 * 86_400_000) })
    .where(eq(partner.id, pid));

  const qStart = new Date(); qStart.setUTCMonth(Math.floor(qStart.getUTCMonth() / 3) * 3, 1);
  const inPriorQuarter = new Date(qStart.getTime() - 40 * 86_400_000);
  const [c] = await adminDb.insert(customer).values({ tenantId, name: `Q Cust ${stamp}` }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Quarterly Way` }).returning();
  const [l] = await adminDb.insert(lead).values({
    tenantId, customerId: c!.id, propertyId: p!.id, source: "realtor", partnerId: pid, createdAt: inPriorQuarter,
  }).returning();
  await adminDb.insert(job).values({
    tenantId, customerId: c!.id, propertyId: p!.id, leadId: l!.id, type: "retail", stage: "production", createdAt: inPriorQuarter,
  });

  const gen = await generateQuarterlyPartnerReports(tenantId, new Date());
  expect(gen.generated).toBeGreaterThanOrEqual(1);

  const [report] = await adminDb.select().from(partnerReport)
    .where(and(eq(partnerReport.tenantId, tenantId), eq(partnerReport.partnerId, pid)));
  expect(report!.reportCode).toBeTruthy();
  expect(report!.touchId).toBeTruthy();

  // Partner-facing page: gratitude + honest outcomes, zero internal economics.
  await page.goto(`/partner-report/${report!.reportCode}`);
  await expect(page.getByTestId("partner-report-page")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Thank you, Quarterly/ })).toBeVisible();
  await expect(page.getByTestId("partner-report-outcomes")).toContainText("referral you sent us");
  await expect(page.getByTestId("partner-report-outcomes")).toContainText("became a project");
  const body = await page.textContent("body");
  expect(body).not.toMatch(/grade|Grade|net|Net|cost|Cost|rank/); // no shame mechanics, no economics

  // Internal ranking shows the partner with grade + net.
  await page.goto("/partners/quarterly");
  await expect(page.getByTestId("partners-quarterly-page")).toBeVisible();
  const row = page.getByTestId("quarterly-row").filter({ hasText: `Quarterly Ada ${stamp}` });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("A");
});
