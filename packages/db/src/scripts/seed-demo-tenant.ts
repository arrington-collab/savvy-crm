import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client";
import { tenant } from "../schema/tenancy";
import { DEMO_CLERK_ORG_ID } from "../lifecycle/demo-seed/config";
import { seedDemoTenant, resetDemoTenant } from "../lifecycle/demo-seed/reset";

/** Resolves the real singleton demo tenant by its fixed clerkOrgId. Refuses
 * (throws) if a tenant with that org id exists but isn't flagged demo=true —
 * this CLI must never seed/reset a real customer's data. */
async function resolveDemoTenantId(): Promise<string | null> {
  const [t] = await adminDb
    .select({ id: tenant.id, demo: tenant.demo })
    .from(tenant)
    .where(eq(tenant.clerkOrgId, DEMO_CLERK_ORG_ID));
  if (!t) return null;
  if (t.demo !== true) {
    throw new Error(`refusing: tenant resolved by clerkOrgId=${DEMO_CLERK_ORG_ID} exists but is NOT flagged demo=true`);
  }
  return t.id;
}

async function main() {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");
  const hard = args.includes("--hard");

  if (reset) {
    console.log("RESET demo tenant" + (hard ? " (hard)" : ""));
    const tenantId = await resolveDemoTenantId();
    if (!tenantId) {
      console.log("no demo tenant found — nothing to reset");
      return;
    }
    await resetDemoTenant(tenantId, { hard });
    console.log(
      `demo tenant ${tenantId} reset complete${hard ? " (tenant + staff deleted)" : " (pipeline data wiped, tenant + staff kept)"}`,
    );
    return;
  }

  // Refuse to seed over a non-demo tenant that happens to already occupy the fixed org id.
  await resolveDemoTenantId();

  console.log("SEED demo tenant");
  const { tenantId, summary } = await seedDemoTenant();
  console.log(`demo tenant ${tenantId} seeded (${process.env.DATABASE_URL?.split("@")[1] ?? "local"})`);
  console.log(`  leads:       ${Object.keys(summary.leads).length} (${Object.values(summary.leads).join(", ")})`);
  console.log(`  stage jobs:  ${Object.keys(summary.stageJobs).length} (${Object.values(summary.stageJobs).join(", ")})`);
  console.log(`  flavor jobs: ${Object.keys(summary.flavorJobs).length} (${Object.values(summary.flavorJobs).join(", ")})`);
  console.log(`  tasks swept: ${summary.tasksSwept}`);
}

main().then(async () => { await adminPool.end(); process.exit(0); })
  .catch(async (e) => { console.error(e); await adminPool.end().catch(() => {}); process.exit(1); });
