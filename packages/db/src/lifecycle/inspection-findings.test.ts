import { afterAll, describe, it, expect } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import {
  tenant, customer, property, lead, user, document,
  inspection, inspectionZone, inspectionMedia, inspectionFinding,
} from "../schema/index.js";
import { startInspectionForLead, ingestInspectionMedia } from "./inspection.js";
import {
  addInspectionFinding,
  confirmInspectionFinding,
  dismissInspectionFinding,
  setInspectionZoneGrade,
} from "./inspection-findings.js";

const tenantIds: string[] = [];

async function seedZoneContext() {
  const [t] = await adminDb.insert(tenant)
    .values({ name: "FindTest", publicKey: `pk-find-${crypto.randomUUID()}`, clerkOrgId: `org-find-${crypto.randomUUID()}` })
    .returning();
  tenantIds.push(t!.id);
  const tenantId = t!.id;
  const [u] = await adminDb.insert(user).values({ tenantId, clerkUserId: `clk-${crypto.randomUUID()}`, name: "Inspector Ida", email: `ida-${crypto.randomUUID()}@test.local`, role: "admin" }).returning();
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Find Cust" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "2 Honest Way" }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "web" }).returning();

  const started = await startInspectionForLead({ tenantId, leadId: l!.id });
  if ("error" in started) throw new Error(started.error);

  const [d] = await adminDb.insert(document).values({
    tenantId, leadId: l!.id, kind: "photo", source: "sitesnap", label: "north",
    sitesnapPhotoId: `ss-${crypto.randomUUID()}`,
  }).returning();
  const media = await ingestInspectionMedia({
    tenantId, inspectionId: started.inspectionId, zoneKey: "north_slope", zoneLabel: "North slope", zoneKind: "facet", documentId: d!.id,
  });
  if ("error" in media) throw new Error(media.error);

  return { tenantId, userId: u!.id, inspectionId: started.inspectionId, zoneId: media.inspectionZoneId, photoDocId: d!.id };
}

afterAll(async () => {
  if (tenantIds.length) {
    await adminDb.delete(inspectionMedia).where(inArray(inspectionMedia.tenantId, tenantIds));
    await adminDb.delete(inspectionFinding).where(inArray(inspectionFinding.tenantId, tenantIds));
    await adminDb.delete(inspectionZone).where(inArray(inspectionZone.tenantId, tenantIds));
    await adminDb.delete(inspection).where(inArray(inspection.tenantId, tenantIds));
    await adminDb.delete(document).where(inArray(document.tenantId, tenantIds));
    await adminDb.delete(lead).where(inArray(lead.tenantId, tenantIds));
    await adminDb.delete(property).where(inArray(property.tenantId, tenantIds));
    await adminDb.delete(customer).where(inArray(customer.tenantId, tenantIds));
    await adminDb.delete(user).where(inArray(user.tenantId, tenantIds));
    await adminDb.delete(tenant).where(inArray(tenant.id, tenantIds));
  }
  await pool.end();
  await adminPool.end();
});

