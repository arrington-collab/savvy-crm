import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, customer, property, job, measurement, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

async function seedJob() {
  return withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Sketch Co" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "9 Sketch Way" }).returning();
    const [j] = await tx
      .insert(job)
      .values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead" })
      .returning();
    return { jobId: j!.id, propertyId: p!.id };
  });
}

test("sketch editor: continuous zoom controls + draw/close/save still work (slice 1)", async ({ page }) => {
  const { jobId, propertyId } = await seedJob();

  await page.goto(`/jobs/${jobId}/measure`);
  await expect(page.getByTestId("sketch-editor")).toBeVisible();

  // Continuous zoom readout starts at ×1.0 and grows on zoom-in; Re-center resets it.
  const readout = page.getByTestId("zoom-readout");
  await expect(readout).toHaveText("×1.0");
  await page.getByTestId("zoom-in").click();
  await expect(readout).not.toHaveText("×1.0");

  // Drawing a facet with the new snapping/close pipeline still produces a measurement.
  const canvas = page.getByTestId("sketch-canvas");
  await canvas.click({ position: { x: 190, y: 190 } });
  await canvas.click({ position: { x: 430, y: 190 } });
  await canvas.click({ position: { x: 430, y: 430 } });
  await canvas.click({ position: { x: 190, y: 430 } });
  await page.keyboard.press("Enter"); // explicit close

  const save = page.getByTestId("sketch-save-btn");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText(/Measurement saved/)).toBeVisible();

  const meas = await withTenant(tenantId, (tx) =>
    tx.select().from(measurement).where(eq(measurement.propertyId, propertyId)),
  );
  expect(meas.length).toBe(1);
  expect(meas[0]!.provider).toBe("diy");
  expect(meas[0]!.source).toBe("sketch");
});
