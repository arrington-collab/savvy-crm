import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, customer, property, lead, job, measurement, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

// Direct DB seed of a lead with a property but NO job — the pre-job state a rep hits
// when they need to draw the roof to produce the measurement that produces the estimate.
async function seedLeadWithProperty(name: string) {
  return withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name, phone: "+15555550000" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: `${name} St` }).returning();
    const [l] = await tx
      .insert(lead)
      .values({ tenantId, customerId: c!.id, propertyId: p!.id, status: "new", score: 50, source: "seed" })
      .returning();
    return { leadId: l!.id, propertyId: p!.id };
  });
}

test("lead measure: draw a roof at lead stage — measurement lands, no job is created", async ({ page }) => {
  const { leadId, propertyId } = await seedLeadWithProperty("DrawMe");

  // The lead tile offers "Draw roof" (no measurement yet).
  await page.goto(`/leads/${leadId}`);
  const drawLink = page.getByTestId("lead-draw-roof");
  await expect(drawLink).toHaveText("Draw roof");
  await drawLink.click();

  // The lead-scoped editor renders.
  await page.waitForURL(`**/leads/${leadId}/measure`);
  const canvas = page.getByTestId("sketch-canvas");
  await expect(canvas).toBeVisible();

  // Draw a square facet: four corners, then Enter closes the polygon.
  await canvas.click({ position: { x: 150, y: 150 } });
  await canvas.click({ position: { x: 400, y: 150 } });
  await canvas.click({ position: { x: 400, y: 400 } });
  await canvas.click({ position: { x: 150, y: 400 } });
  await page.keyboard.press("Enter");

  // Save the measurement.
  const saveBtn = page.getByTestId("sketch-save-btn");
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();
  await expect(page.getByText(/Measurement saved/)).toBeVisible();

  // A DIY sketch measurement now exists on the lead's property...
  const meas = await withTenant(tenantId, (tx) =>
    tx.select().from(measurement).where(eq(measurement.propertyId, propertyId)),
  );
  expect(meas.length).toBe(1);
  expect(meas[0]!.provider).toBe("diy");
  expect(meas[0]!.source).toBe("sketch");

  // ...and drawing created NO job (the job is born later, from an accepted estimate).
  const jobs = await withTenant(tenantId, (tx) =>
    tx.select().from(job).where(eq(job.propertyId, propertyId)),
  );
  expect(jobs.length).toBe(0);

  // Back on the lead tile: the Measurement card reflects the DIY sketch and now offers "Edit sketch".
  await page.goto(`/leads/${leadId}`);
  await expect(page.getByTestId("lead-draw-roof")).toHaveText("Edit sketch");
  await expect(page.getByTestId("lead-detail")).toContainText("DIY sketch");
});
