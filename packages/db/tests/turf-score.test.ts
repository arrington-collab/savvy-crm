import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { customer, property } from "../src/schema/crm";
import { job } from "../src/schema/jobs";
import { neighborhood } from "../src/schema/strike-list";
import { scoreTenantTurf } from "../src/lifecycle/turf-score";
import { makeTenant } from "./helpers";

const NOW = new Date("2026-07-17T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

async function makeProp(tenantId: string, subdivision: string | null) {
  const [p] = await adminDb.insert(property).values({ tenantId, address: `${crypto.randomUUID()} St`, subdivision }).returning();
  return p!.id;
}

async function completeJob(tenantId: string, customerId: string, propertyId: string, when: Date, stage = "complete") {
  await adminDb.insert(job).values({ tenantId, customerId, propertyId, stage: stage as never, stageEnteredAt: when });
}

describe("scoreTenantTurf", () => {
  it("scores each subdivision as recency-weighted completed jobs over its parcels", async () => {
    const { tenantId } = await makeTenant();
    const [c] = await adminDb.insert(customer).values({ tenantId, name: "C" }).returning();

    // Sun Ridge: 4 parcels, 2 recently-completed jobs → score ~0.5.
    const ids = await Promise.all([null, null, null, null].map(() => makeProp(tenantId, "Sun Ridge")));
    await completeJob(tenantId, c!.id, ids[0]!, daysAgo(60));
    await completeJob(tenantId, c!.id, ids[1]!, daysAgo(90));
    // A still-open job in the same subdivision does NOT count.
    await completeJob(tenantId, c!.id, ids[2]!, daysAgo(30), "production");
    // A property with no subdivision is ignored entirely.
    await makeProp(tenantId, null);

    const scored = await scoreTenantTurf(tenantId, NOW);
    const sun = scored.find((n) => n.name === "Sun Ridge")!;
    expect(sun.parcelCount).toBe(4);
    expect(sun.ourCompletedJobs).toBe(2);
    expect(sun.turfScore).toBeCloseTo(0.5);

    const [row] = await adminDb.select().from(neighborhood).where(eq(neighborhood.tenantId, tenantId));
    expect(row!.name).toBe("Sun Ridge");
    expect(row!.turfScore).toBeCloseTo(0.5);
    expect(row!.lastScoredAt).not.toBeNull();
  });

  it("upserts in place — a re-score updates the row, never duplicates", async () => {
    const { tenantId } = await makeTenant();
    const [c] = await adminDb.insert(customer).values({ tenantId, name: "C" }).returning();
    const p = await makeProp(tenantId, "Repeat Plat");
    await completeJob(tenantId, c!.id, p, daysAgo(45));

    await scoreTenantTurf(tenantId, NOW);
    await scoreTenantTurf(tenantId, NOW);

    const rows = await adminDb.select().from(neighborhood).where(eq(neighborhood.tenantId, tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.turfScore).toBeCloseTo(1); // 1 job / 1 parcel
  });
});
