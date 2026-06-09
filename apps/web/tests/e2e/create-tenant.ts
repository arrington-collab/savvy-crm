import { writeFileSync } from "node:fs";
import { adminDb, adminPool, tenant } from "@savvy/db";

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

  writeFileSync("/tmp/savvy-e2e-tenant.json", JSON.stringify({ id: t!.id, key }));
  console.log(`e2e tenant created: id=${t!.id} key=${key}`);
  await adminPool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
