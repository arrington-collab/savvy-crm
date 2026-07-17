import { and, eq } from "drizzle-orm";
import { mapAccuLynxMilestone, mapAccuLynxLeadSource, mapAccuLynxWorkType } from "@savvy/core";
import { withTenant, type Tx } from "../tenant";
import { customer, property, lead } from "../schema/crm";
import { job } from "../schema/jobs";
import { importRecord } from "../schema/import-record";

// Alta cutover — the one-shot AccuLynx importer. Consumes the captured job
// JSON (internal /api/joblist dump) + contacts export and materializes
// customers → properties → leads/jobs under the target tenant. Idempotent via
// the import_record ledger: every created entity records its source GUID, and
// a re-run skips anything already ledgered. The raw source record rides along
// in payload — the audit trail for every migrated row.

const SOURCE = "acculynx";

export interface AccuLynxJobRecord {
  Id: string;
  CurrentMilestone: string;
  FullName: string;
  FullAddress: string;
  FullAddressGeoLocation?: { lat: number; lon: number } | null;
  LeadSource?: string | null;
  SalesPerson?: string | null;
  CreatedDate?: string | null;
  OrderTotal?: number | null;
  OrderPaid?: number | null;
  WorkTypes?: string[];
  PrimaryContact?: {
    ContactID: string;
    FullName: string;
    PrimaryPhone?: string | null;
    PrimaryEmail?: string | null;
  } | null;
}

export interface AccuLynxContact {
  contactId: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
}

export interface AccuLynxImportResult {
  customers: number;
  properties: number;
  leads: number;
  jobs: number;
}

async function ledgered(tx: Tx, tenantId: string, externalId: string): Promise<string | null> {
  const [row] = await tx.select({ entityId: importRecord.entityId }).from(importRecord)
    .where(and(eq(importRecord.tenantId, tenantId), eq(importRecord.source, SOURCE), eq(importRecord.externalId, externalId)));
  return row?.entityId ?? null;
}

async function ledger(
  tx: Tx, tenantId: string, externalId: string, entityType: string, entityId: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(importRecord).values({ tenantId, source: SOURCE, externalId, entityType, entityId, payload })
    .onConflictDoNothing();
}

/** Find-or-create a customer keyed by AccuLynx contact GUID. */
async function upsertCustomer(
  tx: Tx, tenantId: string, result: AccuLynxImportResult,
  o: { contactId: string; name: string; phone?: string | null; email?: string | null },
): Promise<string> {
  const existing = await ledgered(tx, tenantId, `contact:${o.contactId}`);
  if (existing) return existing;
  const [row] = await tx.insert(customer).values({
    tenantId, name: o.name, phone: o.phone ?? null, email: o.email ?? null,
    emailSource: o.email ? "self_reported" : null, // they gave it to Alta directly
  }).returning({ id: customer.id });
  await ledger(tx, tenantId, `contact:${o.contactId}`, "customer", row!.id);
  result.customers += 1;
  return row!.id;
}

export async function importAccuLynxData(
  tenantId: string,
  input: { jobs: AccuLynxJobRecord[]; contacts: AccuLynxContact[] },
): Promise<AccuLynxImportResult> {
  const result: AccuLynxImportResult = { customers: 0, properties: 0, leads: 0, jobs: 0 };

  await withTenant(tenantId, async (tx) => {
    for (const rec of input.jobs) {
      const contact = rec.PrimaryContact;
      // The primary contact is the person you talk to (can be a property
      // manager, not the homeowner in the job name) — they are the customer.
      const customerId = await upsertCustomer(tx, tenantId, result, {
        contactId: contact?.ContactID ?? `jobfallback:${rec.Id}`,
        name: contact?.FullName || rec.FullName,
        phone: contact?.PrimaryPhone, email: contact?.PrimaryEmail,
      });

      let propertyId = await ledgered(tx, tenantId, `prop:${rec.Id}`);
      if (!propertyId) {
        const [p] = await tx.insert(property).values({
          tenantId, customerId, address: rec.FullAddress,
          lat: rec.FullAddressGeoLocation?.lat ?? null,
          lng: rec.FullAddressGeoLocation?.lon ?? null,
        }).returning({ id: property.id });
        propertyId = p!.id;
        await ledger(tx, tenantId, `prop:${rec.Id}`, "property", propertyId);
        result.properties += 1;
      }

      const mapping = mapAccuLynxMilestone(rec.CurrentMilestone);
      const { source, detail } = mapAccuLynxLeadSource(rec.LeadSource);
      const payload = rec as unknown as Record<string, unknown>;

      if (mapping.kind === "lead") {
        if (await ledgered(tx, tenantId, `lead:${rec.Id}`)) continue;
        const [l] = await tx.insert(lead).values({
          tenantId, customerId, propertyId, source,
          sourceDetail: { acculynx: detail, salesPerson: rec.SalesPerson ?? null },
        }).returning({ id: lead.id });
        await ledger(tx, tenantId, `lead:${rec.Id}`, "lead", l!.id, payload);
        result.leads += 1;
      } else {
        if (await ledgered(tx, tenantId, `job:${rec.Id}`)) continue;
        const [j] = await tx.insert(job).values({
          tenantId, customerId, propertyId,
          stage: mapping.stage,
          type: mapAccuLynxWorkType(rec.WorkTypes),
          openedAt: rec.CreatedDate ? new Date(rec.CreatedDate) : new Date(),
        }).returning({ id: job.id });
        await ledger(tx, tenantId, `job:${rec.Id}`, "job", j!.id, payload);
        result.jobs += 1;
      }
    }

    // Contacts with no job (past estimates, referrers, vendors) still come
    // along — they're the tenant's rolodex.
    for (const c of input.contacts) {
      await upsertCustomer(tx, tenantId, result, {
        contactId: c.contactId, name: c.name, phone: c.phone, email: c.email,
      });
    }
  });

  return result;
}
