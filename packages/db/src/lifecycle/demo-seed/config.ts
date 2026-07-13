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

/**
 * Options for provisioning the demo tenant.
 *
 * With NO options this provisions the ONE real singleton demo tenant ("Demo Roofing
 * (Savvy)", fixed org id) — the production deliverable. `keySuffix` (or an explicit
 * `clerkOrgId`) provisions an ISOLATED tenant with a unique, globally-non-colliding
 * clerk org id + owner + name, so hermetic tests can seed without touching (or being
 * polluted by) the singleton. Contact natural keys (phones/emails/addresses) don't need
 * suffixing: they carry no global unique constraint and every seed lookup is tenant-scoped.
 */
export interface ProvisionDemoOpts {
  clerkOrgId?: string;
  keySuffix?: string;
}

export async function provisionDemoTenant(opts: ProvisionDemoOpts = {}): Promise<{ tenantId: string }> {
  const suffix = opts.keySuffix;
  // The only globally-unique lever is tenant.clerkOrgId — vary it (+ owner + name) per
  // isolated tenant. Defaults reproduce the singleton EXACTLY when no suffix is given.
  const clerkOrgId = opts.clerkOrgId ?? (suffix ? `${DEMO_CLERK_ORG_ID}_${suffix}` : DEMO_CLERK_ORG_ID);
  const name = suffix ? `${DEMO_TENANT_NAME} [${suffix}]` : DEMO_TENANT_NAME;
  const ownerClerkId = suffix ? `${DEMO_OWNER_CLERK_ID}_${suffix}` : DEMO_OWNER_CLERK_ID;
  const ownerEmail = suffix ? `owner+${suffix}@demo-roofing.test` : DEMO_OWNER_EMAIL;
  const licenseNumber = suffix ? `ROC-DEMO-${suffix}` : "ROC-DEMO-0001";
  const res = await provisionTenant(
    {
      name,
      clerkOrgId,
      timezone: "America/Phoenix",
      owner: { clerkUserId: ownerClerkId, name: "Demo Owner", email: ownerEmail },
      licenses: [{ state: "AZ", authority: "ROC", licenseNumber }],
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
