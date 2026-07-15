import { and, eq, or, sql } from "drizzle-orm";
import { withTenant } from "../tenant";
import { customer, property, lead } from "../schema/crm";
import { partner } from "../schema/partner";
import { parseCityFromAddress, normalizeAddress, isPartnerSource, partnerClassForSource } from "@savvy/core";
import type { LeadIntakeInput } from "@savvy/core";
import { instantiateLeadTasks } from "./lead-tasks";
import { findOrCreatePartnerTx } from "./partner";

/**
 * DB-side of lead intake: dedupe/create customer + property, insert the lead
 * (status 'new'), and instantiate the lead task ledger — all in ONE tenant-scoped
 * transaction. Returns the new lead id.
 *
 * This is the single source of truth for intake persistence. The web wrapper
 * (`apps/web/src/lib/intake.ts`) calls this, then emits `lead/created`. `packages/db`
 * must not import `@savvy/agents`, so the Inngest side effect lives in the web layer.
 */
export async function createLeadForTenant(tenantId: string, input: LeadIntakeInput): Promise<string> {
  return withTenant(tenantId, async (tx) => {
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

    // Partner Ledger attribution: partner-class sources resolve to a partner
    // record — a picked id (verified tenant-visible under RLS) or an inline
    // create-once payload. Free text alone never reaches this function (schema).
    let partnerId: string | null = null;
    if (isPartnerSource(input.source)) {
      if (input.partnerId) {
        const [p] = await tx.select({ id: partner.id }).from(partner)
          .where(and(eq(partner.tenantId, tenantId), eq(partner.id, input.partnerId)));
        if (!p) throw new Error("Unknown partner for this tenant");
        partnerId = p.id;
      } else if (input.partner) {
        const r = await findOrCreatePartnerTx(tx, tenantId, {
          ...input.partner,
          class: input.partner.class ?? partnerClassForSource(input.source),
        });
        partnerId = r.id;
      }
    }

    const [l] = await tx.insert(lead).values({
      tenantId, customerId: c.id, propertyId, source: input.source, status: "new", partnerId,
      sourceDetail: (input as { sourceDetail?: unknown }).sourceDetail ?? null,
    }).returning();
    await instantiateLeadTasks(tx, { tenantId, leadId: l!.id });
    return l!.id;
  });
}
