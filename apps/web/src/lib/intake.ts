import { adminDb, tenant, eq, tenantByVapiAssistant, createLeadForTenant as createLeadForTenantDb } from "@savvy/db";
import { inngest } from "@savvy/agents";
import type { LeadIntakeInput } from "@savvy/core";

export async function tenantByKey(key: string) {
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.publicKey, key));
  return t ?? null;
}

export async function tenantByPhone(phone: string) {
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.inboundPhone, phone));
  return t ?? null;
}

export async function tenantById(id: string) {
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, id));
  return t ?? null;
}

/** Inbound tenant resolution: BYO Vapi assistant first, else dialed-number. */
export async function resolveInboundTenant(msg: { assistantId: string | null; toNumber: string | null }) {
  if (msg.assistantId) {
    const tid = await tenantByVapiAssistant(msg.assistantId);
    if (tid) return tenantById(tid);
  }
  return msg.toNumber ? tenantByPhone(msg.toNumber) : null;
}

/**
 * Creates customer+property+lead under a tenant (RLS-scoped via withTenant),
 * then emits lead/created. Returns the new lead id.
 */
export async function createLeadForTenant(tenantId: string, input: LeadIntakeInput): Promise<string> {
  // Persist customer + property + lead + task ledger via the shared db-side intake
  // (single source of truth), then emit the post-commit side effect.
  const leadId = await createLeadForTenantDb(tenantId, input);
  try {
    await inngest.send({ name: "lead/created", data: { leadId, tenantId } });
  } catch (err) {
    // Lead is already persisted; a missing Inngest engine must not fail creation.
    console.error("lead/created send failed (lead still created):", err);
  }
  return leadId;
}
