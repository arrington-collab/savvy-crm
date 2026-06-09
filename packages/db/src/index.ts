export { db, pool, schema } from "./client.js";
export { adminDb, adminPool } from "./admin-client.js";
export { withTenant } from "./tenant.js";
export * as tables from "./schema/index.js";
// Named table/enum exports on the package root so cross-package consumers
// (the Next.js app, agents) import `{ tenant, job }` from "@savvy/db" instead
// of deep `/src/schema/...js` paths that webpack can't resolve to .ts files.
export * from "./schema/index.js";
// Re-export the query operators consumers need, so app code uses THIS package's
// single drizzle-orm instance (avoids duplicate-instance type mismatches where
// the app's own `eq` doesn't match @savvy/db's columns).
export { eq, and, or, not, sql, count, desc, asc, inArray, isNull } from "drizzle-orm";
