import { and, eq } from "drizzle-orm";
import {
  mapEstimate, mapInvoice, mapCommChannel, mapDocKind, attachmentR2Key, htmlToText,
  photoVariantKey, PHOTO_VARIANT_WIDTHS,
} from "@savvy/core";
import { withTenant, type Tx } from "../tenant";

/** Minimal storage surface this importer needs — structurally satisfied by
 *  integrations' r2Storage. Kept inline so the db package need not depend on
 *  the whole integrations client. */
export interface AttachmentStorage {
  putObject(o: { key: string; bytes: Uint8Array; contentType: string }): Promise<void>;
}
import { job } from "../schema/jobs";
import { lead } from "../schema/crm";
import { estimate, invoice } from "../schema/finance";
import { communication } from "../schema/comms";
import { document } from "../schema/ops";
import { importRecord } from "../schema/import-record";

// Alta cutover, phase 2 — attach the exported AccuLynx history (estimates,
// invoices, comms, documents, photos) to the jobs/leads the first importer
// already created. Every AccuLynx GUID was ledgered as `job:<guid>` or
// `lead:<guid>`; this importer resolves that link, then materializes each
// attachment idempotently through the same import_record ledger (so re-runs
// are safe and a session-interrupted run resumes cleanly). Binaries stream to
// R2 via the injected storage gateway; the caller supplies file bytes so the
// lifecycle stays filesystem-free and unit-testable.

const SOURCE = "acculynx";

export interface AttachmentJobBundle {
  guid: string;
  estimates: Record<string, unknown>[];
  invoices: Record<string, unknown>[];
  commThreads: { ThreadType?: { Name?: string }; Messages?: Record<string, unknown>[] }[];
  docFiles: { id: string; folder: string; name: string; mime?: string; size?: number; relPath: string }[];
  photoFiles: { fileId: string; name: string; tags?: string[]; created?: string; relPath: string }[];
}

export interface AttachmentDeps {
  storage: AttachmentStorage;
  /** Read a binary by its export-relative path (e.g. "photos/p1_roof.jpg").
   *  Return null when the file is missing (counted, not fatal). */
  readFile: (guid: string, relPath: string) => Uint8Array | null;
  dryRun: boolean;
  /** Optional per-job progress hook (index is 1-based) — lets a long CLI run
   *  print a heartbeat instead of going silent for many minutes. */
  onProgress?: (done: number, total: number, guid: string) => void;
  /** Optional resizer (sharp lives in the CLI runner, not this package, so the
   *  native binary never reaches the app bundle). When provided, each imported
   *  photo gets its PHOTO_VARIANT_WIDTHS variants generated + stored and the row
   *  is marked thumbs_ready — the view route then streams them with no runtime
   *  resize. When omitted, photos import unflagged (a later backfill fills them). */
  resizeVariant?: (bytes: Uint8Array, width: number) => Promise<Uint8Array>;
}

export interface AttachmentResult {
  jobsMatched: number;
  jobsUnmatched: number;
  estimates: number;
  invoices: number;
  communications: number;
  documents: number;
  photos: number;
  filesMissing: number;
}

async function ledgered(tx: Tx, tenantId: string, externalId: string): Promise<boolean> {
  const [row] = await tx.select({ id: importRecord.entityId }).from(importRecord)
    .where(and(eq(importRecord.tenantId, tenantId), eq(importRecord.source, SOURCE), eq(importRecord.externalId, externalId)));
  return !!row;
}

async function ledger(tx: Tx, tenantId: string, externalId: string, entityType: string, entityId: string): Promise<void> {
  await tx.insert(importRecord).values({ tenantId, source: SOURCE, externalId, entityType, entityId }).onConflictDoNothing();
}

/** Resolve the Savvy entity an AccuLynx GUID became: a job (with its customer)
 *  or a lead. Returns null when the GUID was never imported. */
async function resolveEntity(
  tx: Tx, tenantId: string, guid: string,
): Promise<{ jobId: string | null; leadId: string | null; customerId: string | null } | null> {
  const [jobRec] = await tx.select({ id: importRecord.entityId }).from(importRecord)
    .where(and(eq(importRecord.tenantId, tenantId), eq(importRecord.source, SOURCE), eq(importRecord.externalId, `job:${guid}`)));
  if (jobRec) {
    const [j] = await tx.select({ id: job.id, customerId: job.customerId }).from(job).where(eq(job.id, jobRec.id));
    return j ? { jobId: j.id, leadId: null, customerId: j.customerId } : null;
  }
  const [leadRec] = await tx.select({ id: importRecord.entityId }).from(importRecord)
    .where(and(eq(importRecord.tenantId, tenantId), eq(importRecord.source, SOURCE), eq(importRecord.externalId, `lead:${guid}`)));
  if (leadRec) {
    const [l] = await tx.select({ id: lead.id, customerId: lead.customerId }).from(lead).where(eq(lead.id, leadRec.id));
    return l ? { jobId: null, leadId: l.id, customerId: l.customerId } : null;
  }
  return null;
}

