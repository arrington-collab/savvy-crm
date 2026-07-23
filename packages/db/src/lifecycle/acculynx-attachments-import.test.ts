import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { photoVariantKey } from "@savvy/core";
import { adminDb, tenant } from "../index";
import { customer, property } from "../schema/crm";
import { job } from "../schema/jobs";
import { estimate, invoice } from "../schema/finance";
import { communication } from "../schema/comms";
import { document } from "../schema/ops";
import { importRecord } from "../schema/import-record";
import {
  importAccuLynxAttachments,
  type AttachmentJobBundle,
  type AttachmentDeps,
} from "./acculynx-attachments-import";

let tenantId: string;
let jobId: string;
let customerId: string;
const GUID = "job-guid-1";

function fakeStorage() {
  const puts: string[] = [];
  return {
    puts,
    gateway: {
      async presignUpload() { return { url: "x" }; },
      async presignDownload() { return { url: "x" }; },
      async putObject({ key }: { key: string }) { puts.push(key); },
    },
  };
}

const BUNDLE: AttachmentJobBundle = {
  guid: GUID,
  estimates: [{ Id: "e1", Title: "Roof Estimate", IsPrimary: true, TotalPrice: 9267.22, TotalCost: 6310.34, Sections: [{ i: 1 }] }],
  invoices: [{ InvoiceId: "i1", InvoiceNumber: "4-1", Total: 9267.22, BalanceDue: 0, IsPaid: true, InvoiceWorksheetSections: [{ s: 1 }] }],
  commThreads: [
    { ThreadType: { Name: "Email" }, Messages: [
      { MessageId: "m1", Content: "Sent your estimate", CreatedDate: "2026-02-24T12:00:00Z", Creator: { Name: "Michelle" } },
      { MessageId: "m2", Content: "Thanks!", CreatedDate: "2026-02-24T13:00:00Z", Creator: { Name: "Homeowner" } },
    ] },
  ],
  docFiles: [{ id: "d1", folder: "Insurance Estimate", name: "est.pdf", mime: "application/pdf", size: 1000, relPath: "docs/d1_est.pdf" }],
  photoFiles: [{ fileId: "p1", name: "roof.jpg", tags: ["Damage"], relPath: "photos/p1_roof.jpg" }],
};

beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "Att-Test Co", publicKey: `att-${tenantId.slice(0, 8)}` });
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Rebekah Scott" }).returning({ id: customer.id });
  customerId = c!.id;
  const [p] = await adminDb.insert(property).values({ tenantId, customerId, address: "1 Main St" }).returning({ id: property.id });
  const [j] = await adminDb.insert(job).values({ tenantId, customerId, propertyId: p!.id, stage: "billing" }).returning({ id: job.id });
  jobId = j!.id;
  // ledger the job under its AccuLynx GUID — this is the join the importer uses
  await adminDb.insert(importRecord).values({ tenantId, source: "acculynx", externalId: `job:${GUID}`, entityType: "job", entityId: jobId });
});

