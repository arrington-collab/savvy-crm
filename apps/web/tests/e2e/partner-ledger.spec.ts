import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  adminDb, eq, and,
  customer, property, lead, job, invoice, partner,
  findOrCreatePartner, withTenant, recomputePartnerGrades, accrueLedgerEntryTx,
} from "@savvy/db";

const tenantId = process.env.TEST_TENANT_ID ?? JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")).id;

const stamp = Date.now().toString(36);
let winnerId: string;
let coldId: string;

async function seedLead(partnerId: string, ageDays: number) {
  const [c] = await adminDb.insert(customer).values({ tenantId, name: `PL-${stamp}-${crypto.randomUUID().slice(0, 6)}` }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${crypto.randomUUID().slice(0, 6)} Ledger Ln` }).returning();
  const [l] = await adminDb.insert(lead).values({
    tenantId, customerId: c!.id, propertyId: p!.id, source: "realtor", partnerId,
    createdAt: new Date(Date.now() - ageDays * 86_400_000),
  }).returning();
  return { leadId: l!.id, customerId: c!.id, propertyId: p!.id };
}

test.beforeAll(async () => {
  // Winner: one won job with collected GM + a couple of costs.
  winnerId = (await findOrCreatePartner(tenantId, { name: `Winnie Winner ${stamp}`, org: "Win Realty", class: "realtor" })).id;
  const L = await seedLead(winnerId, 30);
  const [j] = await adminDb.insert(job).values({
    tenantId, customerId: L.customerId, propertyId: L.propertyId, leadId: L.leadId,
    type: "retail", stage: "complete", valueFinal: 1_500_000, costCents: 700_000,
    createdAt: new Date(Date.now() - 20 * 86_400_000),
  }).returning();
  await adminDb.insert(invoice).values({ tenantId, jobId: j!.id, amountDue: 1_500_000, amountPaid: 1_500_000, status: "paid" });
  await withTenant(tenantId, (tx) =>
    accrueLedgerEntryTx(tx, tenantId, { partnerId: winnerId, kind: "expense", amountCents: 12_000, sourceRef: `e2e:${stamp}:lunch`, note: "coffee + lunch" }),
  );

  // Cold: five referrals, zero wins — grades C and opens the decision card.
  coldId = (await findOrCreatePartner(tenantId, { name: `Colin Cold ${stamp}`, org: "Cold Co", class: "realtor" })).id;
  for (let i = 0; i < 5; i++) await seedLead(coldId, 10 + i);

  await recomputePartnerGrades(tenantId, new Date());
});

test("partners table ranks partners with grade and net", async ({ page }) => {
  await page.goto("/partners");
  const winRow = page.getByTestId("partner-row").filter({ hasText: `Winnie Winner ${stamp}` });
  await expect(winRow).toHaveCount(1);
  await expect(winRow).toContainText("A"); // 800k GM − 12k cost, 1 win → A
  const coldRow = page.getByTestId("partner-row").filter({ hasText: `Colin Cold ${stamp}` });
  await expect(coldRow).toContainText("C");
});

test("partner detail shows the funnel and ledger entries", async ({ page }) => {
  await page.goto(`/partners/${winnerId}`);
  await expect(page.getByTestId("partner-funnel")).toContainText("1 sent");
  await expect(page.getByTestId("partner-funnel")).toContainText("1 won");
  await expect(page.getByTestId("partner-ledger-entries")).toContainText("coffee + lunch");
});

test("C-partner decision card on /today resolves to slack-capacity only — never an auto-cutoff", async ({ page }) => {
  await page.goto("/today");
  const card = page.getByTestId(`partner-grade-${coldId}`);
  await expect(card).toBeVisible();
  await expect(card).toContainText("5 referrals, zero wins");

  await card.getByTestId("partner-grade-slack").click();
  await expect(card).toHaveCount(0);

  const [p] = await adminDb.select().from(partner).where(and(eq(partner.tenantId, tenantId), eq(partner.id, coldId)));
  expect(p!.slackCapacityOnly).toBe(true);
  expect(p!.status).toBe("active"); // still active — the machine ranked, the human decided
});