export async function importAccuLynxAttachments(
  tenantId: string, bundles: AttachmentJobBundle[], deps: AttachmentDeps,
): Promise<AttachmentResult> {
  const r: AttachmentResult = {
    jobsMatched: 0, jobsUnmatched: 0, estimates: 0, invoices: 0,
    communications: 0, documents: 0, photos: 0, filesMissing: 0,
  };

  // One transaction PER JOB, not one for the whole run: a 2000+-file import
  // interleaves slow R2 uploads with DB writes, so a single transaction would
  // stay open for many minutes (idle-in-transaction risk) and a mid-run failure
  // would roll back everything. Per-job commits make the ledger durable after
  // each job — a killed or timed-out run resumes cleanly, skipping finished jobs.
  let done = 0;
  for (const b of bundles) {
    await withTenant(tenantId, async (tx) => {
      const ent = await resolveEntity(tx, tenantId, b.guid);
      if (!ent) { r.jobsUnmatched += 1; return; }
      r.jobsMatched += 1;
      const { jobId, leadId, customerId } = ent;

      for (const raw of b.estimates) {
        const m = mapEstimate(raw);
        if (await ledgered(tx, tenantId, m.externalId)) continue;
        r.estimates += 1;
        if (deps.dryRun) continue;
        const [row] = await tx.insert(estimate).values({
          tenantId, jobId, leadId, source: m.source, status: m.status,
          lineItems: m.lineItems, subtotal: m.subtotal, tax: m.tax, total: m.total,
        }).returning({ id: estimate.id });
        await ledger(tx, tenantId, m.externalId, "estimate", row!.id);
      }

      // Invoices require a job (Savvy invoice.job_id is NOT NULL); AccuLynx only
      // ever invoices job-stage records, so a lead-only GUID simply has none.
      if (jobId) {
        for (const raw of b.invoices) {
          const m = mapInvoice(raw);
          if (await ledgered(tx, tenantId, m.externalId)) continue;
          r.invoices += 1;
          if (deps.dryRun) continue;
          const [row] = await tx.insert(invoice).values({
            tenantId, jobId, customerId, number: m.number, status: m.status,
            lineItems: m.lineItems, amountDue: m.amountDue, amountPaid: m.amountPaid ?? 0, dueAt: m.dueAt,
          }).returning({ id: invoice.id });
          await ledger(tx, tenantId, m.externalId, "invoice", row!.id);
        }
      }

      for (const thread of b.commThreads) {
        const channel = mapCommChannel(thread.ThreadType?.Name);
        for (const msg of thread.Messages ?? []) {
          const msgId = msg.MessageId as string | undefined;
          if (!msgId) continue;
          const externalId = `comm:${msgId}`;
          if (await ledgered(tx, tenantId, externalId)) continue;
          r.communications += 1;
          if (deps.dryRun) continue;
          const creator = (msg.Creator as { Name?: string } | undefined)?.Name ?? null;
          const [row] = await tx.insert(communication).values({
            tenantId, jobId, customerId, channel, direction: "outbound",
            from: creator, body: htmlToText(msg.Content as string) || null,
            createdAt: msg.CreatedDate ? new Date(msg.CreatedDate as string) : undefined,
          }).returning({ id: communication.id });
          await ledger(tx, tenantId, externalId, "communication", row!.id);
        }
      }

      const scopeId = jobId ?? leadId!;
      for (const doc of b.docFiles) {
        const externalId = `doc:${doc.id}`;
        if (await ledgered(tx, tenantId, externalId)) continue;
        const kind = mapDocKind(doc.folder, doc.name);
        const bytes = deps.readFile(b.guid, doc.relPath);
        if (!bytes) { r.filesMissing += 1; continue; }
        r.documents += 1;
        if (deps.dryRun) continue;
        const key = attachmentR2Key(tenantId, scopeId, kind, doc.id, doc.name);
        await deps.storage.putObject({ key, bytes, contentType: doc.mime || "application/octet-stream" });
        const [row] = await tx.insert(document).values({
          tenantId, jobId, leadId, kind, label: doc.name, r2Key: key,
          filename: doc.name, mime: doc.mime ?? null, sizeBytes: doc.size ?? bytes.length, source: SOURCE,
        }).returning({ id: document.id });
        await ledger(tx, tenantId, externalId, "document", row!.id);
      }

      for (const ph of b.photoFiles) {
        const externalId = `photo:${ph.fileId}`;
        if (await ledgered(tx, tenantId, externalId)) continue;
        const bytes = deps.readFile(b.guid, ph.relPath);
        if (!bytes) { r.filesMissing += 1; continue; }
        r.photos += 1;
        if (deps.dryRun) continue;
        const key = attachmentR2Key(tenantId, scopeId, "photo", ph.fileId, ph.name);
        await deps.storage.putObject({ key, bytes, contentType: "image/jpeg" });
        // Pre-generate the width variants when a resizer is injected, so the grid
        // + gallery stream ready-made bytes (no runtime resize). Best-effort — a
        // resize failure imports the photo unflagged (backfill catches it later).
        let thumbsReady = false;
        if (deps.resizeVariant) {
          try {
            for (const w of PHOTO_VARIANT_WIDTHS) {
              const out = await deps.resizeVariant(bytes, w);
              await deps.storage.putObject({ key: photoVariantKey(key, w), bytes: out, contentType: "image/jpeg" });
            }
            thumbsReady = true;
          } catch { thumbsReady = false; }
        }
        const [row] = await tx.insert(document).values({
          tenantId, jobId, leadId, kind: "photo", label: ph.name, r2Key: key,
          filename: ph.name, mime: "image/jpeg", sizeBytes: bytes.length, source: SOURCE, thumbsReady,
        }).returning({ id: document.id });
        await ledger(tx, tenantId, externalId, "document", row!.id);
      }
    });
    deps.onProgress?.(++done, bundles.length, b.guid);
  }

  return r;
}
