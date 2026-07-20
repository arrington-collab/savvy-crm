// Backfill parsing for documents that were created without ever entering the
// parse pipeline (e.g. bulk-imported AccuLynx insurance estimates + measurement
// reports, which the importer inserted as `pending`). Emits one
// `lead-document/received` per pending parseable doc; the deployed
// parse-lead-document function picks them up and extracts the claim / measurement.
// Idempotent: the parse handler coalesce-guards claims and upserts measurements,
// so re-running never duplicates. Skips docs already `parsed`.
//
//   INNGEST_EVENT_KEY=… DATABASE_ADMIN_URL=… tsx src/scripts/backfill-parse-pending.ts <tenantId>

import { and, eq, inArray, adminDb, document } from "@savvy/db";
import { PARSEABLE_KINDS } from "@savvy/core";
import { inngest } from "../client";

async function main() {
  const tenantId = process.argv[2];
  if (!tenantId) { console.error("usage: tsx src/scripts/backfill-parse-pending.ts <tenantId>"); process.exit(1); }

  const rows = await adminDb
    .select({ id: document.id, kind: document.kind, leadId: document.leadId, jobId: document.jobId })
    .from(document)
    .where(and(
      eq(document.tenantId, tenantId),
      inArray(document.kind, PARSEABLE_KINDS as unknown as string[]),
      eq(document.parseStatus, "pending"),
    ));

  console.log(`${rows.length} pending parseable docs for tenant ${tenantId}`);
  const byKind: Record<string, number> = {};
  let sent = 0;
  for (const d of rows) {
    const scopeId = d.leadId ?? d.jobId;
    if (!scopeId) continue; // orphan — nothing to attach to
    await inngest.send({
      name: "lead-document/received",
      data: { tenantId, documentId: d.id, leadId: d.leadId, jobId: d.jobId, kind: d.kind, scopeId },
    });
    byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
    sent += 1;
  }
  console.log(`emitted ${sent} parse events:`, byKind);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
