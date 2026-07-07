/**
 * Backfill: leads that were converted to a job but left in a non-terminal status (the
 * convertLeadToJob bug wrote status='booked', never 'won') are marked 'won'. Idempotent —
 * safe to re-run; only touches leads referenced by a job whose status is not already
 * won/lost. Data-only (no schema change).
 *
 * Usage (local):  pnpm --filter @savvy/db exec tsx src/scripts/backfill-won-leads.ts [--dry-run]
 * Usage (prod):   DATABASE_ADMIN_URL="<prod-admin-url>" pnpm --filter @savvy/db exec tsx src/scripts/backfill-won-leads.ts --dry-run
 *                 (then re-run without --dry-run to apply)
 */
import { adminPool } from "../admin-client";

const SELECT = `
  select l.id, l.tenant_id, l.status
    from lead l
    join job j on j.tenant_id = l.tenant_id and j.lead_id = l.id
   where l.status not in ('won', 'lost')
   order by l.tenant_id, l.id`;

const UPDATE = `
  update lead l set status = 'won'
    from job j
   where j.tenant_id = l.tenant_id and j.lead_id = l.id
     and l.status not in ('won', 'lost')`;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const { rows } = await adminPool.query(SELECT);
  console.log(`${rows.length} job-referenced lead(s) not yet won/lost`);
  for (const r of rows) {
    console.log(`  lead ${r.id} (tenant ${r.tenant_id}) status=${r.status} -> won`);
  }
  if (dryRun) {
    console.log("dry-run: no changes written");
  } else {
    const res = await adminPool.query(UPDATE);
    console.log(`updated ${res.rowCount} lead(s) to won`);
  }
  await adminPool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
