import { afterAll, describe, it, expect } from "vitest";
import { inArray, eq, and } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { withTenant } from "../tenant.js";
import {
  tenant, customer, property, lead, document,
  inspection, inspectionZone, inspectionMedia, inspectionFinding,
} from "../schema/index.js";
import {
  startInspectionForLead,
  ingestInspectionMedia,
  completeInspection,
  getInspectionProgress,
} from "./inspection.js";

const tenantIds: string[] = [];

async function seedContext() {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "InspTest", publicKey: `pk-insp-${crypto.randomUUID()}`, clerkOrgId: `org-insp-${crypto.randomUUID()}` })
    .returning();
  tenantIds.push(t!.id);
  const tenantId = t!.id;

  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Insp Cust" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Roof Record Rd" }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "web" }).returning();

  return { tenantId, customerId: c!.id, propertyId: p!.id, leadId: l!.id };
}

async function seedPhotoDoc(tenantId: string, leadId: string, label = "zone photo") {
  const [d] = await adminDb.insert(document).values({
    tenantId, leadId, kind: "photo", source: "sitesnap", label,
    sitesnapPhotoId: `ss-${crypto.randomUUID()}`,
  }).returning();
  return d!.id;
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
    await adminDb.delete(tenant).where(inArray(tenant.id, tenantIds));
  }
  await pool.end();
  await adminPool.end();
});

describe("startInspectionForLead", () => {
  it("creates an in_progress inspection scoped to the lead's property", async () => {
    const ctx = await seedContext();
    const res = await startInspectionForLead({ tenantId: ctx.tenantId, leadId: ctx.leadId });
    expect(res.created).toBe(true);

    const [row] = await adminDb.select().from(inspection).where(eq(inspection.id, res.inspectionId));
    expect(row!.status).toBe("in_progress");
    expect(row!.kind).toBe("initial");
    expect(row!.leadId).toBe(ctx.leadId);
    expect(row!.propertyId).toBe(ctx.propertyId);
    expect(row!.startedAt).toBeInstanceOf(Date);
  });

  it("is idempotent: a second start while one is in_progress returns the existing inspection", async () => {
    const ctx = await seedContext();
    const first = await startInspectionForLead({ tenantId: ctx.tenantId, leadId: ctx.leadId });
    const second = await startInspectionForLead({ tenantId: ctx.tenantId, leadId: ctx.leadId });
    expect(second.created).toBe(false);
    expect(second.inspectionId).toBe(first.inspectionId);
  });

  it("returns lead_not_found for an unknown lead", async () => {
    const ctx = await seedContext();
    const res = await startInspectionForLead({ tenantId: ctx.tenantId, leadId: crypto.randomUUID() });
    expect(res).toEqual({ error: "lead_not_found" });
  });
});

describe("ingestInspectionMedia", () => {
  it("creates the zone on first media for a zone_key and links the photo to it", async () => {
    const ctx = await seedContext();
    const started = await startInspectionForLead({ tenantId: ctx.tenantId, leadId: ctx.leadId });
    const docId = await seedPhotoDoc(ctx.tenantId, ctx.leadId);

    const res = await ingestInspectionMedia({
      tenantId: ctx.tenantId, inspectionId: started.inspectionId!,
      zoneKey: "north_slope", zoneLabel: "North slope", zoneKind: "facet",
      documentId: docId, capturedAt: new Date(), gps: { lat: 33.45, lng: -112.07 },
    });
    expect("error" in res).toBe(false);

    const zones = await adminDb.select().from(inspectionZone)
      .where(eq(inspectionZone.inspectionId, started.inspectionId!));
    expect(zones).toHaveLength(1);
    expect(zones[0]!.zoneKey).toBe("north_slope");
    expect(zones[0]!.zoneKind).toBe("facet");
    expect(zones[0]!.grade).toBeNull();

    const media = await adminDb.select().from(inspectionMedia)
      .where(eq(inspectionMedia.inspectionZoneId, zones[0]!.id));
    expect(media).toHaveLength(1);
    expect(media[0]!.documentId).toBe(docId);
  });

  it("reuses the zone for subsequent media with the same zone_key", async () => {
    const ctx = await seedContext();
    const started = await startInspectionForLead({ tenantId: ctx.tenantId, leadId: ctx.leadId });
    const doc1 = await seedPhotoDoc(ctx.tenantId, ctx.leadId);
    const doc2 = await seedPhotoDoc(ctx.tenantId, ctx.leadId);

    await ingestInspectionMedia({ tenantId: ctx.tenantId, inspectionId: started.inspectionId!, zoneKey: "gutters", zoneLabel: "Gutters", zoneKind: "gutters", documentId: doc1 });
    await ingestInspectionMedia({ tenantId: ctx.tenantId, inspectionId: started.inspectionId!, zoneKey: "gutters", zoneLabel: "Gutters", zoneKind: "gutters", documentId: doc2 });

    const zones = await adminDb.select().from(inspectionZone)
      .where(eq(inspectionZone.inspectionId, started.inspectionId!));
    expect(zones).toHaveLength(1);

    const media = await adminDb.select().from(inspectionMedia)
      .where(eq(inspectionMedia.inspectionZoneId, zones[0]!.id));
    expect(media).toHaveLength(2);
  });

  it("replaying the same media event is a no-op (webhook retry ⇒ one photo)", async () => {
    const ctx = await seedContext();
    const started = await startInspectionForLead({ tenantId: ctx.tenantId, leadId: ctx.leadId });
    const docId = await seedPhotoDoc(ctx.tenantId, ctx.leadId);
    const input = { tenantId: ctx.tenantId, inspectionId: started.inspectionId!, zoneKey: "ridge", zoneLabel: "Ridge", zoneKind: "ridge" as const, documentId: docId };

    const first = await ingestInspectionMedia(input);
    const replay = await ingestInspectionMedia(input);
    expect("error" in first).toBe(false);
    expect("error" in replay).toBe(false);

    const media = await adminDb.select().from(inspectionMedia)
      .where(and(eq(inspectionMedia.inspectionId, started.inspectionId!), eq(inspectionMedia.documentId, docId)));
    expect(media).toHaveLength(1);
  });

  it("refuses media for an unknown inspection", async () => {
    const ctx = await seedContext();
    const docId = await seedPhotoDoc(ctx.tenantId, ctx.leadId);
    const res = await ingestInspectionMedia({
      tenantId: ctx.tenantId, inspectionId: crypto.randomUUID(),
      zoneKey: "x", zoneLabel: "X", documentId: docId,
    });
    expect(res).toEqual({ error: "inspection_not_found" });
  });

  it("refuses media once the inspection is approved/published", async () => {
    const ctx = await seedContext();
    const started = await startInspectionForLead({ tenantId: ctx.tenantId, leadId: ctx.leadId });
    await adminDb.update(inspection).set({ status: "approved" }).where(eq(inspection.id, started.inspectionId!));
    const docId = await seedPhotoDoc(ctx.tenantId, ctx.leadId);
    const res = await ingestInspectionMedia({
      tenantId: ctx.tenantId, inspectionId: started.inspectionId!,
      zoneKey: "north_slope", zoneLabel: "North slope", documentId: docId,
    });
    expect(res).toEqual({ error: "inspection_closed" });
  });
});

