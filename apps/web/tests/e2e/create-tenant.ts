import { writeFileSync } from "node:fs";
import { adminDb, adminPool, tenant, license } from "@savvy/db";

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

  writeFileSync("/tmp/savvy-e2e-tenant.json", JSON.stringify({ id: t!.id, key }));
  console.log(`e2e tenant created: id=${t!.id} key=${key} (+AZ/NV/CO licenses)`);
  await adminPool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
