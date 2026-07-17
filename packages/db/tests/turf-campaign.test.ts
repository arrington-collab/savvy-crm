import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { neighborhood } from "../src/schema/strike-list";
import { mailCampaign } from "../src/schema/mail";
import { emitTurfCampaigns } from "../src/lifecycle/turf-score";
import { makeTenant } from "./helpers";

async function makeNeighborhood(tenantId: string, name: string, turfScore: number, parcelCount = 50) {
  const [n] = await adminDb.insert(neighborhood).values({
    tenantId, name, turfScore, parcelCount, ourCompletedJobs: Math.round(turfScore * parcelCount),
  }).returning();
  return n!.id;
}

async function turfCampaigns(tenantId: string) {
  return adminDb.select().from(mailCampaign).where(and(eq(mailCampaign.tenantId, tenantId), eq(mailCampaign.kind, "turf")));
}

describe("emitTurfCampaigns", () => {
  it("raises exactly one pending-approval campaign per neighborhood that crosses the threshold", async () => {
    const { tenantId } = await makeTenant();
    const hot = await makeNeighborhood(tenantId, "Hot Turf", 0.08);
    await makeNeighborhood(tenantId, "Cold Turf", 0.02); // below 5% — no campaign

    const res = await emitTurfCampaigns(tenantId);
    expect(res.triggered).toBe(1);

    const camps = await turfCampaigns(tenantId);
    expect(camps).toHaveLength(1);
    expect(camps[0]!.triggerRef).toBe(hot);
    expect(camps[0]!.status).toBe("pending_approval");
    expect(camps[0]!.audienceCount).toBe(50);
  });

  it("is idempotent — a re-run creates no duplicate campaign", async () => {
    const { tenantId } = await makeTenant();
    await makeNeighborhood(tenantId, "Hot Turf", 0.09);

    await emitTurfCampaigns(tenantId);
    const second = await emitTurfCampaigns(tenantId);
    expect(second.triggered).toBe(0);
    expect(await turfCampaigns(tenantId)).toHaveLength(1);
  });

  it("honors a per-tenant threshold", async () => {
    const { tenantId } = await makeTenant();
    await makeNeighborhood(tenantId, "Warm Turf", 0.08);

    const res = await emitTurfCampaigns(tenantId, { threshold: 0.1 });
    expect(res.triggered).toBe(0);
    expect(await turfCampaigns(tenantId)).toHaveLength(0);
  });
});
