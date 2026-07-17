// Alta cutover — one-shot AccuLynx import runner.
//
//   DATABASE_URL=... tsx src/scripts/import-acculynx.ts <tenantId> <jobs.json> <contacts.csv>
//
// The data files live OUTSIDE the repo (real customer PII — never committed);
// this runner just parses them and hands structured records to the tested
// importAccuLynxData lifecycle. Idempotent: re-running skips everything
// already in the import_record ledger.

import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { parseAccuLynxContactsCsv } from "@savvy/core";
import { adminDb } from "../admin-client";
import { tenant } from "../schema/tenancy";
import { importAccuLynxData, type AccuLynxJobRecord } from "../lifecycle/acculynx-import";

async function main() {
  const [tenantId, jobsPath, contactsPath] = process.argv.slice(2);
  if (!tenantId || !jobsPath || !contactsPath) {
    console.error("usage: tsx src/scripts/import-acculynx.ts <tenantId> <jobs.json> <contacts.csv>");
    process.exit(1);
  }

  const [t] = await adminDb.select({ id: tenant.id, name: tenant.name }).from(tenant).where(eq(tenant.id, tenantId));
  if (!t) { console.error(`tenant ${tenantId} not found`); process.exit(1); }

  const jobs = JSON.parse(readFileSync(jobsPath, "utf8")) as AccuLynxJobRecord[];
  const contacts = parseAccuLynxContactsCsv(readFileSync(contactsPath, "utf8"));
  console.log(`importing into "${t.name}": ${jobs.length} job records, ${contacts.length} contacts`);

  const res = await importAccuLynxData(tenantId, { jobs, contacts });
  console.log("created:", res);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
