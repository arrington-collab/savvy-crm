import { withTenant, property, spotterPin, setPropertyRoofMaterial } from "@savvy/db";
import { normalizeAddressForMatch, nearestWithin, type RoofMaterial } from "@savvy/core";
import { spotterFeed as defaultFeed, type SpotterFeed } from "@savvy/integrations";

// Strike List slice 2 (#265) — the Roof Tagger pull sync. Pull human-tagged
// roofs through the SpotterFeed seam, match each to a known property (address
// first, then nearest roof within a radius), upgrade its roof material via the
// precedence-guarded write path with source='spotter', and land unmatched pins
// as prospect properties at the tapped coordinates. Each pin persists to
// spotter_pin keyed by (tenant, external_id) — a re-sync updates in place.
// Mirrors the assessor importer; an integration seam orchestrated over db.

// A spotter is a human who looked at the roof from the street — more reliable
// than an assessor's bulk record, still short of a full inspection.
const SPOTTER_CONFIDENCE = 0.8;
// Two adjacent Phoenix lots are ~15 m apart; 30 m keeps a tap on its own roof.
const MATCH_RADIUS_M = 30;

export interface SpotterImportResult {
  pins: number;
  matched: number;
  created: number;
}

export async function importSpotterPins(
  tenantId: string,
  input: { feed?: SpotterFeed; since?: Date; matchRadiusMeters?: number },
): Promise<SpotterImportResult> {
  const feed = input.feed ?? defaultFeed;
  const radius = input.matchRadiusMeters ?? MATCH_RADIUS_M;
  const pins = await feed.fetchPins({ since: input.since });
  const result: SpotterImportResult = { pins: pins.length, matched: 0, created: 0 };

  const props = await withTenant(tenantId, (tx) =>
    tx.select({ id: property.id, address: property.address, lat: property.lat, lng: property.lng }).from(property));
  const byAddress = new Map<string, string>();
  for (const p of props) {
    const key = normalizeAddressForMatch(p.address);
    if (key && !byAddress.has(key)) byAddress.set(key, p.id);
  }

  for (const pin of pins) {
    // Address if the tagger geocoded it; otherwise the nearest known roof.
    const addrHit = pin.address ? byAddress.get(normalizeAddressForMatch(pin.address)) : undefined;
    const geoHit = addrHit ? undefined : nearestWithin({ lat: pin.lat, lng: pin.lng }, props, radius);
    const matchedId = addrHit ?? geoHit?.id ?? null;

    let propertyId: string;
    if (matchedId) {
      propertyId = matchedId;
      if (pin.materialTag) {
        await setPropertyRoofMaterial(tenantId, {
          propertyId, material: pin.materialTag as RoofMaterial, source: "spotter", confidence: SPOTTER_CONFIDENCE,
        });
      }
      result.matched += 1;
    } else {
      propertyId = await withTenant(tenantId, async (tx) => {
        const [row] = await tx.insert(property).values({
          tenantId,
          address: pin.address ?? `Tagged roof @ ${pin.lat.toFixed(5)},${pin.lng.toFixed(5)}`,
          lat: pin.lat,
          lng: pin.lng,
          roofMaterial: pin.materialTag,
          roofMaterialSource: pin.materialTag ? "spotter" : null,
          roofMaterialConfidence: pin.materialTag ? SPOTTER_CONFIDENCE : null,
        }).returning({ id: property.id });
        return row!.id;
      });
      // Keep the in-run indexes current so a second pin at the same spot matches.
      props.push({ id: propertyId, address: pin.address ?? "", lat: pin.lat, lng: pin.lng });
      if (pin.address) byAddress.set(normalizeAddressForMatch(pin.address), propertyId);
      result.created += 1;
    }

    // Persist the pin itself, idempotent on (tenant, external_id).
    await withTenant(tenantId, (tx) => tx.insert(spotterPin).values({
      tenantId, externalId: pin.externalId, lat: pin.lat, lng: pin.lng,
      materialTag: pin.materialTag, hasDebris: pin.hasDebris, spotterName: pin.spotterName,
      taggedAt: pin.taggedAt, syncedAt: new Date(), matchedPropertyId: propertyId,
    }).onConflictDoUpdate({
      target: [spotterPin.tenantId, spotterPin.externalId],
      set: {
        lat: pin.lat, lng: pin.lng, materialTag: pin.materialTag, hasDebris: pin.hasDebris,
        spotterName: pin.spotterName, taggedAt: pin.taggedAt, syncedAt: new Date(), matchedPropertyId: propertyId,
      },
    }));
  }
  return result;
}
