import { isResidentialType, soldDedupeKey, type CanvassSoldRow } from "@savvy/core";

// Parsing for the "Recently Sold" feed. Source-agnostic on purpose: the Redfin
// GIS CSV export, a county records extract, or a paid provider all reduce to
// the same normalized rows, so swapping sources never touches the workflow.
//
// The export already carries lat/lng, so nothing here geocodes.

/**
 * Raised when input arrived but nothing recognizable came out.
 *
 * This exists because the dangerous failure is the silent one: if the source
 * renames its columns, a naive parser yields zero rows, the upsert writes
 * nothing, and the job reports success while pins quietly stop appearing for
 * weeks. Bytes in + no recognizable header = loud failure, every time.
 */
export class SoldFeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SoldFeedParseError";
  }
}

/** Header aliases, so a cosmetic rename doesn't take the feed down. */
const COLUMNS: Record<keyof ColumnMap, string[]> = {
  soldDate: ["sold date", "solddate", "sale date", "close date"],
  propertyType: ["property type", "propertytype", "type"],
  address: ["address", "street address"],
  city: ["city"],
  state: ["state or province", "state"],
  zip: ["zip or postal code", "zip", "zip code", "postal code"],
  price: ["price", "sold price", "sale price"],
  beds: ["beds", "bedrooms"],
  baths: ["baths", "bathrooms"],
  sqft: ["square feet", "sqft", "square footage"],
  yearBuilt: ["year built", "yearbuilt"],
  mls: ["mls#", "mls", "mls number", "listing id"],
  lat: ["latitude", "lat"],
  lng: ["longitude", "lng", "long"],
  url: ["url", "listing url", "link"],
};

interface ColumnMap {
  soldDate: number; propertyType: number; address: number; city: number; state: number;
  zip: number; price: number; beds: number; baths: number; sqft: number; yearBuilt: number;
  mls: number; lat: number; lng: number; url: number;
}

/** Minimal RFC-4180 split: honours quoted fields and doubled quotes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function num(v: string | undefined): number | null {
  if (v == null) return null;
  const cleaned = v.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function int(v: string | undefined): number | null {
  const n = num(v);
  return n == null ? null : Math.trunc(n);
}

function str(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  return s ? s : null;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** Redfin writes "May-4-2026"; ISO is also accepted. Returns YYYY-MM-DD. */
export function normalizeSoldDate(raw: string | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^([A-Za-z]{3,})-(\d{1,2})-(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
    if (mo) return `${m[3]}-${mo}-${m[2]!.padStart(2, "0")}`;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function buildColumnMap(header: string[]): ColumnMap | null {
  const normalized = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, " "));
  const map = {} as ColumnMap;
  for (const [field, aliases] of Object.entries(COLUMNS) as [keyof ColumnMap, string[]][]) {
    map[field] = normalized.findIndex((h) => aliases.includes(h));
  }
  // Without these four a row cannot become a usable pin, so an input lacking
  // them is a broken feed rather than an empty one.
  const required: (keyof ColumnMap)[] = ["address", "soldDate", "lat", "lng"];
  return required.every((f) => map[f] >= 0) ? map : null;
}

export interface ParsedSoldFeed {
  rows: CanvassSoldRow[];
  /** Rows dropped as non-residential or missing required fields. Never silent. */
  skipped: number;
}

export function parseSoldCsv(text: string): ParsedSoldFeed {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new SoldFeedParseError("empty feed — no lines");

  const map = buildColumnMap(splitCsvLine(lines[0]!));
  if (!map) {
    throw new SoldFeedParseError(
      "unrecognized header — the feed format likely changed; refusing to report an empty week",
    );
  }

  const rows: CanvassSoldRow[] = [];
  let skipped = 0;

  for (const line of lines.slice(1)) {
    const c = splitCsvLine(line);
    const at = (i: number) => (i >= 0 ? c[i] : undefined);

    const address = str(at(map.address));
    const lat = num(at(map.lat));
    const lng = num(at(map.lng));
    const soldDate = normalizeSoldDate(at(map.soldDate));
    const propertyType = str(at(map.propertyType));

    if (!address || lat == null || lng == null || !soldDate) { skipped++; continue; }
    if (!isResidentialType(propertyType)) { skipped++; continue; }

    rows.push({
      mls: str(at(map.mls)),
      address,
      city: str(at(map.city)),
      state: str(at(map.state)),
      zip: str(at(map.zip)),
      lat, lng, soldDate,
      price: int(at(map.price)),
      propertyType,
      beds: int(at(map.beds)),
      baths: num(at(map.baths)),
      sqft: int(at(map.sqft)),
      yearBuilt: int(at(map.yearBuilt)),
      url: str(at(map.url)),
    });
  }

  return { rows, skipped };
}

export interface PriceBand { min: number; max: number | null }

/**
 * Tiling windows for the pull. A single export is capped near 350 rows while
 * the county sells ~700-900 a week, so one request silently truncates. Bands
 * are contiguous — each min equals the previous max — and the last is
 * open-ended so nothing above the top bound is lost.
 */
export function priceBands(): PriceBand[] {
  return [
    { min: 0, max: 300_000 },
    { min: 300_000, max: 400_000 },
    { min: 400_000, max: 500_000 },
    { min: 500_000, max: 750_000 },
    { min: 750_000, max: null },
  ];
}

/** Collapse rows that appear in more than one tile. First occurrence wins. */
export function dedupeSoldRows(rows: CanvassSoldRow[]): CanvassSoldRow[] {
  const seen = new Set<string>();
  const out: CanvassSoldRow[] = [];
  for (const r of rows) {
    const key = soldDedupeKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
