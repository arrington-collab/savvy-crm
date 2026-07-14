import { describe, it, expect, vi } from "vitest";
import { adminDb, tenant, customer, property, job, lead, withTenant, document, eq, and, inspectionZone, inspectionMedia, startInspectionForLead } from "@savvy/db";
import { makeFakeStorage } from "@savvy/integrations";
import { ingestSiteSnapPhoto } from "./sitesnap-ingest";

async function seed(key: string) {
  const [t] = await adminDb.insert(tenant).values({ name: "SS", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`, settings: { sitesnap: { ingestKey: key } } as never }).returning();
  const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "123 Main Street" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, source: "web" }).returning();
  return { tenantId: t!.id, jobId: j!.id, leadId: l!.id };
}

const fetchBytes = async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" });

describe("ingestSiteSnapPhoto", () => {
  it("401s on an unknown key", async () => {
    const r = await ingestSiteSnapPhoto({ address: "x", category: "ridge", imageUrl: "u", externalPhotoId: "e1" }, "bad-key", { storage: makeFakeStorage(), fetchBytes, emit: vi.fn() });
    expect(r.status).toBe(401);
  });

  it("matches by address, stores to R2, records the doc, and emits", async () => {
    const key = `k-${crypto.randomUUID()}`;
    const { tenantId, jobId } = await seed(key);
    const storage = makeFakeStorage();
    const emit = vi.fn(async () => {});
    const r = await ingestSiteSnapPhoto({ address: "123 Main St.", category: "ridge", imageUrl: "u", externalPhotoId: "e2" }, key, { storage, fetchBytes, emit });
    expect(r.status).toBe(200);
    expect(storage.calls.some((c) => c.op === "put" || c.op === "upload")).toBe(true);
    const rows = await withTenant(tenantId, (tx) => tx.select().from(document).where(eq(document.sitesnapPhotoId, "e2")));
    expect(rows[0]!.jobId).toBe(jobId);
    expect(emit).toHaveBeenCalledWith(jobId, rows[0]!.id, tenantId);
  });

  it("returns 502 and does not record a document when fetchBytes throws", async () => {
    const key = `k-${crypto.randomUUID()}`;
    const { tenantId } = await seed(key);
    const storage = makeFakeStorage();
    const emit = vi.fn();
    const failFetch = async (_url: string): Promise<{ bytes: Uint8Array; mime: string }> => { throw new Error("blocked_host"); };
    const r = await ingestSiteSnapPhoto({ address: "123 Main Street", category: "ridge", imageUrl: "u", externalPhotoId: "e4" }, key, { storage, fetchBytes: failFetch, emit });
    expect(r.status).toBe(502);
    const rows = await withTenant(tenantId, (tx) => tx.select().from(document).where(eq(document.sitesnapPhotoId, "e4")));
    expect(rows).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it("stores unmatched (jobId null) when no address matches", async () => {
    const key = `k-${crypto.randomUUID()}`;
    const { tenantId } = await seed(key);
    const r = await ingestSiteSnapPhoto({ address: "999 Nowhere Rd", category: "eave", imageUrl: "u", externalPhotoId: "e3" }, key, { storage: makeFakeStorage(), fetchBytes, emit: vi.fn(async () => {}) });
    expect(r.status).toBe(200);
    const rows = await withTenant(tenantId, (tx) => tx.select().from(document).where(eq(document.sitesnapPhotoId, "e3")));
    expect(rows[0]!.jobId).toBeNull();
  });
});

describe("ingestSiteSnapPhoto — zone-first roof-record media", () => {
  it("lands zone-tagged media on its inspection zone and lead-scopes the document", async () => {
    const key = `k-${crypto.randomUUID()}`;
    const { tenantId, leadId } = await seed(key);
    const started = await startInspectionForLead({ tenantId, leadId });
    const inspectionId = (started as { inspectionId: string }).inspectionId;
    const emitInspectionMedia = vi.fn(async () => {});

    const r = await ingestSiteSnapPhoto({
      address: "123 Main Street", category: "roof", imageUrl: "u", externalPhotoId: "z1",
      inspectionId, zoneKey: "north_slope", zoneLabel: "North slope", zoneKind: "facet",
      capturedAtMs: Date.now(), gps: { lat: 33.45, lng: -112.07 }, note: "granule loss at eave",
    }, key, { storage: makeFakeStorage(), fetchBytes, emit: vi.fn(async () => {}), emitInspectionMedia });

    expect(r.status).toBe(200);
    expect((r.body as { inspectionLinked?: boolean }).inspectionLinked).toBe(true);

    const [doc] = await withTenant(tenantId, (tx) => tx.select().from(document).where(eq(document.sitesnapPhotoId, "z1")));
    expect(doc!.leadId).toBe(leadId); // lead-scoped so QC + the lead photo rail see it

    const zones = await withTenant(tenantId, (tx) => tx.select().from(inspectionZone).where(eq(inspectionZone.inspectionId, inspectionId)));
    expect(zones).toHaveLength(1);
    expect(zones[0]!.zoneKey).toBe("north_slope");
    expect((zones[0]!.inspectorNotes as { text: string }[])[0]!.text).toBe("granule loss at eave");

    const media = await withTenant(tenantId, (tx) => tx.select().from(inspectionMedia).where(
      and(eq(inspectionMedia.inspectionId, inspectionId), eq(inspectionMedia.documentId, doc!.id))));
    expect(media).toHaveLength(1);
    expect(emitInspectionMedia).toHaveBeenCalledWith({ tenantId, inspectionId, leadId, zoneKey: "north_slope", documentId: doc!.id });
  });

  it("replaying the same media event keeps one document and one zone link, and does not re-emit", async () => {
    const key = `k-${crypto.randomUUID()}`;
    const { tenantId, leadId } = await seed(key);
    const started = await startInspectionForLead({ tenantId, leadId });
    const inspectionId = (started as { inspectionId: string }).inspectionId;
    const emit = vi.fn(async () => {});
    const emitInspectionMedia = vi.fn(async () => {});
    const body = {
      address: "123 Main Street", category: "roof", imageUrl: "u", externalPhotoId: "z2",
      inspectionId, zoneKey: "gutters", zoneLabel: "Gutters", zoneKind: "gutters",
    };

    await ingestSiteSnapPhoto(body, key, { storage: makeFakeStorage(), fetchBytes, emit, emitInspectionMedia });
    const replay = await ingestSiteSnapPhoto(body, key, { storage: makeFakeStorage(), fetchBytes, emit, emitInspectionMedia });
    expect(replay.status).toBe(200);

    const docs = await withTenant(tenantId, (tx) => tx.select().from(document).where(eq(document.sitesnapPhotoId, "z2")));
    expect(docs).toHaveLength(1);
    const media = await withTenant(tenantId, (tx) => tx.select().from(inspectionMedia).where(
      and(eq(inspectionMedia.inspectionId, inspectionId), eq(inspectionMedia.documentId, docs[0]!.id))));
    expect(media).toHaveLength(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emitInspectionMedia).toHaveBeenCalledTimes(1);
  });

  it("keeps the photo but reports inspectionLinked:false for an unknown inspection id", async () => {
    const key = `k-${crypto.randomUUID()}`;
    const { tenantId } = await seed(key);
    const r = await ingestSiteSnapPhoto({
      address: "123 Main Street", category: "roof", imageUrl: "u", externalPhotoId: "z3",
      inspectionId: crypto.randomUUID(), zoneKey: "ridge", zoneLabel: "Ridge",
    }, key, { storage: makeFakeStorage(), fetchBytes, emit: vi.fn(async () => {}), emitInspectionMedia: vi.fn(async () => {}) });

    expect(r.status).toBe(200); // a bad id is not retryable — never bounce the photo
    expect((r.body as { inspectionLinked?: boolean }).inspectionLinked).toBe(false);
    const docs = await withTenant(tenantId, (tx) => tx.select().from(document).where(eq(document.sitesnapPhotoId, "z3")));
    expect(docs).toHaveLength(1);
  });
});

describe("ingestSiteSnapPhoto — production phase-first capture", () => {
  async function seedProductionJob(key: string) {
    const { ensureProductionPhaseTemplates, instantiateProductionPhases } = await import("@savvy/db");
    const [t] = await adminDb.insert(tenant).values({ name: "PP", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`, settings: { sitesnap: { ingestKey: key } } as never }).returning();
    const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "77 Pulse Ave" }).returning();
    const [j] = await adminDb.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, type: "repair", stage: "production" }).returning();
    await ensureProductionPhaseTemplates(t!.id);
    await instantiateProductionPhases({ tenantId: t!.id, jobId: j!.id });
    return { tenantId: t!.id, jobId: j!.id };
  }

  it("phase-tagged media lands on its phase and emits the production event once", async () => {
    const { productionPhase, productionMedia } = await import("@savvy/db");
    const key = `k-${crypto.randomUUID()}`;
    const { tenantId, jobId } = await seedProductionJob(key);
    const emitProductionMedia = vi.fn(async () => {});

    const r = await ingestSiteSnapPhoto({
      address: "77 Pulse Ave", category: "production", imageUrl: "u", externalPhotoId: "pp1",
      phaseKey: "repair_work", shot: "before", crewMemberName: "Luis",
    }, key, { storage: makeFakeStorage(), fetchBytes, emit: vi.fn(async () => {}), emitProductionMedia });

    expect(r.status).toBe(200);
    expect((r.body as { phaseLinked?: boolean }).phaseLinked).toBe(true);

    const [phase] = await withTenant(tenantId, (tx) => tx.select().from(productionPhase)
      .where(and(eq(productionPhase.jobId, jobId), eq(productionPhase.phaseKey, "repair_work"))));
    expect(phase!.status).toBe("in_progress");
    const media = await withTenant(tenantId, (tx) => tx.select().from(productionMedia).where(eq(productionMedia.jobId, jobId)));
    expect(media).toHaveLength(1);
    expect(media[0]!.shot).toBe("before");
    expect(emitProductionMedia).toHaveBeenCalledTimes(1);
  });

  it("unknown phase context still stores the photo and reports phaseLinked:false (triage)", async () => {
    const key = `k-${crypto.randomUUID()}`;
    const { tenantId } = await seedProductionJob(key);
    const { listTriageMedia } = await import("@savvy/db");

    const r = await ingestSiteSnapPhoto({
      address: "77 Pulse Ave", category: "production", imageUrl: "u", externalPhotoId: "pp2",
      phaseKey: "definitely_not_a_phase",
    }, key, { storage: makeFakeStorage(), fetchBytes, emit: vi.fn(async () => {}), emitProductionMedia: vi.fn(async () => {}) });

    expect(r.status).toBe(200);
    expect((r.body as { phaseLinked?: boolean }).phaseLinked).toBe(false);
    expect(await listTriageMedia(tenantId)).toHaveLength(1);
  });
});
