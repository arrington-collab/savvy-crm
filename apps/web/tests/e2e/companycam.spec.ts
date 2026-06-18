import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, customer, property, job, document, agentRun, eq, and } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

test("companycam: webhook attaches a referenced photo + logs SCOUT run", async ({ request }) => {
  const projectId = `proj-${Date.now()}`;
  const jobId = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "CC Cathy" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "8 Cam Rd" }).returning();
    const [j] = await tx.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production", companycamProjectId: projectId }).returning();
    return j!.id;
  });

  const res = await request.post("/api/companycam/webhook", {
    data: { type: "photo.created", projectId, photoId: "cc-photo-1", url: "https://companycam.test/p1.jpg" },
  });
  expect(res.ok()).toBeTruthy();

  const docs = await withTenant(tenantId, (tx) =>
    tx.select().from(document).where(and(eq(document.jobId, jobId), eq(document.source, "companycam"))));
  expect(docs.length).toBe(1);
  expect(docs[0]!.externalUrl).toBe("https://companycam.test/p1.jpg");

  const runs = await withTenant(tenantId, (tx) =>
    tx.select().from(agentRun).where(and(eq(agentRun.jobId, jobId), eq(agentRun.taskKey, "photo.companycam"))));
  expect(runs.length).toBe(1);
});
