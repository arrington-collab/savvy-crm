import { writeFileSync } from "node:fs";
import { adminDb, adminPool, tenant, license, contractTemplate } from "@savvy/db";
// NOT re-exported from the @savvy/db barrel (packages/db/src/index.ts) — the
// registry seed uses `.js`-extension imports Turbopack can't resolve, and the
// barrel is pulled into the Next app graph via @savvy/agents. This script runs
// standalone under tsx (see db:seed / db:seed:registry), so importing the
// subpath directly is safe here.
import { seedTaskRegistry } from "@savvy/db/seeds/master-task-list";

// Creates a fresh, isolated tenant for one e2e run and writes its id+key to a
// file the playwright config + spec read. Run BEFORE `playwright test` so the
// webServer starts with the right TEST_TENANT_ID.
async function main() {
  const stamp = Date.now();
  const key = `e2e-${stamp}`;
  const [t] = await adminDb
    .insert(tenant)
    .values({
      name: "E2E Tenant",
      publicKey: key,
      clerkOrgId: `org_${key}`,
      inboundPhone: `+1555${String(stamp).slice(-7)}`,
    })
    .returning();

  // Cell 17a: bookAppointment hard-blocks scheduling in a jurisdiction with no
  // active license. e2e booking flows use real AZ addresses (e.g. quick-book →
  // Mesa 85203), so seed active state-level licenses for the operating states
  // (AZ/NV/CO) or those flows throw LicenseRequiredError. city: null = state-level.
  await adminDb.insert(license).values([
    { tenantId: t!.id, state: "AZ", city: null, authority: "AZ ROC", licenseNumber: `ROC-${key}`, status: "active", expiresAt: null },
    { tenantId: t!.id, state: "NV", city: null, authority: "NV State Contractors", licenseNumber: `NV-${key}`, status: "active", expiresAt: null },
    { tenantId: t!.id, state: "CO", city: null, authority: "CO SoS", licenseNumber: `CO-${key}`, status: "active", expiresAt: null },
  ]);

  // Cell 17b: seed a compliant CO SB38 contract template so any CO estimate /
  // canvass contract e2e flow resolves a template instead of failing closed.
  await adminDb.insert(contractTemplate).values({
    tenantId: t!.id,
    state: "CO",
    version: 1,
    name: "Colorado SB38 Roofing Contract",
    docusealTemplateId: null,
    clauses: ["right_to_rescind", "no_deductible_waiver", "ten_day"],
    status: "active",
  });

  // The global task_registry (212 master tasks) is normally seeded by
  // db:seed / db:seed:registry, but the e2e harness never runs either — so
  // instantiateJobTasks/getJobLedger/waiting-on find no registry rows and the
  // Tasks tab + pipeline waiting-on render empty. Seed it here too. It's a
  // global, versioned table with an idempotent upsert-on-id, so this is safe
  // to call even if the registry is already seeded.
  const registryCount = await seedTaskRegistry(adminDb);
  console.log(`seeded ${registryCount} registry tasks`);

  writeFileSync("/tmp/savvy-e2e-tenant.json", JSON.stringify({ id: t!.id, key }));
  console.log(`e2e tenant created: id=${t!.id} key=${key} (+AZ/NV/CO licenses +CO SB38 template)`);
  await adminPool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
