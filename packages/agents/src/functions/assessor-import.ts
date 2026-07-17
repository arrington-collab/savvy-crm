import { withTenant, eq, property, setPropertyRoofMaterial } from "@savvy/db";
import { normalizeAddressForMatch } from "@savvy/core";
import { assessorFeed as defaultFeed, type AssessorFeed } from "@savvy/integrations";

// Strike List slice 1 — the assessor importer. Pull county parcels through the
// AssessorFeed seam, match to existing properties (parcel id first, then
// normalized address), upgrade their roof material via the precedence-guarded
// write path, and land unmatched golden-candidate parcels as prospect
// properties (no customer yet). Mirrors email-append.ts: an integration seam
// orchestrated over db writes lives here in agents, not in the db package.
// Annual re-runs are idempotent — a prospect carries its parcel id, so the next
// import matches it instead of duplicating.

// Assessor data is bulk records, not a roof someone stood on — reliable enough
// to target from, below spotter/inspection ground truth.
const ASSESSOR_CONFIDENCE = 0.6;

export interface AssessorImportResult {
  parcels: number;
  matched: number;
  created: number;
  excluded: number;
}

export async function importAssessorParcels(
  tenantId: string,
  input: { feed?: AssessorFeed; county: string; since?: Date; reRoofedParcelIds?: Set<string> },
): Promise<AssessorImportResult> {
  const feed = input.feed ?? defaultFeed;
  const parcels = await feed.fetchParcels({ county: input.county, since: input.since });
  const reRoofed = input.reRoofedParcelIds ?? new Set<string>();
  const result: AssessorImportResult = { parcels: parcels.length, matched: 0, created: 0, excluded: 0 };

  // Index the tenant's properties once: by parcel id (authoritative match) and
  // by normalized address (fallback for parcels we haven't stamped yet).
  const existing = await withTenant(tenantId, (tx) =>
    tx.select({ id: property.id, address: property.address, parcelId: property.parcelId }).from(property));
  const byParcel = new Map<string, string>();
  const byAddress = new Map<string, string>();
  for (const p of existing) {
    if (p.parcelId) byParcel.set(p.parcelId, p.id);
    const key = normalizeAddressForMatch(p.address);
    if (key && !byAddress.has(key)) byAddress.set(key, p.id);
  }

  for (const parcel of parcels) {
    // A permit-recorded re-roof drops the parcel from the golden list entirely.
    if (reRoofed.has(parcel.parcelId)) { result.excluded += 1; continue; }

    const matchedId = byParcel.get(parcel.parcelId) ?? byAddress.get(normalizeAddressForMatch(parcel.address));
    if (matchedId) {
      if (parcel.roofMaterial) {
        await setPropertyRoofMaterial(tenantId, {
          propertyId: matchedId, material: parcel.roofMaterial, source: "assessor", confidence: ASSESSOR_CONFIDENCE,
        });
      }
      await fillPropertyMetadata(tenantId, matchedId, parcel.parcelId, parcel.subdivision, parcel.yearBuilt);
      result.matched += 1;
    } else {
      const newId = await withTenant(tenantId, async (tx) => {
        const [row] = await tx.insert(property).values({
          tenantId,
          address: parcel.address,
          parcelId: parcel.parcelId,
          subdivision: parcel.subdivision,
          yearBuilt: parcel.yearBuilt,
          roofMaterial: parcel.roofMaterial,
          roofMaterialSource: parcel.roofMaterial ? "assessor" : null,
          roofMaterialConfidence: parcel.roofMaterial ? ASSESSOR_CONFIDENCE : null,
        }).returning({ id: property.id });
        return row!.id;
      });
      // Keep the in-run indexes current so a duplicate parcel later in the same
      // batch matches rather than double-inserting.
      byParcel.set(parcel.parcelId, newId);
      byAddress.set(normalizeAddressForMatch(parcel.address), newId);
      result.created += 1;
    }
  }
  return result;
}

/** Fill parcelId/subdivision/yearBuilt only where the property has none — the
 *  assessor supplies metadata but must not overwrite richer local data. */
async function fillPropertyMetadata(
  tenantId: string, propertyId: string,
  parcelId: string, subdivision: string | null, yearBuilt: number | null,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [cur] = await tx.select({
      parcelId: property.parcelId, subdivision: property.subdivision, yearBuilt: property.yearBuilt,
    }).from(property).where(eq(property.id, propertyId));
    if (!cur) return;
    const patch: Partial<typeof property.$inferInsert> = {};
    if (!cur.parcelId && parcelId) patch.parcelId = parcelId;
    if (!cur.subdivision && subdivision) patch.subdivision = subdivision;
    if (cur.yearBuilt == null && yearBuilt != null) patch.yearBuilt = yearBuilt;
    if (Object.keys(patch).length > 0) {
      await tx.update(property).set(patch).where(eq(property.id, propertyId));
    }
  });
}