describe("getInspectionProgress", () => {
  it("returns per-zone status with photo counts, ordered by sort_order then creation", async () => {
    const ctx = await seedContext();
    const started = await startInspectionForLead({ tenantId: ctx.tenantId, leadId: ctx.leadId });
    const doc1 = await seedPhotoDoc(ctx.tenantId, ctx.leadId);
    const doc2 = await seedPhotoDoc(ctx.tenantId, ctx.leadId);
    const doc3 = await seedPhotoDoc(ctx.tenantId, ctx.leadId);

    await ingestInspectionMedia({ tenantId: ctx.tenantId, inspectionId: started.inspectionId!, zoneKey: "ground_front", zoneLabel: "Ground — front elevation", zoneKind: "ground", documentId: doc1 });
    await ingestInspectionMedia({ tenantId: ctx.tenantId, inspectionId: started.inspectionId!, zoneKey: "north_slope", zoneLabel: "North slope", zoneKind: "facet", documentId: doc2 });
    await ingestInspectionMedia({ tenantId: ctx.tenantId, inspectionId: started.inspectionId!, zoneKey: "north_slope", zoneLabel: "North slope", zoneKind: "facet", documentId: doc3 });

    const progress = await getInspectionProgress({ tenantId: ctx.tenantId, inspectionId: started.inspectionId! });
    expect(progress).not.toBeNull();
    expect(progress!.status).toBe("in_progress");
    expect(progress!.zones).toHaveLength(2);
    const north = progress!.zones.find((z) => z.zoneKey === "north_slope");
    expect(north!.photoCount).toBe(2);
    expect(north!.grade).toBeNull();
    const ground = progress!.zones.find((z) => z.zoneKey === "ground_front");
    expect(ground!.photoCount).toBe(1);
  });

  it("returns null for an unknown inspection", async () => {
    const ctx = await seedContext();
    const progress = await getInspectionProgress({ tenantId: ctx.tenantId, inspectionId: crypto.randomUUID() });
    expect(progress).toBeNull();
  });
});

describe("completeInspection", () => {
  it("moves in_progress → pending_approval and stamps completed_at", async () => {
    const ctx = await seedContext();
    const started = await startInspectionForLead({ tenantId: ctx.tenantId, leadId: ctx.leadId });
    const res = await completeInspection({ tenantId: ctx.tenantId, inspectionId: started.inspectionId! });
    expect("error" in res).toBe(false);

    const [row] = await adminDb.select().from(inspection).where(eq(inspection.id, started.inspectionId!));
    expect(row!.status).toBe("pending_approval");
    expect(row!.completedAt).toBeInstanceOf(Date);
  });

  it("is idempotent and refuses non-in_progress inspections", async () => {
    const ctx = await seedContext();
    const started = await startInspectionForLead({ tenantId: ctx.tenantId, leadId: ctx.leadId });
    await completeInspection({ tenantId: ctx.tenantId, inspectionId: started.inspectionId! });
    const again = await completeInspection({ tenantId: ctx.tenantId, inspectionId: started.inspectionId! });
    expect(again).toEqual({ error: "not_in_progress" });
  });
});

describe("RLS", () => {
  it("cross-tenant reads of inspections return nothing", async () => {
    const a = await seedContext();
    const b = await seedContext();
    const started = await startInspectionForLead({ tenantId: a.tenantId, leadId: a.leadId });
    expect(started.created).toBe(true);

    const visibleToB = await withTenant(b.tenantId, (tx) => tx.select().from(inspection));
    expect(visibleToB.find((r) => r.id === started.inspectionId)).toBeUndefined();

    const progressFromB = await getInspectionProgress({ tenantId: b.tenantId, inspectionId: started.inspectionId! });
    expect(progressFromB).toBeNull();
  });
});
