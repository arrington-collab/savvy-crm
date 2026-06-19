import { adminDb, property, eq, isNull, and } from "../index";
import { parseCityFromAddress } from "@savvy/core";

/** One-time: fill property.city for rows where it's null, parsing the address. Idempotent. */
async function main() {
  const rows = await adminDb.select({ id: property.id, address: property.address }).from(property).where(isNull(property.city));
  let updated = 0;
  for (const r of rows) {
    const city = parseCityFromAddress(r.address);
    if (city) {
      await adminDb.update(property).set({ city }).where(and(eq(property.id, r.id), isNull(property.city)));
      updated++;
    }
  }
  console.log(`backfill-city: scanned ${rows.length}, set ${updated}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
