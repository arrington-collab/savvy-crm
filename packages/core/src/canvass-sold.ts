import { z } from "zod";

// "Recently Sold" pins for the canvass field app — homes that changed hands in
// the last week, dropped on the map so reps can reach new homeowners early.
// This module is the pure domain layer: identity, eligibility, expiry, config.
// Feed parsing lives in @savvy/integrations (sold-feed), the workflow in
// @savvy/agents (sold-import).

/** Property types worth knocking. Anything else (land, commercial) is dropped. */
const RESIDENTIAL_TYPES = [
  "single family residential",
  "townhouse",
  "condo/co-op",
  "mobile/manufactured home",
  "multi-family",
] as const;

export function isResidentialType(propertyType: string | null | undefined): boolean {
  if (!propertyType) return false;
  const t = propertyType.trim().toLowerCase();
  if (!t) return false;
  // Prefix match: the feed writes "Multi-Family (2-4 Unit)" and similar
  // parenthetical variants that would miss an exact comparison.
  return RESIDENTIAL_TYPES.some((r) => t.startsWith(r));
}

/**
 * Stable identity for a sold home, and the whole idempotency story: it backs
 * the unique (tenant, source, dedupeKey) index, so overlapping weekly pulls and
 * re-runs insert only genuinely new homes.
 *
 * MLS wins when present. Otherwise address+zip, normalized so the same house
 * arriving with different formatting ("123 Main St." vs "123  MAIN ST") lands
 * on one row rather than accumulating a duplicate every week.
 */
export function soldDedupeKey(row: {
  mls?: string | null;
  address: string;
  zip?: string | null;
}): string {
  const mls = (row.mls ?? "").trim().toUpperCase();
  if (mls) return `mls:${mls}`;
  const address = row.address
    .trim()
    .toUpperCase()
    .replace(/[.,]/g, "")      // "St." and "St" are the same street
    .replace(/\s+/g, " ");     // collapse runs of whitespace
  const zip = (row.zip ?? "").trim().toUpperCase();
  return `addr:${address}|${zip}`;
}

/**
 * The date a pin disappears: sale date + the tenant's window.
 *
 * Deliberately string-in/string-out over UTC. Using local-time Date parsing
 * would shift every expiry by a day for anyone west of UTC — which is every
 * user of this feature.
 */
export function soldExpiresAt(soldDate: string, expiryDays: number): string {
  const d = new Date(`${soldDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid soldDate: ${soldDate}`);
  d.setUTCDate(d.getUTCDate() + expiryDays);
  return d.toISOString().slice(0, 10);
}

/** Per-tenant feed settings, stored on tenant.settings.canvassSold. */
export interface SoldConfig {
  enabled: boolean;
  regionId: number;   // Redfin region id — Maricopa County = 220
  regionType: number; // Redfin region type — county = 5
  expiryDays: number;
}

export const DEFAULT_SOLD_CONFIG: SoldConfig = {
  enabled: false, // opt-in: existing tenants must not silently start collecting
  regionId: 220,
  regionType: 5,
  expiryDays: 90,
};

const soldConfigSchema = z.object({
  enabled: z.boolean().optional(),
  regionId: z.number().int().positive().optional(),
  regionType: z.number().int().positive().optional(),
  expiryDays: z.number().int().positive().max(365).optional(),
});

/**
 * Read the feed config off tenant.settings, falling back to defaults field by
 * field. Malformed values fall back rather than propagate — a bad expiryDays
 * should not be able to delete every pin or keep stale ones forever.
 */
export function soldConfigFrom(settings: Record<string, unknown> | null | undefined): SoldConfig {
  const raw = (settings ?? {})["canvassSold"];
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SOLD_CONFIG };
  const parsed = soldConfigSchema.safeParse(raw);
  if (!parsed.success) return { ...DEFAULT_SOLD_CONFIG };
  return { ...DEFAULT_SOLD_CONFIG, ...stripUndefined(parsed.data) };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** One normalized sold home, as accepted by the ingest endpoint. */
export const canvassSoldRowObject = z.object({
  mls: z.string().max(60).nullish(),
  address: z.string().min(1).max(300),
  city: z.string().max(120).nullish(),
  state: z.string().max(20).nullish(),
  zip: z.string().max(20).nullish(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  soldDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  price: z.number().int().nonnegative().nullish(),
  propertyType: z.string().max(120).nullish(),
  beds: z.number().int().nonnegative().nullish(),
  baths: z.number().nonnegative().nullish(),
  sqft: z.number().int().nonnegative().nullish(),
  yearBuilt: z.number().int().nullish(),
  url: z.string().max(600).nullish(),
});
export type CanvassSoldRow = z.infer<typeof canvassSoldRowObject>;

/** POST /api/canvass/sold/ingest body. */
export const canvassSoldIngestObject = z.object({
  key: z.string().min(1),      // tenant publicKey
  rows: z.array(canvassSoldRowObject).max(5000),
  dryRun: z.boolean().optional(),
});
