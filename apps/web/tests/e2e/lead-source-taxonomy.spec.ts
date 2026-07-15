import { test, expect } from "@playwright/test";
import { adminDb, eq, lead, customer, partner } from "@savvy/db";

test("new-lead picker: referral shows conditional fields + persists structured source_detail", async ({ page }) => {
  await page.goto("/leads/new");

  const stamp = Date.now();
  const customerName = `Source Taxonomy Tester ${stamp}`;

  await page.getByLabel("Customer name").fill(customerName);
  await page.getByLabel("Phone").fill(`480555${String(stamp).slice(-4)}`);
  await page.getByTestId("address-autocomplete").fill(`${stamp} Taxonomy Ln, Mesa AZ 85201`);

  // Default picker value is already "referral" -> the referral detail fields
  // should be visible without any interaction. Re-select to be explicit and
  // exercise onChange.
  await page.getByTestId("lead-source").selectOption("referral");
  const referrerName = page.getByTestId("src-referrer-name");
  const referrerContact = page.getByTestId("src-referrer-contact");
  const referralFee = page.getByTestId("src-referral-fee");
  await expect(referrerName).toBeVisible();
  await expect(referralFee).toBeVisible();

  await referrerName.fill("Jane Referrer");
  await referrerContact.fill("(480) 555-9999");
  await referralFee.fill("150");

  await page.getByTestId("new-lead-submit").click();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]+$/);

  const leadId = page.url().split("/").pop()!;
  const [row] = await adminDb
    .select({ source: lead.source, sourceDetail: lead.sourceDetail, customerId: lead.customerId })
    .from(lead)
    .where(eq(lead.id, leadId));

  expect(row?.source).toBe("referral");
  expect(row?.sourceDetail).toMatchObject({
    referrer_name: "Jane Referrer",
    referrer_contact: "(480) 555-9999",
    referral_fee_cents: 15000,
  });

  const [cust] = await adminDb.select({ name: customer.name }).from(customer).where(eq(customer.id, row!.customerId!));
  expect(cust?.name).toBe(customerName);
});

test("new-lead picker: partner-class source uses the partner typeahead (create-once) and stamps partner_id", async ({ page }) => {
  const stamp = Date.now();
  const agentName = `Taxonomy Agent ${stamp}`;

  await page.goto("/leads/new");
  await page.getByLabel("Customer name").fill(`Insurance Agent Source ${stamp}`);
  await page.getByLabel("Phone").fill(`4805559876`);
  await page.getByTestId("address-autocomplete").fill("500 Agent Ave, Mesa AZ 85201");

  await page.getByTestId("lead-source").selectOption("insurance_agent");
  // Free-text detail fields are GONE for partner-class sources — the picker is the only path.
  await expect(page.getByTestId("partner-search")).toBeVisible();
  await expect(page.getByTestId("src-referrer-name")).toHaveCount(0);

  // No match -> inline create-once.
  await page.getByTestId("partner-search").fill(agentName);
  await page.getByTestId("partner-add-new").click();
  await expect(page.getByTestId("partner-new-name")).toHaveValue(agentName);
  await page.getByTestId("partner-new-org").fill("Acme Insurance Agency");
  await page.getByTestId("partner-add-confirm").click();
  await expect(page.getByTestId("partner-selected")).toContainText(agentName);

  await page.getByTestId("new-lead-submit").click();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]+$/);

  const leadId = page.url().split("/").pop()!;
  const [row] = await adminDb
    .select({ source: lead.source, partnerId: lead.partnerId })
    .from(lead)
    .where(eq(lead.id, leadId));
  expect(row?.source).toBe("insurance_agent");
  expect(row?.partnerId).toBeTruthy();

  const [p] = await adminDb.select().from(partner).where(eq(partner.id, row!.partnerId!));
  expect(p?.name).toBe(agentName);
  expect(p?.org).toBe("Acme Insurance Agency");
  expect(p?.class).toBe("insurance_agent");
});
