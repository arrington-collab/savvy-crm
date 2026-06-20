-- prod-bootstrap.sql — ONE-TIME production database setup (Neon, or any managed Postgres).
--
-- WHY THIS EXISTS:
--   Locally, Docker runs docker/initdb/01-roles.sql automatically to create the
--   non-superuser `savvy_app` role. Managed Postgres (Neon) does NOT run init
--   scripts, so we run this by hand once against a new database.
--
--   RLS only enforces against a NON-superuser, NON-BYPASSRLS role. The app MUST
--   connect as `savvy_app` (DATABASE_URL); migrations/seed connect as the
--   database owner (DATABASE_ADMIN_URL). If the app connected as the owner,
--   tenant isolation would silently break.
--
-- HOW TO RUN (as the database OWNER, before the first `pnpm db:migrate`):
--   psql "$DATABASE_ADMIN_URL" -f scripts/prod-bootstrap.sql
--   -- then set a strong password (see the ALTER ROLE line below).
--
-- NOTE ON TABLE GRANTS: this file only creates the role + connect/usage grants.
-- The per-table SELECT/INSERT/UPDATE/DELETE grants (and ALTER DEFAULT PRIVILEGES
-- for future tables) live in packages/db/src/rls-grants.sql, which `pnpm db:migrate`
-- re-applies on every run. So the correct order is:
--   1. run THIS file (creates savvy_app)        <- once
--   2. run `pnpm db:migrate` (creates tables + applies rls-grants.sql)  <- every deploy

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'savvy_app') THEN
    -- Placeholder password; OVERRIDE immediately with the ALTER ROLE below.
    CREATE ROLE savvy_app WITH LOGIN PASSWORD 'CHANGE_ME' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

-- Set a strong, unique password and put the SAME value in DATABASE_URL on Vercel.
-- (Run this line manually with your generated secret; do NOT commit the real value.)
--   ALTER ROLE savvy_app WITH PASSWORD '<strong-generated-password>';

-- Neon: the database is typically named `neondb` unless you created another.
-- Replace `savvy` below with your actual database name if different.
GRANT CONNECT ON DATABASE savvy TO savvy_app;
GRANT USAGE ON SCHEMA public TO savvy_app;
