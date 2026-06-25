import { describe, it, expect, beforeAll } from "vitest";
import { hybridScore, buildBookingSms, enrichProperty, runLeadAssignment } from "./lead-intake";
import { buildLeadFeatures, parseScoringConfig } from "@savvy/core";
import { makeFakeStormProof } from "@savvy/integrations";
import { adminDb, withTenant, tenant, user, customer, lead, property, saveAssignmentConfig, eq } from "@savvy/db";

describe("lead.intake pure steps", () => {
  it("buildBookingSms includes the booking link and name", () => {
    const body = buildBookingSms({ name: "Jane", bookingUrl: "https://x/book/123" });
    expect(body).toContain("https://x/book/123");
    expect(body).toMatch(/Jane/);
  });
});

describe("hybridScore", () => {
  const defaultCfg = parseScoringConfig(null);

  it("stays within ±10 of baseline and returns a reason", async () => {
    const features = buildLeadFeatures({ source: "referral", state: "AZ", phone: "+14805551234",
      roofType: "tile", yearBuilt: 2004, storm: { eventCount: 1, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 5 } });
    const fakeAi = { completeObject: async () => ({ object: { score: 999, reason: "Referral + recent hail" }, model: "fake" }) };
    const r = await hybridScore(features, defaultCfg, fakeAi as any);
    expect(r.reason).toContain("hail");
    expect(Math.abs(r.score - r.baseline)).toBeLessThanOrEqual(10);
    expect(r.band).toBeDefined();
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("falls back to the deterministic baseline when the AI call fails", async () => {
    const features = buildLeadFeatures({ source: "referral", state: "AZ", phone: "+14805551234",
      roofType: "asphalt_shingle", yearBuilt: 1968, storm: { eventCount: 0, maxHailInches: 0, maxWindMph: 0, daysSinceWorst: null } });
    const throwingAi = { completeObject: async () => { throw new Error("credit balance too low"); } };
    const r = await hybridScore(features, defaultCfg, throwingAi as any);
    // AI outage must NOT crash scoring — return the deterministic baseline as-is.
    expect(r.score).toBe(r.baseline);
    expect(r.score).toBeGreaterThan(0);
    expect(r.band).toBeDefined();
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.reason.length).toBeGreaterThan(0);
  });
});

describe("enrichProperty", () => {
  it("fills year built + storm summary when lat/lng present", async () => {
    const sp = makeFakeStormProof();
    const out = await enrichProperty(
      { lat: 33.4, lng: -111.8, address: "1 Main St", yearBuilt: null, roofType: null },
      sp,
    );
    expect(out.yearBuilt).toBe(2004);
    expect(out.storm.maxHailInches).toBe(1.5);
    expect(out.stormEventId).toBe("evt_fake_1");
  });
  it("keeps rep-entered year built (does not overwrite)", async () => {
    const sp = makeFakeStormProof();
    const out = await enrichProperty(
      { lat: 33.4, lng: -111.8, address: "1 Main St", yearBuilt: 1999, roofType: "tile" },
      sp,
    );
    expect(out.yearBuilt).toBe(1999);
    expect(out.roofType).toBe("tile");
  });
  it("skips getProperty when lat/lng are null (only looks up storms)", async () => {
    const sp = makeFakeStormProof();
    const out = await enrichProperty({ lat: null, lng: null, address: "unknown", yearBuilt: null, roofType: null }, sp);
    expect(sp.calls.filter((c) => c.op === "getProperty").length).toBe(0);
    expect(sp.calls.filter((c) => c.op === "lookupStorms").length).toBe(1);
    expect(out.yearBuilt).toBeNull();
  });
  it("preserves a form-supplied county when getProperty is skipped", async () => {
    const sp = makeFakeStormProof();
    const out = await enrichProperty(
      { lat: 33.4, lng: -111.8, address: "1 Main St", yearBuilt: 1999, roofType: "tile", county: "Maricopa" },
      sp,
    );
    expect(out.county).toBe("Maricopa"); // getProperty skipped (yearBuilt present) — county not nulled
    expect(sp.calls.filter((c) => c.op === "getProperty").length).toBe(0);
  });
});

// CI-gated: requires Postgres. If ECONNREFUSED locally, rely on CI.
describe("runLeadAssignment — proximity strategy (DB-backed)", () => {
  let tenantId: string;
  let repNear: string;
  let repFar: string;
  let leadId: string;

  beforeAll(async () => {
    const [t] = await adminDb
      .insert(tenant)
      .values({ name: "ProxTest", clerkOrgId: `org_prox_${Date.now()}` })
      .returning();
    tenantId = t!.id;

    await withTenant(tenantId, async (tx) => {
      // Rep near the property (Phoenix area — lat 33.4, lng -112.0)
      const [near] = await tx
        .insert(user)
        .values({
          tenantId,
          name: "Near Rep",
          email: `near-${Date.now()}@x.com`,
          role: "rep",
          baseLat: 33.4,   // close to property
          baseLng: -112.0,
        })
        .returning();
      repNear = near!.id;

      // Rep far from the property (Tucson area — lat 32.2, lng -110.9)
      const [far] = await tx
        .insert(user)
        .values({
          tenantId,
          name: "Far Rep",
          email: `far-${Date.now()}@x.com`,
          role: "rep",
          baseLat: 32.2,
          baseLng: -110.9,
        })
        .returning();
      repFar = far!.id;

      const [c] = await tx.insert(customer).values({ tenantId, name: "Prox Cust" }).returning();
      const [p] = await tx
        .insert(property)
        .values({ tenantId, customerId: c!.id, address: "100 Prox Ave", lat: 33.45, lng: -112.07 })
        .returning();
      const [l] = await tx
        .insert(lead)
        .values({ tenantId, customerId: c!.id, propertyId: p!.id, status: "new", score: 50 })
        .returning();
      leadId = l!.id;
    });

    await saveAssignmentConfig(tenantId, { strategy: "proximity" });
  });

  it("assigns the nearer rep (fake drive-time is active, GOOGLE_MAPS_SERVER_KEY unset)", async () => {
    // makeFakeDistance computes straight-line-proportional minutes, so repNear (33.4, -112.0)
    // is closer to the property (33.45, -112.07) than repFar (32.2, -110.9).
    const r = await runLeadAssignment(tenantId, leadId, { state: "AZ", city: "Phoenix" });
    expect(r.assigned).toBe(repNear);
    expect(r.reason).toBe("assigned");
  });
});

// CI-gated: requires Postgres. Verifies that scoreBand + lane columns round-trip correctly.
describe("scoreBand + lane — DB-backed persist check", () => {
  let tenantId: string;
  let leadId: string;

  beforeAll(async () => {
    const [t] = await adminDb
      .insert(tenant)
      .values({ name: "ScoreBandTest", clerkOrgId: `org_sb_${Date.now()}` })
      .returning();
    tenantId = t!.id;

    await withTenant(tenantId, async (tx) => {
      const [c] = await tx.insert(customer).values({ tenantId, name: "Score Test Cust" }).returning();
      const [p] = await tx
        .insert(property)
        .values({
          tenantId, customerId: c!.id, address: "200 Storm Ave, Phoenix AZ 85001",
          state: "AZ", lat: 33.4, lng: -112.0, roofType: "asphalt_shingle", yearBuilt: 2001,
        })
        .returning();
      const [l] = await tx
        .insert(lead)
        .values({ tenantId, customerId: c!.id, propertyId: p!.id, status: "new" })
        .returning();
      leadId = l!.id;
    });
  });

  it("persists a non-null scoreBand and a valid lane after write then read", async () => {
    const cfg = parseScoringConfig(null);
    const features = buildLeadFeatures({
      source: "web", state: "AZ",
      roofType: "asphalt_shingle", yearBuilt: 2001,
      storm: { eventCount: 3, maxHailInches: 1.75, maxWindMph: 55, daysSinceWorst: 10 },
    });
    // Use the deterministic scorer directly (no AI call needed)
    const { scoreLead: sl, deriveLane: dl } = await import("@savvy/core");
    const scored = sl(features, cfg);
    const lane = dl(features, cfg);

    await withTenant(tenantId, (tx) =>
      tx.update(lead).set({ scoreBand: scored.band, lane }).where(eq(lead.id, leadId)),
    );

    const [row] = await withTenant(tenantId, (tx) =>
      tx.select({ scoreBand: lead.scoreBand, lane: lead.lane }).from(lead).where(eq(lead.id, leadId)),
    );

    expect(row?.scoreBand).not.toBeNull();
    expect(["storm", "tile", "standard"]).toContain(row?.lane);
  });
});
