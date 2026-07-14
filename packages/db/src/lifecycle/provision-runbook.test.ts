import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client";
import { tenant, user } from "../schema/tenancy";
import { license, contractTemplate } from "../schema/compliance";
import { tenantTaskConfig } from "../schema/task-registry";
import { integrationConnection } from "../schema/integrations";
import { priceBookItem, priceBookVersion, tierProduct } from "../schema/pricing";
import { provisionTenant, DORMANT_SEAMS, type TenantProvisionConfig } from "./provision-runbook";

// Required for seal/open when the Twilio wiring step encrypts the auth token.
process.env.INTEGRATION_SECRET_KEY = Buffer.alloc(32, 9).toString("base64");

// A committable config (NO secrets) modelling a Denver tenant like Alta.
const baseConfig = (orgSuffix: string): TenantProvisionConfig => ({
  name: "Alta Roofing",
  clerkOrgId: `org_alta_${orgSuffix}`,
  owner: { clerkUserId: `usr_owner_${orgSuffix}`, name: "Alta Owner", email: "owner@alta.example" },
  licenses: [
    { state: "CO", city: null, authority: "CO SoS", licenseNumber: `CO-${orgSuffix}`, status: "active" },
    { state: "CO", city: "Denver", authority: "Denver", licenseNumber: `DEN-${orgSuffix}`, status: "active" },
  ],
  contractTemplates: [
    { state: "CO", version: 1, name: "Colorado SB38 Roofing Contract", clauses: ["right_to_rescind", "no_deductible_waiver", "ten_day"], status: "active" },
  ],
  taskConfig: [{ taskId: 44, enabled: true }],
});

const orgs: string[] = [];
async function cleanup(clerkOrgId: string) {
  const [t] = await adminDb.select({ id: tenant.id }).from(tenant).where(eq(tenant.clerkOrgId, clerkOrgId));
  if (!t) return;
  await adminDb.delete(tenantTaskConfig).where(eq(tenantTaskConfig.tenantId, t.id));
  await adminDb.delete(priceBookItem).where(eq(priceBookItem.tenantId, t.id));
  await adminDb.delete(priceBookVersion).where(eq(priceBookVersion.tenantId, t.id));
  await adminDb.delete(tierProduct).where(eq(tierProduct.tenantId, t.id));
  await adminDb.delete(integrationConnection).where(eq(integrationConnection.tenantId, t.id));
  await adminDb.delete(contractTemplate).where(eq(contractTemplate.tenantId, t.id));
  await adminDb.delete(license).where(eq(license.tenantId, t.id));
  await adminDb.delete(user).where(eq(user.tenantId, t.id));
  await adminDb.delete(tenant).where(eq(tenant.id, t.id));
}

afterAll(async () => {
  for (const o of orgs) await cleanup(o);
  await adminPool.end();
});

