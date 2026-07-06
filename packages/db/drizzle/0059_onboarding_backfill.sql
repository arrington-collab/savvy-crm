-- P0 lockout backfill (2026-07-06). When the (app) layout onboarding gate shipped,
-- pre-existing tenants were never given settings.onboarding.requiredCompletedAt, so
-- the gate treated live customers as un-onboarded and redirected EVERY route to
-- /onboarding (a full lockout). Mark required onboarding complete for every tenant
-- that has real work (>=1 job OR >=1 lead) and currently has a null flag. Genuinely
-- empty tenants keep the null flag and stay gated — that is correct, they are still
-- onboarding.
--
-- Idempotent: the "requiredCompletedAt IS NULL" predicate makes a re-run a no-op,
-- and the drizzle migrator applies this migration once. Only the {onboarding}
-- sub-object is rewritten (merging requiredCompletedAt into any existing onboarding
-- keys such as `dismissed`), so sibling settings keys (finance, scheduling, esign)
-- are preserved. The timestamp is UTC ISO-8601 via to_jsonb(now()) — the same shape
-- the app writer produces with new Date().toISOString(). It is a completion INSTANT,
-- not a wall-clock time, so no per-tenant timezone applies.
UPDATE "tenant" t
SET "settings" = jsonb_set(
  coalesce(t."settings", '{}'::jsonb),
  '{onboarding}',
  coalesce(t."settings" -> 'onboarding', '{}'::jsonb)
    || jsonb_build_object('requiredCompletedAt', to_jsonb(now())),
  true
)
WHERE (t."settings" #>> '{onboarding,requiredCompletedAt}') IS NULL
  AND (
    EXISTS (SELECT 1 FROM "job" j WHERE j."tenant_id" = t."id")
    OR EXISTS (SELECT 1 FROM "lead" l WHERE l."tenant_id" = t."id")
  );
