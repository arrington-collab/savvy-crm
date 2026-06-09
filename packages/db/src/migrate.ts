import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { adminDb, adminPool } from "./admin-client.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  await migrate(adminDb, { migrationsFolder: join(here, "..", "drizzle") });
  const grants = readFileSync(join(here, "rls-grants.sql"), "utf8");
  await adminPool.query(grants);
  console.log("migrations + grants applied");
  await adminPool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
