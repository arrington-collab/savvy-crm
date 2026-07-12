import { writeFileSync } from "node:fs";
// NOT re-exported from the @savvy/db barrel (packages/db/src/index.ts) — `seedDemoTenant`
// pulls in provision-runbook.ts, which imports the registry seed via a `.js`-extension
// import Turbopack can't resolve, and the barrel is pulled into the Next app graph via
// @savvy/agents (see the barrel's own NOTE next to provision-runbook). This script runs
// standalone under tsx (mirrors create-tenant.ts's seedTaskRegistry precedent), so
// importing the subpath directly is safe here.
import { seedDemoTenant } from "@savvy/db/src/lifecycle/demo-seed/reset";
import { adminPool } from "@savvy/db";

// Seeds the ONE real singleton demo tenant ("Demo Roofing (Savvy)") — the same tenant
// `pnpm db:seed:demo` produces — so this e2e proves the actual demo-tenant deliverable,
// not an isolated double. Idempotent: re-running reuses the same tenant/jobs/leads.
// Writes its id to a file the Playwright config (TEST_TENANT_ID) + spec read. Must run
// BEFORE `playwright test` so the webServer boots `next dev` with the demo tenant active.
async function main() {
  const { tenantId, summary } = await seedDemoTenant();
  writeFileSync("/tmp/savvy-e2e-demo-tenant.json", JSON.stringify({ id: tenantId }));
  console.log(
    `demo tenant ${tenantId} seeded: leads=${Object.keys(summary.leads).length} stageJobs=${Object.keys(summary.stageJobs).length} flavorJobs=${Object.keys(summary.flavorJobs).length} tasksSwept=${summary.tasksSwept}`,
  );
  await adminPool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
