import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTenant } from "../src/tenant.js";
import { document } from "../src/schema/ops.js";
import { setDocumentNote, listJobPhotoNotes } from "../src/lifecycle/document-notes.js";
import { makeTenant, makeJobWithCustomer } from "./helpers.js";

async function makePhoto(tenantId: string, jobId: string): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const [r] = await tx.insert(document).values({
      tenantId, jobId, kind: "photo", r2Key: `${tenantId}/${jobId}/p.jpg`, source: "savvy",
    }).returning();
    return r!.id;
  });
}

async function readNote(tenantId: string, documentId: string): Promise<string | null> {
  return withTenant(tenantId, async (tx) => {
    const [r] = await tx.select({ notes: document.notes }).from(document).where(eq(document.id, documentId));
    return r!.notes;
  });
}

describe("setDocumentNote — per-photo free-form note", () => {
  it("persists a note on a photo", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(tenantId);
    const docId = await makePhoto(tenantId, jobId);

    const ok = await setDocumentNote(tenantId, { documentId: docId, notes: "  gutters dented, north side  " });
    expect(ok).toBe(true);
    expect(await readNote(tenantId, docId)).toBe("gutters dented, north side"); // trimmed
  });

  it("clears the note when given an empty/whitespace string (stored as null)", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(tenantId);
    const docId = await makePhoto(tenantId, jobId);
    await setDocumentNote(tenantId, { documentId: docId, notes: "x" });

    expect(await setDocumentNote(tenantId, { documentId: docId, notes: "   " })).toBe(true);
    expect(await readNote(tenantId, docId)).toBeNull();
  });

  it("returns false for a document not in the tenant", async () => {
    const { tenantId } = await makeTenant();
    expect(await setDocumentNote(tenantId, { documentId: "00000000-0000-0000-0000-000000000000", notes: "hi" })).toBe(false);
  });
});

describe("listJobPhotoNotes — the job's photo notes for AI upsell drafting", () => {
  it("returns only non-empty notes on photo docs for the job", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(tenantId);

    const withNote = await makePhoto(tenantId, jobId);
    await setDocumentNote(tenantId, { documentId: withNote, notes: "gutters dented north side" });
    await makePhoto(tenantId, jobId); // photo, no note → excluded
    // a non-photo doc with a note → excluded
    await withTenant(tenantId, (tx) =>
      tx.insert(document).values({ tenantId, jobId, kind: "contract", notes: "should be ignored", r2Key: `${tenantId}/${jobId}/c.pdf` }),
    );

    expect(await listJobPhotoNotes(tenantId, jobId)).toEqual(["gutters dented north side"]);
  });

  it("returns [] for a job with no photo notes", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(tenantId);
    await makePhoto(tenantId, jobId);
    expect(await listJobPhotoNotes(tenantId, jobId)).toEqual([]);
  });
});