describe("provisionTenant — dry run", () => {
  it("writes NOTHING and returns a plan for every step", async () => {
    const suffix = `dry_${Math.random().toString(36).slice(2)}`;
    orgs.push(`org_alta_${suffix}`);
    const res = await provisionTenant(baseConfig(suffix), {}, { dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.steps.length).toBeGreaterThan(0);
    expect(res.steps.every((s) => s.action === "planned")).toBe(true);
    // Nothing persisted.
    const rows = await adminDb.select({ id: tenant.id }).from(tenant).where(eq(tenant.clerkOrgId, `org_alta_${suffix}`));
    expect(rows).toHaveLength(0);
  });
});

describe("provisionTenant — commit", () => {
  it("creates tenant #N with Denver TZ, owner, price book, licenses, and CO SB38 template", async () => {
    const suffix = `co_${Math.random().toString(36).slice(2)}`;
    orgs.push(`org_alta_${suffix}`);
    const res = await provisionTenant(baseConfig(suffix), {}, { dryRun: false });
    expect(res.dryRun).toBe(false);
    expect(res.tenantId).toBeTruthy();
    expect(res.created).toBe(true);

    const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, res.tenantId));
    expect(t!.timezone).toBe("America/Denver");
    const owners = await adminDb.select().from(user).where(eq(user.tenantId, res.tenantId));
    expect(owners.some((u) => u.role === "owner")).toBe(true);
    const lics = await adminDb.select().from(license).where(eq(license.tenantId, res.tenantId));
    expect(lics.length).toBe(2);
    const tmpls = await adminDb.select().from(contractTemplate).where(and(eq(contractTemplate.tenantId, res.tenantId), eq(contractTemplate.state, "CO")));
    expect(tmpls.length).toBe(1);
    const cfg = await adminDb.select().from(tenantTaskConfig).where(and(eq(tenantTaskConfig.tenantId, res.tenantId), eq(tenantTaskConfig.taskId, 44)));
    expect(cfg.length).toBe(1);
    // provisioning.complete artifact present.
    expect(res.artifact.status).toBe("complete");
    expect(res.artifact.tenantId).toBe(res.tenantId);
  });

  it("is idempotent — a second run reuses the tenant and creates no duplicates", async () => {
    const suffix = `idem_${Math.random().toString(36).slice(2)}`;
    orgs.push(`org_alta_${suffix}`);
    const first = await provisionTenant(baseConfig(suffix), {}, { dryRun: false });
    const second = await provisionTenant(baseConfig(suffix), {}, { dryRun: false });
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.created).toBe(false);
    const lics = await adminDb.select().from(license).where(eq(license.tenantId, first.tenantId));
    expect(lics.length).toBe(2); // not 4
    const tmpls = await adminDb.select().from(contractTemplate).where(eq(contractTemplate.tenantId, first.tenantId));
    expect(tmpls.length).toBe(1); // not 2
  });
});

describe("provisionTenant — dormant seams + Twilio", () => {
  it("reports Twilio as a dormant seam when no secret is provided", async () => {
    const suffix = `seam_${Math.random().toString(36).slice(2)}`;
    orgs.push(`org_alta_${suffix}`);
    const res = await provisionTenant({ ...baseConfig(suffix), twilio: { fromNumber: "+13035550123" } }, {}, { dryRun: false });
    const twilioSeam = res.dormantSeams.find((s) => s.key === "twilio");
    expect(twilioSeam).toBeTruthy();
    expect(twilioSeam!.active).toBe(false);
    // No connection row written when the secret is absent.
    const conns = await adminDb.select().from(integrationConnection).where(eq(integrationConnection.tenantId, res.tenantId));
    expect(conns).toHaveLength(0);
    // The inventory covers every known seam.
    expect(res.dormantSeams.map((s) => s.key).sort()).toEqual([...DORMANT_SEAMS].map((s) => s.key).sort());
  });

  it("wires Twilio + A2P pointers when a secret is supplied (never from config)", async () => {
    const suffix = `tw_${Math.random().toString(36).slice(2)}`;
    orgs.push(`org_alta_${suffix}`);
    const res = await provisionTenant(
      { ...baseConfig(suffix), twilio: { fromNumber: "+13035550123", a2p: { brandStatus: "pending", campaignStatus: "pending" } } },
      { twilioSecret: { accountSid: "ACtest", authToken: "tok_from_env" } },
      { dryRun: false },
    );
    const twilioSeam = res.dormantSeams.find((s) => s.key === "twilio");
    expect(twilioSeam!.active).toBe(true);
    const [conn] = await adminDb.select().from(integrationConnection).where(eq(integrationConnection.tenantId, res.tenantId));
    expect(conn!.provider).toBe("twilio");
    expect((conn!.metadata as { fromNumber?: string }).fromNumber).toBe("+13035550123");
    // The token is sealed — never stored in plaintext.
    expect(conn!.secretCiphertext).not.toContain("tok_from_env");
  });
});
