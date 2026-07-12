import { eq } from "drizzle-orm";
import { adminDb } from "../../admin-client";
import { tenant } from "../../schema/tenancy";
import { provisionTenant } from "../provision-runbook";
import { ensureUser } from "../provisioning";

// Deterministic synthetic Clerk ids so re-runs reconcile. The OWNER's clerkOrgId /
// clerkUserId are overridable via env for the real prod org (so the owner can switch
// to it). Defaults are demo sentinels usable locally.
export const DEMO_CLERK_ORG_ID = process.env.DEMO_CLERK_ORG_ID ?? "org_demo_savvy";
export const DEMO_OWNER_CLERK_ID = process.env.DEMO_OWNER_CLERK_ID ?? "usr_demo_owner";
export const DEMO_OWNER_EMAIL = process.env.DEMO_OWNER_EMAIL ?? "owner@demo-roofing.test";

export const DEMO_TENANT_NAME = "Demo Roofing (Savvy)";

export const DEMO_STAFF = [
  { clerkUserId: "usr_demo_office", name: "Olivia Office", email: "olivia@demo-roofing.test", role: "office" as const },
  { clerkUserId: "usr_demo_repA", name: "Rick RepA", email: "rick@demo-roofing.test", role: "rep" as const },
  { clerkUserId: "usr_demo_repB", name: "Rita RepB", email: "rita@demo-roofing.test", role: "rep" as const },
  { clerkUserId: "usr_demo_crew", name: "Carlos Crew", email: "carlos@demo-roofing.test", role: "crew" as const },
];

export async function provisionDemoTenant(): Promise<{ tenantId: string }> {
  const res = await provisionTenant(
    {
      name: DEMO_TENANT_NAME,
      clerkOrgId: DEMO_CLERK_ORG_ID,
      timezone: "America/Phoenix",
      owner: { clerkUserId: DEMO_OWNER_CLERK_ID, name: "Demo Owner", email: DEMO_OWNER_EMAIL },
      licenses: [{ state: "AZ", authority: "ROC", licenseNumber: "ROC-DEMO-0001" }],
    },
    {},
    { dryRun: false },
  );
  const tenantId = res.tenantId;
  // Flag demo + sentinel stripe account (lets the invoice lifecycle run with NO live Stripe call).
  await adminDb.update(tenant).set({ demo: true, stripeAccountId: "acct_demo" }).where(eq(tenant.id, tenantId));
  for (const s of DEMO_STAFF) {
    await ensureUser({ tenantId, clerkUserId: s.clerkUserId, name: s.name, email: s.email, role: s.role });
  }
  return { tenantId };
}