describe("setInspectionZoneGrade — the anti-scare invariant", () => {
  it("RED PATH: refuses ACTION on a zone with no findings at all", async () => {
    const ctx = await seedZoneContext();
    const res = await setInspectionZoneGrade({ tenantId: ctx.tenantId, inspectionZoneId: ctx.zoneId, grade: "action", userId: ctx.userId });
    expect(res).toEqual({ error: "action_requires_evidence" });
    const [zone] = await adminDb.select().from(inspectionZone).where(eq(inspectionZone.id, ctx.zoneId));
    expect(zone!.grade).toBeNull();
  });

  it("RED PATH: refuses ACTION when the zone's findings carry no photos", async () => {
    const ctx = await seedZoneContext();
    await addInspectionFinding({
      tenantId: ctx.tenantId, inspectionZoneId: ctx.zoneId,
      whatItIs: "Sealant bond failed on 3 test shingles", ifIgnored: "Wind can lift unsealed shingles",
      timeframe: "Before the next storm season", photoIds: [], createdBy: "inspector",
    });
    const res = await setInspectionZoneGrade({ tenantId: ctx.tenantId, inspectionZoneId: ctx.zoneId, grade: "action", userId: ctx.userId });
    expect(res).toEqual({ error: "action_requires_evidence" });
  });

  it("allows ACTION once a finding carries at least one photo, and stamps the inspector", async () => {
    const ctx = await seedZoneContext();
    await addInspectionFinding({
      tenantId: ctx.tenantId, inspectionZoneId: ctx.zoneId,
      whatItIs: "Sealant bond failed on 3 test shingles", ifIgnored: "Wind can lift unsealed shingles",
      timeframe: "Before the next storm season", photoIds: [ctx.photoDocId], createdBy: "inspector",
    });
    const res = await setInspectionZoneGrade({ tenantId: ctx.tenantId, inspectionZoneId: ctx.zoneId, grade: "action", userId: ctx.userId });
    expect("error" in res).toBe(false);
    const [zone] = await adminDb.select().from(inspectionZone).where(eq(inspectionZone.id, ctx.zoneId));
    expect(zone!.grade).toBe("action");
    expect(zone!.gradeSetByUserId).toBe(ctx.userId);
  });

  it("'your roof is fine' is first-class: GOOD and MONITOR need no findings", async () => {
    const ctx = await seedZoneContext();
    const good = await setInspectionZoneGrade({ tenantId: ctx.tenantId, inspectionZoneId: ctx.zoneId, grade: "good", userId: ctx.userId });
    expect("error" in good).toBe(false);
    const monitor = await setInspectionZoneGrade({ tenantId: ctx.tenantId, inspectionZoneId: ctx.zoneId, grade: "monitor", userId: ctx.userId });
    expect("error" in monitor).toBe(false);
  });

  it("an UNCONFIRMED ai_suggested finding does not license ACTION (human decides)", async () => {
    const ctx = await seedZoneContext();
    await addInspectionFinding({
      tenantId: ctx.tenantId, inspectionZoneId: ctx.zoneId,
      whatItIs: "Possible hail bruising", photoIds: [ctx.photoDocId], createdBy: "ai_suggested",
    });
    const res = await setInspectionZoneGrade({ tenantId: ctx.tenantId, inspectionZoneId: ctx.zoneId, grade: "action", userId: ctx.userId });
    expect(res).toEqual({ error: "action_requires_evidence" });
  });
});

describe("finding lifecycle", () => {
  it("ai_suggested findings confirm (stamps confirmedAt) or dismiss (row removed)", async () => {
    const ctx = await seedZoneContext();
    const a = await addInspectionFinding({
      tenantId: ctx.tenantId, inspectionZoneId: ctx.zoneId,
      whatItIs: "Possible granule loss", photoIds: [ctx.photoDocId], createdBy: "ai_suggested",
    });
    const b = await addInspectionFinding({
      tenantId: ctx.tenantId, inspectionZoneId: ctx.zoneId,
      whatItIs: "Possible flashing gap", photoIds: [], createdBy: "ai_suggested",
    });
    if ("error" in a || "error" in b) throw new Error("seed findings failed");

    await confirmInspectionFinding({ tenantId: ctx.tenantId, findingId: a.findingId, userId: ctx.userId });
    const [confirmed] = await adminDb.select().from(inspectionFinding).where(eq(inspectionFinding.id, a.findingId));
    expect(confirmed!.confirmedAt).toBeInstanceOf(Date);

    await dismissInspectionFinding({ tenantId: ctx.tenantId, findingId: b.findingId });
    const rows = await adminDb.select().from(inspectionFinding).where(eq(inspectionFinding.id, b.findingId));
    expect(rows).toHaveLength(0);
  });

  it("inspector findings are born confirmed; a CONFIRMED ai_suggested finding licenses ACTION", async () => {
    const ctx = await seedZoneContext();
    const a = await addInspectionFinding({
      tenantId: ctx.tenantId, inspectionZoneId: ctx.zoneId,
      whatItIs: "Hail bruising confirmed on site", photoIds: [ctx.photoDocId], createdBy: "ai_suggested",
    });
    if ("error" in a) throw new Error("seed failed");
    await confirmInspectionFinding({ tenantId: ctx.tenantId, findingId: a.findingId, userId: ctx.userId });

    const res = await setInspectionZoneGrade({ tenantId: ctx.tenantId, inspectionZoneId: ctx.zoneId, grade: "action", userId: ctx.userId });
    expect("error" in res).toBe(false);
  });
});
