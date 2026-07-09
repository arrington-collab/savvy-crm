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

describe("rescoreTenant — secondary roof type routes to tile lane", () => {
  let tenantId: string;
  let leadId: string;

  beforeAll(async () => {
    // stormLaneThreshold pinned above 1.0 (the max possible storm sub-score) so the
    // module-level fake storm gateway's fixed hail event never wins lane precedence over
    // the tile signal this test is targeting (see lane.ts: storm beats tile).
    const [t] = await adminDb
      .insert(tenant)
      .values({
        name: "RescoreSecondaryTile",
        clerkOrgId: `org_rescore_secondary_${Date.now()}`,
        settings: { scoring: { stormLaneThreshold: 1.5 } },
      })
      .returning();
    tenantId = t!.id;

    await withTenant(tenantId, async (tx) => {
      const [c] = await tx
        .insert(customer)
        .values({ tenantId, name: "Rescore Secondary Cust" })
        .returning();

      // Primary roof type is asphalt_shingle, but the SECONDARY is tile — rescore should
      // still route this lead to the "tile" lane once roofTypeSecondary is wired through
      // buildLeadFeatures.
      const [p] = await tx
        .insert(property)
        .values({
          tenantId,
          customerId: c!.id,
          address: "2 Secondary Tile Rd, Phoenix AZ 85001",
          state: "AZ",
          lat: 33.4,
          lng: -112.0,
          roofType: "asphalt_shingle",
          roofTypeSecondary: "tile",
          yearBuilt: 2001,
        })
        .returning();

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

  it("persists lane 'tile' after rescore, driven by the property's SECONDARY roof type", async () => {
    await rescoreTenant(tenantId);
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select({ lane: lead.lane }).from(lead).where(eq(lead.id, leadId)),
    );
    expect(row?.lane).toBe("tile");
  });
});
