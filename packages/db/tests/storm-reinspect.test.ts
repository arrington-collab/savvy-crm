import { describe, it, expect } from "vitest";
import {
  adminDb, property, user, inspection, stormReinspectBatch, eq,
  startInspectionForLead, completeInspection, approveInspection, publishInspection,
} from "../src/index.js";
import {
  proposeStormReinspectBatch, approveStormReinspectBatch, dismissStormReinspectBatch,
  markStormBatchSent, listOpenStormBatches, unlinkedReinspections,
} from "../src/lifecycle/storm-reinspect.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

// A hail swath ring around Phoenix ([lat, lng] vertices, StormProof shape).
const PHX_RING = [[33.3, -112.3], [33.6, -112.3], [33.6, -111.9], [33.3, -111.9]];
const SWATH = { kind: "hail" as const, rings: [PHX_RING], size: 1.75, windMph: null, date: "2026-07-10" };

async function seedBaselinedProperty() {
  const { tenantId } = await makeTenant();
  const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
  const [u] = await adminDb.insert(user).values({ tenantId, clerkUserId: `clk-${crypto.randomUUID()}`, name: "Owner Olga", email: `o-${crypto.randomUUID()}@t.local`, role: "admin" }).returning();
  await adminDb.update(property).set({ lat: 33.45, lng: -112.07 }).where(eq(property.id, propertyId));
  const started = await startInspectionForLead({ tenantId, leadId });
  if ("error" in started) throw new Error("start failed");
  await completeInspection({ tenantId, inspectionId: started.inspectionId });
  await approveInspection({ tenantId, inspectionId: started.inspectionId, userId: u!.id });
  await publishInspection({ tenantId, inspectionId: started.inspectionId });
  return { tenantId, leadId, propertyId, userId: u!.id, baselineInspectionId: started.inspectionId };
}

describe("proposeStormReinspectBatch — ONE card per verified event", () => {
  it("proposes a batch when the swath covers baselined roofs; a replayed event never cards twice", async () => {
    const ctx = await seedBaselinedProperty();
    const first = await proposeStormReinspectBatch({ tenantId: ctx.tenantId, swath: SWATH });
    expect("batchId" in first && first.affected === 1).toBe(true);

    const replay = await proposeStormReinspectBatch({ tenantId: ctx.tenantId, swath: SWATH });
    expect(replay).toEqual({ skipped: "already_proposed" });

    const open = await listOpenStormBatches(ctx.tenantId);
    expect(open).toHaveLength(1);
    expect(open[0]!.kind).toBe("hail");
    expect((open[0]!.properties as { propertyId: string }[])[0]!.propertyId).toBe(ctx.propertyId);
  });

  it("skips events that touch no baselined roof (no noise cards)", async () => {
    const ctx = await seedBaselinedProperty();
    const tucson = { ...SWATH, rings: [[[32.1, -111.1], [32.3, -111.1], [32.3, -110.8], [32.1, -110.8]]], date: "2026-07-11" };
    const res = await proposeStormReinspectBatch({ tenantId: ctx.tenantId, swath: tucson });
    expect(res).toEqual({ skipped: "no_baselined_roofs" });
  });
});

describe("batch approval — the owner decides, then NOVA sends", () => {
  it("proposed → approved (stamped) → sent; dismiss is terminal for a proposed batch", async () => {
    const ctx = await seedBaselinedProperty();
    const proposed = await proposeStormReinspectBatch({ tenantId: ctx.tenantId, swath: SWATH });
    const batchId = (proposed as { batchId: string }).batchId;

    const approved = await approveStormReinspectBatch({ tenantId: ctx.tenantId, batchId, userId: ctx.userId });
    expect("error" in approved).toBe(false);
    let [row] = await adminDb.select().from(stormReinspectBatch).where(eq(stormReinspectBatch.id, batchId));
    expect(row!.status).toBe("approved");
    expect(row!.approvedByUserId).toBe(ctx.userId);

    await markStormBatchSent({ tenantId: ctx.tenantId, batchId });
    [row] = await adminDb.select().from(stormReinspectBatch).where(eq(stormReinspectBatch.id, batchId));
    expect(row!.status).toBe("sent");

    // Dismissing a sent batch refuses; a fresh proposed one dismisses.
    expect(await dismissStormReinspectBatch({ tenantId: ctx.tenantId, batchId })).toEqual({ error: "not_open" });
  });
});

describe("post_storm inspections link their baseline", () => {
  it("startInspectionForLead(kind=post_storm) auto-links the property's baseline", async () => {
    const ctx = await seedBaselinedProperty();
    const started = await startInspectionForLead({ tenantId: ctx.tenantId, leadId: ctx.leadId, kind: "post_storm" });
    if ("error" in started) throw new Error("start failed");

    const [row] = await adminDb.select().from(inspection).where(eq(inspection.id, started.inspectionId));
    expect(row!.kind).toBe("post_storm");
    expect(row!.baselineInspectionId).toBe(ctx.baselineInspectionId);
  });

  it("inspection.linked_reinspection evidence: post_storm rows without a baseline link are the gap set", async () => {
    const ctx = await seedBaselinedProperty();
    const started = await startInspectionForLead({ tenantId: ctx.tenantId, leadId: ctx.leadId, kind: "post_storm" });
    if ("error" in started) throw new Error("start failed");
    expect(await unlinkedReinspections(ctx.tenantId)).toEqual([]);

    await adminDb.update(inspection).set({ baselineInspectionId: null }).where(eq(inspection.id, started.inspectionId));
    expect(await unlinkedReinspections(ctx.tenantId)).toEqual([{ inspectionId: started.inspectionId }]);
  });
});
