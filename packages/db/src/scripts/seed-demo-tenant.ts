import { adminPool } from "../admin-client";
import { provisionDemoTenant } from "../lifecycle/demo-seed/config";

async function main() {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");
  console.log(reset ? "RESET demo tenant" : "SEED demo tenant");
  const { tenantId } = await provisionDemoTenant();
  console.log(`demo tenant ${tenantId} provisioned (${process.env.DATABASE_URL?.split("@")[1] ?? "local"})`);
  // Reset + full dataset + sweep are wired in later tasks (8–13).
}

main().then(async () => { await adminPool.end(); process.exit(0); })
  .catch(async (e) => { console.error(e); await adminPool.end().catch(() => {}); process.exit(1); });
