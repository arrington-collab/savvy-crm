import { describe, it, expect, vi } from "vitest";
import {
  adminDb, tenant, customer, property, lead, document, inspection, inspectionZone, eq,
  startInspectionForLead, ingestInspectionMedia, completeInspection,
  addInspectionFinding, setInspectionNarrative,
} from "@savvy/db";
import { draftInspectionNarrative, NARRATIVE_RUBRIC_V1 } from "./inspection-narrative.js";

async function seed(withReplacementFactor = false) {
  const [t] = await adminDb.insert(tenant).values({ name: "Narr", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` }).returning();
  const tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "C" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "3 Narrative Ln" }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "web" }).returning();
  const started = await startInspectionForLead({ tenantId, leadId: l!.id });
  if ("error" in started) throw new Error("start failed");
  const inspectionId = started.inspectionId;

  const [d] = await adminDb.insert(document).values({ tenantId, leadId: l!.id, kind: "photo", source: "sitesnap", sitesnapPhotoId: `ss-${crypto.randomUUID()}` }).returning();
  const media = await ingestInspectionMedia({ tenantId, inspectionId, zoneKey: "north_slope", zoneLabel: "North slope", zoneKind: "facet", documentId: d!.id });
  if ("error" in media) throw new Error("media failed");
  await addInspectionFinding({
    tenantId, inspectionZoneId: media.inspectionZoneId,
    whatItIs: "Sealant bond failed", ifIgnored: "Wind lift risk", timeframe: "Before storm season",
    photoIds: [d!.id], createdBy: "inspector",
    disposition: withReplacementFactor ? "replacement_factor" : "noted",
  });
  await completeInspection({ tenantId, inspectionId });
  return { tenantId, inspectionId };
}

const fakeAi = (narrative: string) => ({
  completeObject: vi.fn(async () => ({
    object: { narrative, zones: [{ zoneKey: "north_slope", summary: "The north slope shows failed sealant on several shingles. Worth re-sealing before storm season." }] },
    model: "fake-model",
  })),
});

describe("draftInspectionNarrative", () => {
  it("drafts zone summaries + the whole-roof narrative via the cheap capability and stores them", async () => {
    const { tenantId, inspectionId } = await seed();
    const ai = fakeAi("An honest, plain-English roof story.");

    const res = await draftInspectionNarrative({ tenantId, inspectionId }, ai as never);
    expect("narrative" in res).toBe(true);
    expect(ai.completeObject).toHaveBeenCalledOnce();
    const call = (ai.completeObject.mock.calls as unknown as [{ capability: string; system: string }][])[0]![0];
    expect(call.capability).toBe("workhorse");
    expect(call.system).toContain(NARRATIVE_RUBRIC_V1.slice(0, 40)); // rubric rides the system prompt

    const [row] = await adminDb.select().from(inspection).where(eq(inspection.id, inspectionId));
    expect(row!.narrative).toBe("An honest, plain-English roof story.");
    expect(row!.narrativeDraftedAt).toBeInstanceOf(Date);
    const [zone] = await adminDb.select().from(inspectionZone).where(eq(inspectionZone.inspectionId, inspectionId));
    expect(zone!.summary).toContain("north slope shows failed sealant");
  });

  it("ANTI-SCARE: strips a replacement recommendation when no replacement_factor finding exists", async () => {
    const { tenantId, inspectionId } = await seed(false);
    const ai = fakeAi("This roof is tired — we recommend full replacement soon.");

    const res = await draftInspectionNarrative({ tenantId, inspectionId }, ai as never);
    expect("narrative" in res && res.rubricViolation).toBe(true);

    const [row] = await adminDb.select().from(inspection).where(eq(inspection.id, inspectionId));
    expect(row!.narrative).not.toContain("replacement");
  });

  it("allows replacement language when a replacement_factor finding exists", async () => {
    const { tenantId, inspectionId } = await seed(true);
    const ai = fakeAi("Several findings point toward replacement as the economical path.");

    await draftInspectionNarrative({ tenantId, inspectionId }, ai as never);
    const [row] = await adminDb.select().from(inspection).where(eq(inspection.id, inspectionId));
    expect(row!.narrative).toContain("replacement");
  });

  it("never overwrites an inspector-edited narrative", async () => {
    const { tenantId, inspectionId } = await seed();
    await setInspectionNarrative({ tenantId, inspectionId, narrative: "Inspector's words.", source: "inspector", userId: null });

    const ai = fakeAi("AI tries to talk over the inspector.");
    const res = await draftInspectionNarrative({ tenantId, inspectionId }, ai as never);
    expect(res).toEqual({ skipped: "inspector_edited" });
  });
});
