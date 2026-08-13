/**
 * One-off loader: parse the week's Redfin price-band exports and POST them to
 * the canvass sold-listing ingest endpoint.
 *
 * Usage:
 *   CANVASS_SOLD_INGEST_TOKEN=... TENANT_KEY=... npx tsx load-sold.mts <csv...>
 *   add --dry to preview without writing.
 */
import { readFileSync } from "node:fs";
import { parseSoldCsv, dedupeSoldRows } from "./src/sold-feed";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const files = args.filter((a) => !a.startsWith("--"));

const token = process.env.CANVASS_SOLD_INGEST_TOKEN;
const key = process.env.TENANT_KEY;
const api = process.env.CANVASS_API ?? "https://savvy-crm.vercel.app/api/canvass/sold/ingest";
if (!token || !key) throw new Error("CANVASS_SOLD_INGEST_TOKEN and TENANT_KEY are required");

let all: Awaited<ReturnType<typeof parseSoldCsv>>["rows"] = [];
let skipped = 0;

for (const f of files) {
  const { rows, skipped: s } = parseSoldCsv(readFileSync(f, "utf8"));
  skipped += s;
  all = all.concat(rows);
  console.log(`  ${f.split("/").pop()}  parsed=${rows.length} skipped=${s}`);
}

const deduped = dedupeSoldRows(all);
console.log(`\nparsed ${all.length} rows across ${files.length} bands`);
console.log(`skipped ${skipped} (non-residential / missing coords / MLS disclaimer line)`);
console.log(`deduped ${all.length} -> ${deduped.length} (removed ${all.length - deduped.length} cross-band duplicates)`);

const res = await fetch(api, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ key, rows: deduped, ...(dry ? { dryRun: true } : {}) }),
});
console.log(`\ningest ${res.status}:`, await res.text());
