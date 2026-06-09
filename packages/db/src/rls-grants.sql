-- Run AFTER migrations. savvy_app can DML all tables but RLS still filters rows.
GRANT USAGE ON SCHEMA public TO savvy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO savvy_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO savvy_app;
-- Future tables created by later migrations inherit these grants:
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO savvy_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO savvy_app;
