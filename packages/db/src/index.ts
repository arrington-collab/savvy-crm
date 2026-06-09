export { db, pool, schema } from "./client.js";
export { adminDb, adminPool } from "./admin-client.js";
export { withTenant } from "./tenant.js";
export * as tables from "./schema/index.js";
