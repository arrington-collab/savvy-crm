import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // superuser connection — drizzle-kit runs DDL incl. CREATE POLICY
    url: process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/savvy",
  },
});
