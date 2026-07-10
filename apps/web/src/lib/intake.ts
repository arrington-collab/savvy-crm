import { adminDb, withTenant, tenant, customer, property, lead, eq, and, or, sql, tenantByVapiAssistant, instantiateLeadTasks } from "@savvy/db";
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
  const leadId = await withTenant(tenantId, async (tx) => {
    // Dedupe: reuse an existing customer on an EXACT normalized phone OR email match.
    const conds = [] as ReturnType<typeof eq>[];
    if (input.phone) conds.push(eq(customer.phone, input.phone));
    if (input.email) conds.push(eq(customer.email, input.email));
    let existing: { id: string; createdAt: Date; smsConsentAt: Date | null } | undefined;
    if (conds.length) {
      const matches = await tx.select({ id: customer.id, createdAt: customer.createdAt, smsConsentAt: customer.smsConsentAt }).from(customer)
        .where(and(eq(customer.tenantId, tenantId), conds.length === 1 ? conds[0] : or(...conds)));
      existing = matches.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]; // oldest, deterministic
    }

    const c = existing ?? (await tx.insert(customer)
      .values({ tenantId, name: input.name, phone: input.phone ?? null, email: input.email ?? null,
                smsConsentAt: input.phone ? sql`now()` : null })
      .returning())[0]!;
    if (existing && input.phone && existing.smsConsentAt == null) {
      await tx.update(customer).set({ smsConsentAt: sql`now()` }).where(eq(customer.id, c.id));
    }

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
      sourceDetail: (input as { sourceDetail?: unknown }).sourceDetail ?? null,
    }).returning();
    await instantiateLeadTasks(tx, { tenantId, leadId: l!.id });
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
