import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, customer, property, lead } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

// Seed a lead with pre-populated scoreFeatures + installRecommendation so the
// enrichment card can be tested deterministically without running Inngest.
async function seedEnrichedLead() {
  return withTenant(tenantId, async (tx) => {
    const [c] = await tx
      .insert(customer)
      .values({ tenantId, name: "Enriched Ellie", phone: "+15555550099" })
      .returning();

    const [p] = await tx
      .insert(property)
      .values({
        tenantId,
        customerId: c!.id,
        address: "99 Hailstorm Drive",
        county: "Maricopa",
        roofType: "tile",
        yearBuilt: 2004,
      })
      .returning();

    const [l] = await tx
      .insert(lead)
      .values({
        tenantId,
        customerId: c!.id,
        propertyId: p!.id,
        status: "new",
        score: 78,
        scoreReason: "Recent hail + old roof",
        scoreFeatures: {
          baseline: 78,
          factors: [
            { label: "hail 1.5\" (5d ago)", points: 22 },
            { label: "roof ~22 yrs old", points: 9 },
          ],
          features: {},
        },
        installRecommendation: {
          windRating: "standard",
          impactResistance: "class4",
          suggestedProducts: [
            "Class 4 impact-resistant shingle (insurance-discount eligible)",
          ],
          rationale: "hail history (1.5\")",
        },
        source: "seed",
      })
      .returning();

    return { leadId: l!.id, customerId: c!.id, propertyId: p!.id };
  });
}

test("lead enrichment: score factors + install recommendation render on detail page", async ({
  page,
}) => {
  const { leadId } = await seedEnrichedLead();

  await page.goto(`/leads/${leadId}`);
  await expect(page.getByTestId("lead-detail")).toBeVisible();

  // Enrichment card is visible.
  const card = page.getByTestId("lead-enrichment-card");
  await expect(card).toBeVisible();

  // Score factor text is rendered.
  await expect(card).toContainText(/roof ~22 yrs old/);

  // Install / upsell recommendation block is visible with the correct product chip.
  const recommendation = page.getByTestId("install-recommendation");
  await expect(recommendation).toBeVisible();
  await expect(recommendation).toContainText(/Class 4/i);
});
