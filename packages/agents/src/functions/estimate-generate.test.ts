/**
 * Tests for the estimate-generation helper functions.
 *
 * Uses a real Postgres DB (same approach as @savvy/db tests) to exercise the
 * full estimate-generation path including price book seeding and measurement
 * insertion. The AI upsell client is injected/stubbed so tests don't need a
 * live LiteLLM endpoint.
 *
 * Run with:
 *   DATABASE_URL=... DATABASE_ADMIN_URL=... pnpm test estimate-generate
 */
import { describe, it, expect } from "vitest";
import { adminDb, withTenant, ensurePriceBook, measurement, tenant, property, customer, job, document, agentRun, eq, and } from "@savvy/db";
import { generateUpsells, draftEstimateWithRun } from "./estimate-generate";

// ---------------------------------------------------------------------------
// Helpers — bootstrap a real tenant + job + measurement in the DB.
// ---------------------------------------------------------------------------
async function makeTestTenant(): Promise<{ tenantId: string }> {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "EstGenTest", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` })
    .returning();
  return { tenantId: t!.id };
}

async function makeJobWithMeasurement(tenantId: string): Promise<{
  jobId: string;
  measurementId: string;
  propertyId: string;
}> {
  const [c] = await adminDb
    .insert(customer)
    .values({ tenantId, name: "Test Customer" })
    .returning();
  const [p] = await adminDb
    .insert(property)
    .values({ tenantId, customerId: c!.id, address: "1 Test Street" })
    .returning();
  const [j] = await adminDb
    .insert(job)
    .values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead" })
    .returning();
  const [m] = await withTenant(tenantId, (tx) =>
    tx.insert(measurement).values({
      tenantId,
      propertyId: p!.id,
      provider: "roofr",
      areas: { squares: 20, predominantPitch: "8/12", eaveLf: 100, rakeLf: 50, ridgeLf: 30 },
      pitch: "8/12",
    }).returning(),
  );
  return { jobId: j!.id, measurementId: m!.id, propertyId: p!.id };
}

// ---------------------------------------------------------------------------
// Tests: generateUpsells
// ---------------------------------------------------------------------------
describe("generateUpsells", () => {
  it("returns empty array on AI error (resilient)", async () => {
    // Stub AI client that always throws.
    const failingAi = {
      completeObject: async () => {
        throw new Error("no AI creds in test");
      },
    };
    const { tenantId } = await makeTestTenant();
    const { measurementId } = await makeJobWithMeasurement(tenantId);

    const suggestions = await generateUpsells(tenantId, measurementId, failingAi as never);
    expect(suggestions).toEqual([]);
  });

  it("returns suggestions from the AI client", async () => {
    const fakeAi = {
      completeObject: async () => ({
        object: {
          suggestions: [
            { name: "Skylight flashing upgrade", reason: "Older penetration seals detected", unitPriceCents: 15000, quantity: 1 },
            { name: "Premium ridge cap", reason: "8/12 pitch benefits from extra ridge protection", unitPriceCents: 600, quantity: 30 },
          ],
        },
        model: "fake",
      }),
    };
    const { tenantId } = await makeTestTenant();
    const { measurementId } = await makeJobWithMeasurement(tenantId);

    const suggestions = await generateUpsells(tenantId, measurementId, fakeAi as never);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]!.name).toBe("Skylight flashing upgrade");
    expect(suggestions[1]!.unitPriceCents).toBe(600);
  });

  it("feeds the job's photo notes into the upsell prompt", async () => {
    let captured = "";
    const captureAi = { completeObject: async (a: { prompt: string }) => { captured = a.prompt; return { object: { suggestions: [] }, model: "fake" }; } };
    const { tenantId } = await makeTestTenant();
    const { jobId, measurementId } = await makeJobWithMeasurement(tenantId);
    await withTenant(tenantId, (tx) =>
      tx.insert(document).values({ tenantId, jobId, kind: "photo", notes: "hail bruising on north slope", r2Key: `${tenantId}/${jobId}/p.jpg` }),
    );

    await generateUpsells(tenantId, measurementId, captureAi as never, { jobId });
    expect(captured).toContain("hail bruising on north slope");
  });

  it("adds no notes section when the job has none", async () => {
    let captured = "";
    const captureAi = { completeObject: async (a: { prompt: string }) => { captured = a.prompt; return { object: { suggestions: [] }, model: "fake" }; } };
    const { tenantId } = await makeTestTenant();
    const { jobId, measurementId } = await makeJobWithMeasurement(tenantId);

    await generateUpsells(tenantId, measurementId, captureAi as never, { jobId });
    expect(captured).not.toMatch(/field notes/i);
  });
});

// ---------------------------------------------------------------------------
// Integration test: full estimate generation path
// ---------------------------------------------------------------------------
describe("createEstimateFromMeasurement (via generateEstimateOnMeasurement path)", () => {
  it("generates a draft estimate with total > 0 from a seeded price book + measurement", async () => {
    const { tenantId } = await makeTestTenant();
    await ensurePriceBook(tenantId); // seed the default price book

    const { jobId, measurementId } = await makeJobWithMeasurement(tenantId);

    // Import and call the DB lifecycle function directly (same function the
    // Inngest step calls internally).
    const { createEstimateFromMeasurement } = await import("@savvy/db");
    const est = await createEstimateFromMeasurement({ tenantId, jobId, measurementId });

    expect(est).not.toBeNull();
    expect(est!.status).toBe("draft");
    expect(est!.source).toBe("roofr");
    expect(est!.total).toBeGreaterThan(0);
    // upsellSuggestions defaults to [] (AI not run in this direct test)
    expect(Array.isArray(est!.upsellSuggestions)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// draftEstimateWithRun: wraps the job-stage draft in a live agent_run
// ---------------------------------------------------------------------------
describe("draftEstimateWithRun", () => {
  it("opens and resolves an agent_run row attributed to the job", async () => {
    const { tenantId } = await makeTestTenant();
    await ensurePriceBook(tenantId);
    const { jobId, measurementId } = await makeJobWithMeasurement(tenantId);

    const est = await draftEstimateWithRun({ tenantId, jobId, measurementId });

    expect(est).not.toBeNull();
    expect(est!.status).toBe("draft");

    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(agentRun).where(and(eq(agentRun.taskKey, "estimating-049"), eq(agentRun.jobId, jobId))),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("ok");
    expect(rows[0]!.jobId).toBe(jobId);
  });
});
