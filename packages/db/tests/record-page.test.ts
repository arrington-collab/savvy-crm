import { describe, it, expect } from "vitest";
import {
  adminDb, document, eq, user, tenant,
  startInspectionForLead, ingestInspectionMedia, completeInspection,
  addInspectionFinding, setInspectionZoneGrade, applyFriendRule,
  approveInspection, publishInspection, setInspectionNarrative, ensureInspectionChecklists,
} from "../src/index.js";
import { ensureRecordLink, resolveRecordLink, getRecordPageData } from "../src/lifecycle/record-page.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

async function seedRecord() {
  const { tenantId } = await makeTenant();
  const { leadId, propertyId, customerId } = await makeLeadWithProperty(tenantId);
  await ensureInspectionChecklists(tenantId);
  const [u] = await adminDb.insert(user).values({ tenantId, clerkUserId: `clk-${crypto.randomUUID()}`, name: "Ida Inspector", email: `ida-${crypto.randomUUID()}@test.local`, role: "admin" }).returning();
  const started = await startInspectionForLead({ tenantId, leadId });
  if ("error" in started) throw new Error("start failed");
  const inspectionId = started.inspectionId;

  async function landZone(zoneKey: string, zoneLabel: string, zoneKind: string, checklistItemKey?: string) {
    const [d] = await adminDb.insert(document).values({
      tenantId, leadId, kind: "photo", source: "sitesnap", sitesnapPhotoId: `ss-${crypto.randomUUID()}`,
      qcStatus: "passed", r2Key: `sitesnap/${tenantId}/${crypto.randomUUID()}`,
    }).returning();
    const media = await ingestInspectionMedia({ tenantId, inspectionId, zoneKey, zoneLabel, zoneKind, documentId: d!.id, checklistItemKey: checklistItemKey ?? null });
    if ("error" in media) throw new Error("media failed");
    return { docId: d!.id, zoneId: media.inspectionZoneId };
  }

  return { tenantId, leadId, propertyId, customerId, userId: u!.id, inspectionId, landZone };
}

describe("record link — the customer's permanent asset", () => {
  it("mints one idempotent code; resolve verifies the signature; tampering fails", async () => {
    const ctx = await seedRecord();
    const a = await ensureRecordLink({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId });
    const b = await ensureRecordLink({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId });
    expect(a.code).toBe(b.code);

    const resolved = await resolveRecordLink(a.code);
    expect(resolved).toEqual({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId });
    expect(await resolveRecordLink("nope-not-a-code")).toBeNull();
  });
});

describe("getRecordPageData — renders ONLY a published Record", () => {
  it("returns null for in_progress / pending_approval / approved", async () => {
    const ctx = await seedRecord();
    expect(await getRecordPageData({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId })).toBeNull();
    await completeInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId });
    expect(await getRecordPageData({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId })).toBeNull();
    await approveInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId, userId: ctx.userId });
    expect(await getRecordPageData({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId })).toBeNull();
  });

  it("published: zones with grades/summaries, CONFIRMED findings only, friend-rule section, healthy=false with an action zone", async () => {
    const ctx = await seedRecord();
    const north = await ctx.landZone("north_slope", "North slope", "facet");
    const gutters = await ctx.landZone("gutters", "Gutters", "gutters", "gutter_pitch");

    // Action on the north slope, backed by evidence.
    await addInspectionFinding({
      tenantId: ctx.tenantId, inspectionZoneId: north.zoneId,
      whatItIs: "Sealant bond failed", ifIgnored: "Wind lift risk", timeframe: "Before storm season",
      photoIds: [north.docId], createdBy: "inspector", disposition: "repair_quoted", repairEstimateCents: 42000,
    });
    // An unconfirmed AI suggestion must NEVER render.
    await addInspectionFinding({
      tenantId: ctx.tenantId, inspectionZoneId: north.zoneId,
      whatItIs: "AI ghost finding", photoIds: [north.docId], createdBy: "ai_suggested",
    });
    // Friend rule on the gutters ($90 hanger resecure).
    const hanger = await addInspectionFinding({
      tenantId: ctx.tenantId, inspectionZoneId: gutters.zoneId,
      whatItIs: "Two loose gutter hangers", photoIds: [gutters.docId], createdBy: "inspector",
      checklistItemKey: "gutter_pitch", repairEstimateCents: 9000,
    });
    if ("error" in hanger) throw new Error("seed failed");
    await applyFriendRule({ tenantId: ctx.tenantId, findingId: hanger.findingId });

    await setInspectionZoneGrade({ tenantId: ctx.tenantId, inspectionZoneId: north.zoneId, grade: "action", userId: ctx.userId });
    await setInspectionZoneGrade({ tenantId: ctx.tenantId, inspectionZoneId: gutters.zoneId, grade: "good", userId: ctx.userId });
    await completeInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId });
    // Resolve the pipe's auto-suggestion (gutter_pitch media) + our manual ghost so approval unblocks.
    const { inspectionFinding, and, isNull } = await import("../src/index.js");
    await adminDb.delete(inspectionFinding).where(and(eq(inspectionFinding.tenantId, ctx.tenantId), isNull(inspectionFinding.confirmedAt)));
    await setInspectionNarrative({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId, narrative: "An honest roof story.", source: "ai" });
    await approveInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId, userId: ctx.userId });
    await publishInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId });

    const page = await getRecordPageData({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId });
    expect(page).not.toBeNull();
    expect(page!.healthy).toBe(false);
    expect(page!.narrative).toBe("An honest roof story.");
    expect(page!.address).toBe("1 Test St");
    expect(page!.inspectorFirstName).toBe("Ida");

    const northZone = page!.zones.find((z) => z.zoneKey === "north_slope")!;
    expect(northZone.grade).toBe("action");
    expect(northZone.findings).toHaveLength(1); // the ghost never renders
    expect(northZone.findings[0]!.whatItIs).toBe("Sealant bond failed");
    expect(northZone.photos.length).toBeGreaterThanOrEqual(1);

    expect(page!.freeRepairs).toHaveLength(1);
    expect(page!.freeRepairs[0]!.whatItIs).toBe("Two loose gutter hangers");
    // Suggestions: the quoted repair appears; the comped one does not.
    expect(page!.suggestions.map((s) => s.whatItIs)).toEqual(["Sealant bond failed"]);
    expect(page!.suggestions[0]!.repairEstimateCents).toBe(42000);
    expect(page!.replacementDiscussion).toBe(false); // no replacement_factor findings
  });

  it("HEALTHY ROOF: all zones GOOD → healthy true, no suggestions, next-check copy inputs present", async () => {
    const ctx = await seedRecord();
    const z = await ctx.landZone("south_slope", "South slope", "facet");
    await setInspectionZoneGrade({ tenantId: ctx.tenantId, inspectionZoneId: z.zoneId, grade: "good", userId: ctx.userId });
    await completeInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId });
    await approveInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId, userId: ctx.userId });
    await publishInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId });

    const page = await getRecordPageData({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId });
    expect(page!.healthy).toBe(true);
    expect(page!.suggestions).toHaveLength(0);
    expect(page!.publishedAt).toBeInstanceOf(Date);
  });
});
