// Alta cutover fix — clean the HTML out of already-imported AccuLynx comm rows.
// The first attachment import stored msg.Content verbatim, so full HTML email
// bodies (EagleView orders, <br>-lists) landed in the comm timeline unreadable.
// This re-flattens each imported communication's body with htmlToText in place.
// Idempotent: htmlToText on already-clean text is a no-op, so re-runs change 0.
//
//   DATABASE_URL=... tsx src/scripts/backfill-acculynx-comm-text.ts <tenantId>

import { and, eq } from "drizzle-orm";
import { htmlToText } from "@savvy/core";
import { adminDb } from "../admin-client";
import { tenant } from "../schema/tenancy";
import { communication } from "../schema/comms";
import { importRecord } from "../schema/import-record";

async function main() {
  const tenantId = process.argv[2];
  if (!tenantId) { console.error("usage: tsx backfill-acculynx-comm-text.ts <tenantId>"); process.exit(1); }
  const [t] = await adminDb.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, tenantId));
  if (!t) { console.error(`tenant ${tenantId} not found`); process.exit(1); }

  // Only the communication rows this importer created (via the ledger).
  const rows = await adminDb
    .select({ id: communication.id, body: communication.body })
    .from(communication)
    .innerJoin(importRecord, and(
      eq(importRecord.entityId, communication.id),
      eq(importRecord.tenantId, communication.tenantId),
      eq(importRecord.source, "acculynx"),
      eq(importRecord.entityType, "communication"),
    ))
    .where(eq(communication.tenantId, tenantId));

  console.log(`"${t.name}": ${rows.length} imported comm rows`);
  let changed = 0;
  for (const r of rows) {
    const cleaned = htmlToText(r.body) || null;
    if (cleaned !== r.body) {
      await adminDb.update(communication).set({ body: cleaned }).where(eq(communication.id, r.id));
      changed += 1;
    }
  }
  console.log(`cleaned ${changed} row(s); ${rows.length - changed} already plain text`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
