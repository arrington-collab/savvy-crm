/**
 * Backfill: stamp IMPLIED consent (business-relationship basis) for the
 * EXISTING customer base. Task 5 Day-3-Slice-A closed the drip.ts consent
 * bypass by routing all proactive SMS through guardedSms, which requires
 * customer.sms_consent_at to be set (see packages/agents/src/comms-gateway.ts
 * / @savvy/core evaluateGuard). Customers created before that change — or
 * via a non-web path that didn't stamp consent — have phone + no opt-out but
 * no sms_consent_at, so they'd now be silently blocked from every SMS touch
 * (lead-cadence, drip, appointment reminders, lead-intake ack) despite being
 * an active, already-consented business relationship.
 *
 * Brett's call (Day 3 Slice A review): treat this existing base as IMPLIED
 * consent — stamp sms_consent_at now (backdated to created_at, so it reads
 * as "consent existed since the relationship began" rather than "just now"),
 * send the texts, formalize express consent later. This is the same shape as
 * the new-path fix in acculynx-import.ts / cert-request.ts / move-play.ts,
 * just applied retroactively to rows that predate it.
 *
 * Idempotent: only touches rows where sms_consent_at IS NULL (COALESCE is a
 * no-op if already set), so re-running changes 0 additional rows.
 *
 * THIS IS A DEPLOY-TIME PROD OP, NOT RUN BY TESTS. Run it once per tenant (or
 * across all tenants) when SMS goes live for that tenant/environment. Do NOT
 * run it against prod from this session — local verification / --dry-run
 * only; a human runs the real prod backfill deliberately, against a real
 * DATABASE_ADMIN_URL, outside of an agent session.
 *
 * Usage (local):
 *   pnpm --filter @savvy/db exec tsx src/scripts/backfill-implied-consent.ts --dry-run
 *   pnpm --filter @savvy/db exec tsx src/scripts/backfill-implied-consent.ts --dry-run --tenant=<tenantId>
 *   pnpm --filter @savvy/db exec tsx src/scripts/backfill-implied-consent.ts             (all tenants, applies)
 *   pnpm --filter @savvy/db exec tsx src/scripts/backfill-implied-consent.ts --tenant=<tenantId>
 */
import { adminPool } from "../admin-client";

const SELECT_ALL = `
  select count(*)::int as n
    from customer
   where phone is not null and sms_opt_out = false and sms_consent_at is null`;

const SELECT_TENANT = `
  select count(*)::int as n
    from customer
   where tenant_id = $1 and phone is not null and sms_opt_out = false and sms_consent_at is null`;

const UPDATE_ALL = `
  update customer
     set sms_consent_at = coalesce(sms_consent_at, created_at)
   where phone is not null and sms_opt_out = false and sms_consent_at is null`;

const UPDATE_TENANT = `
  update customer
     set sms_consent_at = coalesce(sms_consent_at, created_at)
   where tenant_id = $1 and phone is not null and sms_opt_out = false and sms_consent_at is null`;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const tenantArg = process.argv.find((a) => a.startsWith("--tenant="));
  const tenantId = tenantArg ? tenantArg.slice("--tenant=".length) : null;

  const scope = tenantId ? `tenant ${tenantId}` : "ALL tenants";
  const { rows } = tenantId
    ? await adminPool.query(SELECT_TENANT, [tenantId])
    : await adminPool.query(SELECT_ALL);
  const n = rows[0]?.n ?? 0;
  console.log(`backfill-implied-consent: ${scope} — ${n} customer row(s) eligible (phone set, not opted out, no consent stamp)`);

  if (dryRun) {
    console.log("dry-run: no changes written");
  } else {
    const res = tenantId
      ? await adminPool.query(UPDATE_TENANT, [tenantId])
      : await adminPool.query(UPDATE_ALL);
    console.log(`stamped implied sms_consent_at on ${res.rowCount} customer row(s)`);
  }
  await adminPool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
