import { and, eq, lt, or, isNull, isNotNull, sql } from "drizzle-orm";
import { withTenant } from "../tenant";
import { property, lead, enrichmentAttempt } from "../schema/index";

export const MAX_ENRICH_ATTEMPTS = 3;
export const ENRICH_BACKOFF_MS = 7 * 86_400_000; // 7 days

export type EnrichmentStatus = "filled" | "no_data" | "error";

/** Upsert the (entity, enricher) ledger row, bumping attempts + last_attempt_at. */
export async function recordEnrichmentAttempt(
  tenantId: string,
  input: { entityType: string; entityId: string; enricherKey: string; status: EnrichmentStatus; detail?: string | null },
): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx
      .insert(enrichmentAttempt)
      .values({
        tenantId,
        entityType: input.entityType,
        entityId: input.entityId,
        enricherKey: input.enricherKey,
        status: input.status,
        attempts: 1,
        lastAttemptAt: new Date(),
        detail: input.detail ?? null,
      })
      .onConflictDoUpdate({
        target: [enrichmentAttempt.tenantId, enrichmentAttempt.entityType, enrichmentAttempt.entityId, enrichmentAttempt.enricherKey],
        set: {
          status: input.status,
          attempts: sql`${enrichmentAttempt.attempts} + 1`,
          lastAttemptAt: new Date(),
          detail: input.detail ?? null,
          updatedAt: new Date(),
        },
      }),
  );
}

export interface PropertyDue {
  propertyId: string;
  address: string;
}

// "Due" = no attempt row for this enricher yet, OR the row is under the attempt cap
// AND was last tried before the backoff cutoff. Prevents re-hammering dead-ends nightly.
function dueClause() {
  const cutoff = new Date(Date.now() - ENRICH_BACKOFF_MS);
  return or(
    isNull(enrichmentAttempt.id),
    and(lt(enrichmentAttempt.attempts, MAX_ENRICH_ATTEMPTS), lt(enrichmentAttempt.lastAttemptAt, cutoff)),
  );
}

export async function findPropertiesNeedingGeocode(tenantId: string, limit: number): Promise<PropertyDue[]> {
  return withTenant(tenantId, (tx) =>
    tx
      .select({ propertyId: property.id, address: property.address })
      .from(property)
      .leftJoin(
        enrichmentAttempt,
        and(
          eq(enrichmentAttempt.entityType, "property"),
          eq(enrichmentAttempt.entityId, property.id),
          eq(enrichmentAttempt.enricherKey, "geocode"),
        ),
      )
      .where(and(isNull(property.lat), dueClause()))
      .limit(limit),
  );
}

export async function findPropertiesNeedingStormproof(tenantId: string, limit: number): Promise<PropertyDue[]> {
  return withTenant(tenantId, (tx) =>
    tx
      .select({ propertyId: property.id, address: property.address })
      .from(property)
      .leftJoin(
        enrichmentAttempt,
        and(
          eq(enrichmentAttempt.entityType, "property"),
          eq(enrichmentAttempt.entityId, property.id),
          eq(enrichmentAttempt.enricherKey, "property-stormproof"),
        ),
      )
      .where(and(isNotNull(property.lat), isNotNull(property.lng), isNull(property.yearBuilt), dueClause()))
      .limit(limit),
  );
}

/** Oldest lead on a property — for attributing an enrichment agent_run to a customer. */
export async function findLeadIdForProperty(tenantId: string, propertyId: string): Promise<string | null> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ id: lead.id, createdAt: lead.createdAt })
      .from(lead)
      .where(eq(lead.propertyId, propertyId));
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]?.id ?? null;
  });
}
