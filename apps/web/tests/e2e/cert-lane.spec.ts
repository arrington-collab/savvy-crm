import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  adminDb, eq, and,
  certRequest, inspection, inspectionZone, inspectionFinding, invoice, job, property,
  findOrCreatePartner, sweepCertRequests,
} from "@savvy/db";

const tenantId = process.env.TEST_TENANT_ID ?? JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")).id;
const stamp = Date.now().toString(36);

test("cert lane: request → book → approve → auto-deliver → paid deliverable with no free-repair marketing", async ({ page }) => {
  await findOrCreatePartner(tenantId, { name: `Cert Agent ${stamp}`, org: "Escrow Co", class: "realtor" });

  // 1. Office creates the request through the UI.
  await page.goto("/partners/certs");
  await page.getByTestId("cert-new").click();
  await page.getByTestId("partner-search").fill(`Cert Agent ${stamp}`);
  // The dropdown also renders the '+ Add "…"' row — target the match's full
  // accessible name so the locator is unambiguous.
  await page.getByTestId("partner-matches").getByRole("button", { name: `Cert Agent ${stamp} — Escrow Co` }).click();
  await page.getByTestId("cert-customer-name").fill(`Cert Seller ${stamp}`);
  await page.getByTestId("cert-address").fill(`${stamp} Closing Ct, Mesa AZ`);
  await page.getByTestId("cert-create").click();

  const row = page.getByTestId("cert-row").filter({ hasText: `${stamp} Closing Ct` });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Requested");
  await expect(row).toContainText("$195");

  // 2. Book the inspection through the UI.
  await row.getByTestId("cert-book").click();
  const tomorrow = new Date(Date.now() + 26 * 3_600_000);
  const local = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await row.getByTestId("cert-book-start").fill(local);
  await row.getByTestId("cert-book-confirm").click();
  await expect(row).toContainText("Booked");

  // 3. The inspector completes + approves (Roof Record machinery — driven directly).
  const [prop] = await adminDb.select({ id: property.id }).from(property)
    .where(and(eq(property.tenantId, tenantId), eq(property.address, `${stamp} Closing Ct, Mesa AZ`)));
  const [req] = await adminDb.select().from(certRequest)
    .where(and(eq(certRequest.tenantId, tenantId), eq(certRequest.propertyId, prop!.id)));
  const inspectionId = req!.inspectionId!;
  const [zone] = await adminDb.insert(inspectionZone).values({
    tenantId, inspectionId, zoneKey: `north-${stamp}`, zoneLabel: "North Slope", zoneKind: "facet",
    grade: "good", summary: "Sound decking, uniform wear",
  }).returning();
  await adminDb.insert(inspectionFinding).values({
    tenantId, inspectionZoneId: zone!.id, whatItIs: "Minor granule loss",
    disposition: "fixed_free_today", confirmedAt: new Date(),
  });
  await adminDb.update(inspection)
    .set({ status: "approved", completedAt: new Date(), approvedAt: new Date() })
    .where(eq(inspection.id, inspectionId));

  // 4. The hourly sweep auto-delivers.
  const swept = await sweepCertRequests(tenantId, new Date());
  expect(swept.delivered).toBeGreaterThanOrEqual(1);

  await page.reload();
  await expect(row).toContainText("Delivered");
  const certHref = await row.getByTestId("cert-link").getAttribute("href");
  expect(certHref).toMatch(/^\/cert\//);

  // Billing rides existing rails: a leadless repair job + a $195 invoice.
  const [delivered] = await adminDb.select().from(certRequest).where(eq(certRequest.id, req!.id));
  const [j] = await adminDb.select().from(job).where(eq(job.id, delivered!.jobId!));
  expect(j!.leadId).toBeNull();
  const [inv] = await adminDb.select().from(invoice).where(eq(invoice.id, delivered!.invoiceId!));
  expect(inv!.amountDue).toBe(19500);

  // 5. The paid deliverable: condition + grade, ZERO free-repair marketing.
  await page.goto(certHref!);
  await expect(page.getByTestId("cert-page")).toBeVisible();
  await expect(page.getByTestId("cert-address")).toContainText(`${stamp} Closing Ct`);
  await expect(page.getByTestId("cert-zones")).toContainText("North Slope");
  await expect(page.getByTestId("cert-condition-notes")).toContainText("Minor granule loss");
  const body = await page.textContent("body");
  expect(body).not.toContain("free");
  expect(body).not.toContain("Free");
  expect(body).not.toContain("estimate");
});
