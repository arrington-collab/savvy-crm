import { adminDb, tenant, eq, createLeadForTenant as createLeadForTenantDb } from "@savvy/db";
import { inngest } from "@savvy/agents";
import type { LeadIntakeInput } from "@savvy/core";

// Slim copy of apps/web's intake helpers — only what the canvass routes use.
// No Vapi/phone resolution here: this app serves the field API alone.

export async function tenantByKey(key: string) {
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.publicKey, key));
  return t ?? null;
}

export async function tenantById(id: string) {
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, id));
  return t ?? null;
}

/**
 * Creates customer+property+lead under a tenant (RLS-scoped via withTenant),
 * then emits lead/created. Returns the new lead id. The Inngest event is
 * processed by savvy-crm's registered functions — same Inngest env.
 */
export async function createLeadForTenant(tenantId: string, input: LeadIntakeInput): Promise<string> {
  const leadId = await createLeadForTenantDb(tenantId, input);
  try {
    await inngest.send({ name: "lead/created", data: { leadId, tenantId } });
  } catch (err) {
    // Lead is already persisted; a missing Inngest engine must not fail creation.
    console.error("lead/created send failed (lead still created):", err);
  }
  return leadId;
}
