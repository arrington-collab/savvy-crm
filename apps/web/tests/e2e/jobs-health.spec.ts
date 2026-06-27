import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, adminDb, customer, property, job, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

test("a long-idle job shows an At-risk badge on the board", async ({ page }) => {
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();

  // Seed the job and capture its id via returning().
  const jobId = await withTenant(tenantId, async (tx) => {
    const [c] = await tx
      .insert(customer)
      .values({ tenantId, name: "Risky Rita" })
      .returning({ id: customer.id });
    const [p] = await tx
      .insert(property)
      .values({ tenantId, customerId: c!.id, address: "9 Stuck Ln" })
      .returning({ id: property.id });
    const [j] = await tx
      .insert(job)
      .values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "estimate" })
      .returning({ id: job.id });
    return j!.id;
  });

  // Backdate stageEnteredAt so the estimate job is stuck (>7d).
  await adminDb
    .update(job)
    .set({ stageEnteredAt: new Date(old) })
    .where(eq(job.id, jobId));

  await page.goto("/jobs");
  // The card's customer name renders in a job-card-link
  await expect(page.getByTestId("job-card-link").filter({ hasText: "Risky Rita" }).first()).toBeVisible();
  await expect(page.getByText(/At risk/i).first()).toBeVisible();
  await expect(page.getByText(/Needs attention/i)).toBeVisible();
});

test("the board shows dollars-in-stage per column and a gross pipeline total", async ({ page }) => {
  // Seed a valued job in an open stage so its column + the pipeline total are non-zero.
  await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Valued Vic" }).returning({ id: customer.id });
    const [p] = await tx
      .insert(property)
      .values({ tenantId, customerId: c!.id, address: "7 Money Rd" })
      .returning({ id: property.id });
    await tx
      .insert(job)
      .values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "approved", valueEstimate: 7_500_000 });
  });

  await page.goto("/jobs");
  // The approved column header shows "count · $<dollars>" (a real dollar figure, not "—").
  await expect(page.getByTestId("col-approved-meta")).toHaveText(/·\s*\$[\d,]+/);
  // The board header shows a gross pipeline total.
  await expect(page.getByTestId("pipeline-total")).toHaveText(/Pipeline:\s*\$[\d,]+/);
});
