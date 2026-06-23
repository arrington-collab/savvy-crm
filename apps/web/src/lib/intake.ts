import { adminDb, withTenant, tenant, customer, property, lead, eq } from "@savvy/db";
import { inngest } from "@savvy/agents";
import { parseCityFromAddress } from "@savvy/core";
import type { LeadIntakeInput } from "@savvy/core";

export async function tenantByKey(key: string) {
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.publicKey, key));
  return t ?? null;
}

export async function tenantByPhone(phone: string) {
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.inboundPhone, phone));
  return t ?? null;
}

/**
 * Creates customer+property+lead under a tenant (RLS-scoped via withTenant),
 * then emits lead/created. Returns the new lead id.
 */
export async function createLeadForTenant(tenantId: string, input: LeadIntakeInput): Promise<string> {
  const leadId = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: input.name, phone: input.phone }).returning();
    const [p] = await tx.insert(property).values({
      tenantId,
      customerId: c!.id,
      address: input.address,
      line1: input.line1 ?? null,
      city: input.city ?? parseCityFromAddress(input.address),
      state: input.state ?? null,
      zip: input.zip ?? null,
      county: input.county ?? null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      roofType: input.roofType ?? null,
      yearBuilt: input.yearBuilt ?? null,
    }).returning();
    const [l] = await tx.insert(lead).values({
      tenantId, customerId: c!.id, propertyId: p!.id, source: input.source, status: "new",
    }).returning();
    return l!.id;
  });
  try {
    await inngest.send({ name: "lead/created", data: { leadId, tenantId } });
  } catch (err) {
    // Lead is already persisted; a missing Inngest engine must not fail creation.
    console.error("lead/created send failed (lead still created):", err);
  }
  return leadId;
}
