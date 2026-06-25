// CI-gated: requires Postgres. If ECONNREFUSED locally, this suite is expected
// to fail — rely on CI. The stormProof module-level singleton uses makeFakeStormProof()
// when STORMPROOF_API_BASE is unset, returning 1 hail event at 1.5 inches.
import { describe, it, expect, beforeAll } from "vitest";
import { adminDb, withTenant, tenant, customer, lead, property, eq } from "@savvy/db";
import { rescoreTenant } from "./lead-rescore";

describe("rescoreTenant — nightly re-score cron (DB-backed)", () => {
  let tenantId: string;
  let leadId: string;

  beforeAll(async () => {
    const [t] = await adminDb
      .insert(tenant)
      .values({ name: "RescoreTest", clerkOrgId: `org_rescore_${Date.now()}` })
      .returning();
    tenantId = t!.id;

    await withTenant(tenantId, async (tx) => {
      const [c] = await tx
        .insert(customer)
        .values({ tenantId, name: "Rescore Cust" })
        .returning();

      // Property with valid lat/lng so storm lookup proceeds.
      const [p] = await tx
        .insert(property)
        .values({
          tenantId,
          customerId: c!.id,
          address: "1 Storm Rd, Phoenix AZ 85001",
          state: "AZ",
          lat: 33.4,
          lng: -112.0,
          roofType: "asphalt_shingle",
          yearBuilt: 2001,
        })
        .returning();

      // Start at band "cool" (score ~30); the fake storm (1.5in hail, 1 event) should push it to "warm" or "hot".
      const [l] = await tx
        .insert(lead)
        .values({
          tenantId,
          customerId: c!.id,
          propertyId: p!.id,
          status: "new",
          scoreBand: "cool",
          score: 30,
        })
        .returning();
      leadId = l!.id;
    });
  });

  it("returns ≥ 1 upgraded lead when the fake storm qualifies", async () => {
    const upgraded = await rescoreTenant(tenantId);
    expect(upgraded).toBeGreaterThanOrEqual(1);
  });

  it("lead scoreBand rose above 'cool' and lane became 'storm'", async () => {
    const [row] = await withTenant(tenantId, (tx) =>
      tx
        .select({ scoreBand: lead.scoreBand, lane: lead.lane, score: lead.score })
        .from(lead)
        .where(eq(lead.id, leadId)),
    );

    // The fake storm provides hail data which should produce "warm" or "hot" band.
    const rank = { cold: 0, cool: 1, warm: 2, hot: 3 }[row?.scoreBand ?? "cold"] ?? 0;
    expect(rank).toBeGreaterThan(1); // above "cool"
    expect(row?.lane).toBe("storm");
  });
});
