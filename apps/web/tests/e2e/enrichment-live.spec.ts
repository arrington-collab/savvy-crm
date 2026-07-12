import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, adminDb, customer, property, lead, agentRun, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("enrichment fills in live when the running enrich run completes", async ({ page }) => {
  const seeded = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Live Enrich Larry" }).returning();
    // Property with NO enrichment yet (null county / roofType / yearBuilt).
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "7 Fillin Ave, Mesa AZ" }).returning();
    const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, status: "new", source: "seed" }).returning();
    return { leadId: l!.id, propertyId: p!.id };
  });

  // A running enrichment run on the lead → in-flight (drives the live watcher).
  const [run] = await adminDb
    .insert(agentRun)
    .values({ tenantId, agent: "orchestrator", taskKey: "enrich.property", status: "running", finishedAt: null, leadId: seeded.leadId })
    .returning();

  await page.goto(`/leads/${seeded.leadId}`);
  const card = page.getByTestId("lead-enrichment-card");
  await expect(card).toContainText("No enrichment yet");
  // Wait until the poller has actually observed the running run (dots visible) so the
  // watcher holds it as "previous" — otherwise completing it is a no-op transition.
  await expect(page.getByTestId("inflight-dots").first()).toBeVisible({ timeout: 20_000 });

  // Enrichment lands: fill the property, then complete the run. On the next inflight
  // poll the watcher sees the run finish (justCompleted) and refreshes → value fills in.
  await withTenant(tenantId, (tx) => tx.update(property).set({ yearBuilt: 2004 }).where(eq(property.id, seeded.propertyId)));
  await adminDb.update(agentRun).set({ status: "ok", finishedAt: new Date() }).where(eq(agentRun.id, run!.id));

  await expect(card).toContainText("Built 2004", { timeout: 25_000 });
});
