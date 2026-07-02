import { adminDb, adminPool } from "./admin-client";
import { seedTaskRegistry } from "../seeds/master-task-list";

/**
 * Registry-ONLY seed. Safe to run against prod: task_registry is a global,
 * versioned source table and the upsert is idempotent. Unlike the full db:seed,
 * this creates NO tenants or demo data. Run with DATABASE_ADMIN_URL pointed at
 * the target DB.
 */
async function main() {
  const n = await seedTaskRegistry(adminDb);
  console.log(`task_registry seeded/updated: ${n} tasks`);
  await adminPool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
