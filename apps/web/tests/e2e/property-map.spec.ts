import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, customer, property, lead } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

test("property map renders on lead detail with coords", async ({ page }) => {
  const leadId = await withTenant(tenantId, async (tx) => {
    const [c] = await tx
      .insert(customer)
      .values({ tenantId, name: "Map Lead", phone: "+15555550000" })
      .returning();
    const [p] = await tx
      .insert(property)
      .values({
        tenantId,
        customerId: c!.id,
        address: "1600 E Camelback Rd, Phoenix, AZ",
        lat: 33.5092,
        lng: -112.0633,
      })
      .returning();
    const [l] = await tx
      .insert(lead)
      .values({ tenantId, customerId: c!.id, propertyId: p!.id, status: "new", source: "seed" })
      .returning();
    return l!.id;
  });

  await page.goto(`/leads/${leadId}`);
  const img = page.getByTestId("property-map-img");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute(
    "src",
    /^https:\/\/maps\.googleapis\.com\/maps\/api\/staticmap\?/,
  );
  await expect(page.getByTestId("property-map-link")).toHaveAttribute(
    "href",
    /^https:\/\/www\.google\.com\/maps\/search\//,
  );
});