afterAll(async () => {
  for (const t of [document, communication, invoice, estimate, importRecord, job, property, customer]) {
    await adminDb.delete(t).where(eq(t.tenantId, tenantId));
  }
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

function deps(over: Partial<AttachmentDeps> = {}): AttachmentDeps {
  const s = fakeStorage();
  return { storage: s.gateway, readFile: () => new Uint8Array([1, 2, 3]), dryRun: false, _puts: s.puts, ...over } as AttachmentDeps & { _puts: string[] };
}

it("dry run writes nothing but reports what it would import", async () => {
  const d = deps({ dryRun: true });
  const r = await importAccuLynxAttachments(tenantId, [BUNDLE], d);
  expect(r).toMatchObject({ estimates: 1, invoices: 1, communications: 2, documents: 1, photos: 1, jobsMatched: 1, jobsUnmatched: 0 });
  const rows = await adminDb.select().from(estimate).where(eq(estimate.tenantId, tenantId));
  expect(rows).toHaveLength(0); // nothing written
  expect((d as unknown as { _puts: string[] })._puts).toHaveLength(0); // no R2 puts
});

it("real run creates rows, uploads binaries, and is idempotent", async () => {
  const d = deps();
  const r = await importAccuLynxAttachments(tenantId, [BUNDLE], d);
  expect(r).toMatchObject({ estimates: 1, invoices: 1, communications: 2, documents: 1, photos: 1 });

  const est = await adminDb.select().from(estimate).where(eq(estimate.tenantId, tenantId));
  expect(est).toHaveLength(1);
  expect(est[0]!.total).toBe(926722);
  expect(est[0]!.jobId).toBe(jobId);
  expect(est[0]!.status).toBe("accepted");

  const inv = await adminDb.select().from(invoice).where(eq(invoice.tenantId, tenantId));
  expect(inv[0]!.status).toBe("paid");
  expect(inv[0]!.jobId).toBe(jobId);

  const comms = await adminDb.select().from(communication).where(eq(communication.tenantId, tenantId));
  expect(comms).toHaveLength(2);
  expect(comms.map((c) => c.channel)).toEqual(["email", "email"]);

  const docs = await adminDb.select().from(document).where(eq(document.tenantId, tenantId));
  expect(docs).toHaveLength(2); // 1 doc + 1 photo
  const photo = docs.find((x) => x.kind === "photo");
  expect(photo?.r2Key).toContain(`acculynx/${tenantId}/${jobId}/photo/p1`);
  expect(docs.find((x) => x.kind === "insurance_estimate")).toBeTruthy();
  expect((d as unknown as { _puts: string[] })._puts).toHaveLength(2); // both binaries uploaded

  // idempotent re-run
  const r2 = await importAccuLynxAttachments(tenantId, [BUNDLE], deps());
  expect(r2).toMatchObject({ estimates: 0, invoices: 0, communications: 0, documents: 0, photos: 0 });
  expect(await adminDb.select().from(estimate).where(eq(estimate.tenantId, tenantId))).toHaveLength(1);
});

it("counts an unmatched job (no ledger entry) without throwing", async () => {
  const r = await importAccuLynxAttachments(tenantId, [{ ...BUNDLE, guid: "ghost-guid" }], deps());
  expect(r.jobsUnmatched).toBe(1);
  expect(r.estimates).toBe(0);
});

it("generates width variants + sets thumbs_ready/mime when a resizer is injected", async () => {
  const s = fakeStorage();
  const widths: number[] = [];
  const bundle: AttachmentJobBundle = {
    ...BUNDLE,
    estimates: [], invoices: [], commThreads: [], docFiles: [],
    photoFiles: [{ fileId: "p2", name: "roof2.jpg", tags: ["Damage"], relPath: "photos/p2_roof2.jpg" }],
  };
  const d = {
    storage: s.gateway,
    readFile: () => new Uint8Array([1, 2, 3]),
    dryRun: false,
    resizeVariant: async (_bytes: Uint8Array, w: number) => { widths.push(w); return new Uint8Array([9, 9]); },
  } as AttachmentDeps;

  await importAccuLynxAttachments(tenantId, [bundle], d);

  // both variant widths were generated
  expect([...widths].sort((a, b) => a - b)).toEqual([192, 1600]);
  // the original + both variant keys were uploaded
  const originalKey = s.puts.find((k) => k.includes("/photo/") && !k.includes("__w"))!;
  expect(s.puts).toContain(photoVariantKey(originalKey, 192));
  expect(s.puts).toContain(photoVariantKey(originalKey, 1600));
  // the row is flagged ready with the correct mime
  const [photo] = await adminDb.select({ thumbsReady: document.thumbsReady, mime: document.mime })
    .from(document).where(and(eq(document.tenantId, tenantId), eq(document.label, "roof2.jpg")));
  expect(photo!.thumbsReady).toBe(true);
  expect(photo!.mime).toBe("image/jpeg");
});
