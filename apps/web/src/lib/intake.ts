import { adminDb, withTenant, tenant, customer, property, lead, eq, and, or } from "@savvy/db";
import { inngest } from "@savvy/agents";
import { parseCityFromAddress, normalizeAddress } from "@savvy/core";
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
    // Dedupe: reuse an existing customer on an EXACT normalized phone OR email match.
    const conds = [] as ReturnType<typeof eq>[];
    if (input.phone) conds.push(eq(customer.phone, input.phone));
    if (input.email) conds.push(eq(customer.email, input.email));
    let existing: { id: string; createdAt: Date } | undefined;
    if (conds.length) {
      const matches = await tx.select({ id: customer.id, createdAt: customer.createdAt }).from(customer)
        .where(and(eq(customer.tenantId, tenantId), conds.length === 1 ? conds[0] : or(...conds)));
      existing = matches.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]; // oldest, deterministic
    }

    const c = existing ?? (await tx.insert(customer)
      .values({ tenantId, name: input.name, phone: input.phone ?? null, email: input.email ?? null })
      .returning())[0]!;

    // Reuse the customer's property only on an exact normalized-address match; else insert.
    let propertyId: string | undefined;
    if (existing) {
      const props = await tx.select({ id: property.id, address: property.address }).from(property)
        .where(eq(property.customerId, c.id));
      const want = normalizeAddress(input.address);
      propertyId = props.find((p) => normalizeAddress(p.address) === want)?.id;
    }
    if (!propertyId) {
      const [p] = await tx.insert(property).values({
        tenantId, customerId: c.id, address: input.address, line1: input.line1 ?? null,
        city: input.city ?? parseCityFromAddress(input.address), state: input.state ?? null,
        zip: input.zip ?? null, county: input.county ?? null, lat: input.lat ?? null, lng: input.lng ?? null,
        roofType: input.roofType ?? null, yearBuilt: input.yearBuilt ?? null,
      }).returning();
      propertyId = p!.id;
    }

    const [l] = await tx.insert(lead).values({
      tenantId, customerId: c.id, propertyId, source: input.source, status: "new",
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
