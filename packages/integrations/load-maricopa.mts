/**
 * Maricopa County sold-home loader — the legitimate replacement for the Redfin
 * scrape, for Maricopa County only.
 *
 * Everything it touches is a free, public, no-auth county source, over plain
 * HTTP. That matters twice over: it is not a terms-of-service breach, and
 * unlike the Redfin pull it needs no signed-in browser, so it can run on a
 * schedule in the cloud instead of only when a laptop is awake.
 *
 *   Sales:      Assessor "Sales Affidavits" bulk file (address + price, no
 *               coordinates and no MLS number).
 *   Coordinates: the county's own Address Points service, matched on
 *               address+zip. Measured 99% match on recent sales.
 *
 * Usage:
 *   TENANT_KEY=pk-... CANVASS_SOLD_INGEST_TOKEN=... npx tsx load-maricopa.mts
 *     --days 45     how far back to load (default 45)
 *     --dry         parse, geocode and report; write nothing
 *     --file <path> use an already-downloaded Sales_Affidavits.txt
 *
 * Freshness, measured 2026-09-13: the newest deed date in the file was 18 days
 * old and volume only becomes meaningful ~21 days back, versus a ~10-day median
 * for the listing feed. Knock data showed the same win rate on 0-20 day homes
 * as on 21-44 day homes, so that lag costs conversion nothing — but it does
 * mean this feed cannot supply the freshest window on its own.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SALES_ZIP =
  "https://www.arcgis.com/sharing/rest/content/items/f3484c72a938497286adc4e5de7e9963/data";
const ADDR_PTS =
  "https://services.arcgis.com/ykpntM6e3tHvzKRJ/arcgis/rest/services/Maricopa_County_Address_Points/FeatureServer/0/query";

const args = process.argv.slice(2);
const flag = (n: string, d: string | null = null) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const dry = args.includes("--dry");
const days = Number(flag("days", "45"));
const localFile = flag("file");

const token = process.env.CANVASS_SOLD_INGEST_TOKEN;
const key = process.env.TENANT_KEY;
const api = process.env.CANVASS_API ?? "https://savvy-crm.vercel.app/api/canvass/sold/ingest";
if (!token || !key) throw new Error("CANVASS_SOLD_INGEST_TOKEN and TENANT_KEY are required");

// ── 1. the sales file ──────────────────────────────────────────────────────
let text: string;
if (localFile && existsSync(localFile)) {
  text = readFileSync(localFile, "utf8");
  console.log(`using local file ${localFile}`);
} else {
  const dir = mkdtempSync(join(tmpdir(), "mc-sales-"));
  const zip = join(dir, "sales.zip");
  console.log("downloading Maricopa Sales Affidavits (~61MB)…");
  execFileSync("curl", ["-sL", "-o", zip, SALES_ZIP]);
  execFileSync("unzip", ["-o", "-q", zip, "-d", dir]);
  text = readFileSync(join(dir, "Data", "Sales_Affidavits.txt"), "utf8");
}

// ── 2. parse (pipe-delimited) and filter ───────────────────────────────────
const lines = text.split("\n");
const header = (lines[0] ?? "").trim().split("|");
const col = (name: string) => {
  const i = header.indexOf(name);
  if (i === -1) throw new Error(`column ${name} missing — the county changed the file format`);
  return i;
};
const C = {
  type: col("PROPERTYTYPEDESCRIPTION"),
  deed: col("DEEDDATE_MMDDYYYY"),
  price: col("SALEPRICE"),
  addr: col("SITUSADDRESS"),
  city: col("SITUSCITY"),
  zip: col("SITUSZIP"),
};

const today = new Date();
const cutoff = new Date(today.getTime() - days * 864e5);
type Row = { address: string; city: string; zip: string; soldDate: string; price: number | null };
const byAddrKey = new Map<string, Row>();
let scanned = 0, skipped = 0;

for (let i = 1; i < lines.length; i++) {
  const f = lines[i].split("|");
  if (f.length < header.length) { skipped++; continue; }
  scanned++;
  if (!(f[C.type] ?? "").includes("Single Family")) { skipped++; continue; }
  const dd = (f[C.deed] ?? "").trim();                       // MMDDYYYY, no separators
  if (dd.length !== 8) { skipped++; continue; }
  const d = new Date(+dd.slice(4), +dd.slice(0, 2) - 1, +dd.slice(2, 4));
  // Junk future dates (2094/2098/2099) live in this file; so do old resales.
  if (isNaN(d.getTime()) || d > today || d < cutoff) { skipped++; continue; }
  const address = (f[C.addr] ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  const zip = (f[C.zip] ?? "").trim().slice(0, 5);
  if (!address || !zip) { skipped++; continue; }
  const price = Number((f[C.price] ?? "").replace(/[^0-9]/g, "")) || null;
  // The file holds the LAST sale per parcel, but a resale can still appear
  // twice across parcels sharing an address; keep the most recent.
  const k = `${address} ${zip}`;
  const prev = byAddrKey.get(k);
  const iso = d.toISOString().slice(0, 10);
  if (!prev || prev.soldDate < iso) {
    byAddrKey.set(k, { address, city: (f[C.city] ?? "").trim(), zip, soldDate: iso, price });
  }
}
console.log(`scanned ${scanned.toLocaleString()} rows -> ${byAddrKey.size} single-family sales in the last ${days} days (skipped ${skipped.toLocaleString()})`);
if (!byAddrKey.size) throw new Error("no sales parsed — refusing to report an empty run");

// ── 3. coordinates, from the county's own address points ───────────────────
const keys = [...byAddrKey.keys()];
const coords = new Map<string, { lat: number; lng: number }>();
const BATCH = 100;
for (let i = 0; i < keys.length; i += BATCH) {
  const chunk = keys.slice(i, i + BATCH);
  const inList = chunk.map((a) => `'${a.replace(/'/g, "''")}'`).join(",");
  const body = new URLSearchParams({
    where: `AddressWithZip IN (${inList})`,
    outFields: "AddressWithZip",
    returnGeometry: "true",
    outSR: "4326",
    f: "json",
    resultRecordCount: "1000",
  });
  const res = await fetch(ADDR_PTS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) { console.warn(`  geocode batch ${i / BATCH} failed: ${res.status}`); continue; }
  const j = (await res.json()) as { features?: { attributes: Record<string, string>; geometry: { x: number; y: number } }[] };
  for (const ft of j.features ?? []) {
    const a = ft.attributes.AddressWithZip;
    if (a && !coords.has(a)) coords.set(a, { lat: ft.geometry.y, lng: ft.geometry.x });
  }
  process.stdout.write(`\r  geocoded ${Math.min(i + BATCH, keys.length)}/${keys.length}`);
}
console.log(`\nmatched coordinates for ${coords.size}/${keys.length} (${Math.round((coords.size / keys.length) * 100)}%)`);

const rows = keys.flatMap((k) => {
  const c = coords.get(k), r = byAddrKey.get(k)!;
  if (!c) return [];
  return [{
    mls: null,                       // the county file has none — dedupe is on address
    address: r.address,
    city: r.city || null,
    state: "AZ",
    zip: r.zip,
    lat: c.lat,
    lng: c.lng,
    soldDate: r.soldDate,
    price: r.price,
    propertyType: "Single Family Residential",
  }];
});

// ── 4. ingest (the endpoint caps a request at 5,000 rows) ──────────────────
console.log(`\nsending ${rows.length} rows${dry ? " (dry run)" : ""}`);
for (let i = 0; i < rows.length; i += 5000) {
  const slice = rows.slice(i, i + 5000);
  const res = await fetch(api, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ key, rows: slice, ...(dry ? { dryRun: true } : {}) }),
  });
  console.log(`ingest ${res.status}:`, await res.text());
}
