-- savvy_app is the role the application + isolation test connect as.
-- It is intentionally NOT a superuser and does NOT have BYPASSRLS,
-- so row-level security policies are actually enforced against it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'savvy_app') THEN
    CREATE ROLE savvy_app WITH LOGIN PASSWORD 'savvy_app' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT CONNECT ON DATABASE savvy TO savvy_app;
GRANT USAGE ON SCHEMA public TO savvy_app;
