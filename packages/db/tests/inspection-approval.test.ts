import { describe, it, expect } from "vitest";
import { adminDb, inspection, document, user, eq, startInspectionForLead, ingestInspectionMedia, completeInspection, addInspectionFinding, confirmInspectionFinding } from "../src/index.js";
import { approveInspection, publishInspection, setInspectionNarrative } from "../src/lifecycle/inspection-approval.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

async function seedCompletedInspection() {
  const { tenantId } = await makeTenant();
  const { leadId } = await makeLeadWithProperty(tenantId);
  const [u] = await adminDb.insert(user).values({ tenantId, clerkUserId: `clk-${crypto.randomUUID()}`, name: "Inspector Ida", email: `ida-${crypto.randomUUID()}@test.local`, role: "admin" }).returning();

  const started = await startInspectionForLead({ tenantId, leadId });
  if ("error" in started) throw new Error(started.error);

  return { tenantId, leadId, userId: u!.id, inspectionId: started.inspectionId };
}

describe("approveInspection — the inspector approval gate", () => {
  it("approves a pending_approval Record and stamps the approver", async () => {
    const ctx = await seedCompletedInspection();
    await completeInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId });

    const res = await approveInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId, userId: ctx.userId });
    expect("error" in res).toBe(false);

    const [row] = await adminDb.select().from(inspection).where(eq(inspection.id, ctx.inspectionId));
    expect(row!.status).toBe("approved");
    expect(row!.approvedAt).toBeInstanceOf(Date);
    expect(row!.approvedByUserId).toBe(ctx.userId);
  });

  it("refuses approval from in_progress (capture is not done)", async () => {
    const ctx = await seedCompletedInspection();
    const res = await approveInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId, userId: ctx.userId });
    expect(res).toEqual({ error: "not_pending_approval" });
  });

  it("RED PATH: blocks approval while UNCONFIRMED ai_suggested findings exist — confirm or dismiss first", async () => {
    const ctx = await seedCompletedInspection();
    // Land a zone + an unconfirmed suggestion on it.
    const [doc] = await adminDb.insert(document).values({
      tenantId: ctx.tenantId, leadId: ctx.leadId, kind: "photo", source: "sitesnap", sitesnapPhotoId: `ss-${crypto.randomUUID()}`,
    }).returning();
    const media = await ingestInspectionMedia({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId, zoneKey: "ridge", zoneLabel: "Ridge", zoneKind: "ridge", documentId: doc!.id });
    if ("error" in media) throw new Error(media.error);
    const suggested = await addInspectionFinding({
      tenantId: ctx.tenantId, inspectionZoneId: media.inspectionZoneId,
      whatItIs: "Possible cracked ridge cap", photoIds: [doc!.id], createdBy: "ai_suggested",
    });
    if ("error" in suggested) throw new Error("seed failed");
    await completeInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId });

    const blocked = await approveInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId, userId: ctx.userId });
    expect(blocked).toEqual({ error: "unconfirmed_suggestions", count: 1 });

    // Resolving the suggestion (either way) unblocks approval.
    await confirmInspectionFinding({ tenantId: ctx.tenantId, findingId: suggested.findingId, userId: ctx.userId });
    const ok = await approveInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId, userId: ctx.userId });
    expect("error" in ok).toBe(false);
  });
});

describe("publishInspection", () => {
  it("publishes only an approved Record", async () => {
    const ctx = await seedCompletedInspection();
    const early = await publishInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId });
    expect(early).toEqual({ error: "not_approved" });

    await completeInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId });
    await approveInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId, userId: ctx.userId });
    const res = await publishInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId });
    expect("error" in res).toBe(false);

    const [row] = await adminDb.select().from(inspection).where(eq(inspection.id, ctx.inspectionId));
    expect(row!.status).toBe("published");
    expect(row!.publishedAt).toBeInstanceOf(Date);
  });
});

describe("setInspectionNarrative — inspector edits are tracked", () => {
  it("stores the edit with the editor stamp; AI drafts never overwrite an inspector edit", async () => {
    const ctx = await seedCompletedInspection();
    await completeInspection({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId });

    // AI draft lands first (no editor stamp).
    await setInspectionNarrative({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId, narrative: "AI draft of the roof story.", source: "ai" });
    let [row] = await adminDb.select().from(inspection).where(eq(inspection.id, ctx.inspectionId));
    expect(row!.narrative).toBe("AI draft of the roof story.");
    expect(row!.narrativeDraftedAt).toBeInstanceOf(Date);
    expect(row!.narrativeEditedByUserId).toBeNull();

    // Inspector edits — tracked.
    await setInspectionNarrative({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId, narrative: "The inspector's own words.", source: "inspector", userId: ctx.userId });
    [row] = await adminDb.select().from(inspection).where(eq(inspection.id, ctx.inspectionId));
    expect(row!.narrative).toBe("The inspector's own words.");
    expect(row!.narrativeEditedByUserId).toBe(ctx.userId);

    // A later AI draft must NOT overwrite the inspector's edit.
    const res = await setInspectionNarrative({ tenantId: ctx.tenantId, inspectionId: ctx.inspectionId, narrative: "AI tries again.", source: "ai" });
    expect(res).toEqual({ skipped: "inspector_edited" });
    [row] = await adminDb.select().from(inspection).where(eq(inspection.id, ctx.inspectionId));
    expect(row!.narrative).toBe("The inspector's own words.");
  });
});
