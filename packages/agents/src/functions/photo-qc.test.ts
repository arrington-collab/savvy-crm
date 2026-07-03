import { describe, it, expect } from "vitest";
import { adminDb, tenant, customer, property, job, document, withTenant, eq } from "@savvy/db";
import { Jimp, JimpMime } from "jimp";
import type { PhotoQcVision } from "@savvy/core";
import { runPhotoQc } from "./photo-qc";

/** Generate a tiny deterministic 9×8 white PNG so jimp decode is predictable. */
async function makeTinyPng(): Promise<Uint8Array> {
  const img = new Jimp({ width: 9, height: 8, color: 0xffffffff });
  const buf = await img.getBuffer(JimpMime.png);
  return new Uint8Array(buf);
}

/** A solid-white 9×8 image: every row has uniform pixel values,
 *  so all left > right comparisons are false → 64 zero bits → "0000000000000000". */
const WHITE_PHASH = "0000000000000000";

/** Stub classify that returns a "passing" vision result. */
const passClassify = async (_bytes: Uint8Array, _label: string | null): Promise<PhotoQcVision> => ({
  usable: true,
  quality: "ok",
  depictsCategory: true,
  reason: "fine",
});

async function seed() {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "QC", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` })
    .returning();
  const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
  const [p] = await adminDb
    .insert(property)
    .values({ tenantId: t!.id, customerId: c!.id, address: "1 A St" })
    .returning();
  const [j] = await adminDb
    .insert(job)
    .values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" })
    .returning();
  return { tenantId: t!.id, jobId: j!.id };
}

/** Insert a photo document directly into the DB. */
async function seedPhoto(
  tenantId: string,
  jobId: string,
  overrides: Partial<typeof document.$inferInsert> = {},
) {
  const [doc] = await adminDb
    .insert(document)
    .values({
      tenantId,
      jobId,
      kind: "photo",
      source: "sitesnap",
      label: "ridge",
      r2Key: `test/${crypto.randomUUID()}.jpg`,
      qcStatus: "pending",
      sitesnapPhotoId: `ss-${crypto.randomUUID()}`,
      ...overrides,
    })
    .returning();
  return doc!;
}

describe("runPhotoQc", () => {
  it("usable + on-category + no dup → qcStatus: passed, phash written", async () => {
    const { tenantId, jobId } = await seed();
    const doc = await seedPhoto(tenantId, jobId);
    const bytes = await makeTinyPng();

    const result = await runPhotoQc({
      tenantId,
      documentId: doc.id,
      jobId,
      fetchBytes: async () => bytes,
      classify: passClassify,
      cfg: { dupeMaxDistance: 10 },
    });

    expect(result.qcStatus).toBe("passed");
    expect(result.phash).toBe(WHITE_PHASH);

    // Verify the DB was updated
    const [updated] = await withTenant(tenantId, (tx) =>
      tx.select({ phash: document.phash, qcStatus: document.qcStatus })
        .from(document)
        .where(eq(document.id, doc.id)),
    );
    expect(updated?.phash).toBe(WHITE_PHASH);
    expect(updated?.qcStatus).toBe("passed");
  });

  it("classify returns usable:false → qcStatus: flagged, reasons.quality set", async () => {
    const { tenantId, jobId } = await seed();
    const doc = await seedPhoto(tenantId, jobId);
    const bytes = await makeTinyPng();

    const result = await runPhotoQc({
      tenantId,
      documentId: doc.id,
      jobId,
      fetchBytes: async () => bytes,
      classify: async () => ({
        usable: false,
        quality: "blurry",
        depictsCategory: true,
        reason: "image is blurry",
      }),
      cfg: { dupeMaxDistance: 10 },
    });

    expect(result.qcStatus).toBe("flagged");
    expect((result.reasons as { quality?: string }).quality).toBe("blurry");
  });

  it("photo whose dHash matches a seeded hash → flagged with reasons.duplicateOf", async () => {
    const { tenantId, jobId } = await seed();
    // Seed a sibling photo with phash = WHITE_PHASH (same as our fixture will produce)
    const sibling = await seedPhoto(tenantId, jobId, { phash: WHITE_PHASH });
    const docToQc = await seedPhoto(tenantId, jobId);
    const bytes = await makeTinyPng();

    const result = await runPhotoQc({
      tenantId,
      documentId: docToQc.id,
      jobId,
      fetchBytes: async () => bytes,
      classify: passClassify,
      cfg: { dupeMaxDistance: 10 },
    });

    expect(result.qcStatus).toBe("flagged");
    expect((result.reasons as { duplicateOf?: string }).duplicateOf).toBe(sibling.id);
  });

  it("fetchBytes throws → qcStatus: skipped (fail-soft), no throw", async () => {
    const { tenantId, jobId } = await seed();
    const doc = await seedPhoto(tenantId, jobId);

    const result = await runPhotoQc({
      tenantId,
      documentId: doc.id,
      jobId,
      fetchBytes: async () => { throw new Error("network fail"); },
      classify: passClassify,
      cfg: { dupeMaxDistance: 10 },
    });

    expect(result.qcStatus).toBe("skipped");

    // DB should reflect skipped
    const [updated] = await withTenant(tenantId, (tx) =>
      tx.select({ qcStatus: document.qcStatus }).from(document).where(eq(document.id, doc.id)),
    );
    expect(updated?.qcStatus).toBe("skipped");
  });
});
