import { NextResponse } from "next/server";
import { canvassSoldIngestObject, soldConfigFrom, soldDedupeKey, soldExpiresAt } from "@savvy/core";
import { withTenant, canvassSoldListing, eq, and, lt, sql } from "@savvy/db";
import { tenantByKey } from "@/lib/intake";
import { canvassCors } from "@/lib/canvass-cors";
import { log } from "@/lib/log";

export const runtime = "nodejs";
// A full weekly county pull is a few thousand rows across five price bands.
export const maxDuration = 120;

const SOURCE = "redfin_recently_sold";

// POST /api/canvass/sold/ingest — accepts already-parsed "recently sold" rows
// and upserts them, then prunes anything past its expiry.
//
// Authenticated by a shared ingest token, NOT a rep session: this is
// machine-to-machine (a scheduled browser task posting the week's export), so
// there is no logged-in rep to attribute it to. The tenant is resolved from its
// publicKey, same as the other canvass intake routes.
//
// Idempotent by construction: onConflictDoNothing against
// (tenant, source, dedupeKey) means overlapping weeks and re-runs insert only
// genuinely new homes. Rep pins live in canvass_knock and are never touched.
export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "POST, OPTIONS") });
}

export async function POST(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const expected = process.env.CANVASS_SOLD_INGEST_TOKEN;
  if (!expected) return reply({ error: "ingest not configured" }, 503);
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!provided || provided !== expected) return reply({ error: "unauthorized" }, 401);

  let json: unknown;
  try { json = await req.json(); } catch { return reply({ error: "invalid json" }, 400); }

  const parsed = canvassSoldIngestObject.safeParse(json);
  if (!parsed.success) return reply({ error: parsed.error.flatten() }, 400);
  const { key, rows, dryRun } = parsed.data;

  const t = await tenantByKey(key);
  if (!t) return reply({ error: "unknown tenant" }, 404);

  const cfg = soldConfigFrom(t.settings ?? {});
  if (!cfg.enabled) return reply({ error: "sold feed disabled for this tenant" }, 409);

  // Bytes arrived but nothing usable came out — treat as a broken feed, not a
  // quiet week. Reporting inserted:0 here is exactly the silent failure this
  // design exists to prevent.
  if (rows.length === 0) {
    return reply({ error: "no rows supplied — refusing to report an empty run" }, 400);
  }

  const values = rows.map((r) => ({
    tenantId: t.id,
    mls: r.mls ?? null,
    address: r.address,
    city: r.city ?? null,
    state: r.state ?? null,
    zip: r.zip ?? null,
    lat: r.lat,
    lng: r.lng,
    soldDate: r.soldDate,
    price: r.price ?? null,
    propertyType: r.propertyType ?? null,
    beds: r.beds ?? null,
    baths: r.baths == null ? null : String(r.baths),
    sqft: r.sqft ?? null,
    yearBuilt: r.yearBuilt ?? null,
    url: r.url ?? null,
    source: SOURCE,
    dedupeKey: soldDedupeKey(r),
    expiresAt: soldExpiresAt(r.soldDate, cfg.expiryDays),
  }));

  const result = await withTenant(t.id, async (tx) => {
    if (dryRun) {
      const keys = values.map((v) => v.dedupeKey);
      const existing = await tx
        .select({ dedupeKey: canvassSoldListing.dedupeKey })
        .from(canvassSoldListing)
        .where(
          and(
            eq(canvassSoldListing.tenantId, t.id),
            eq(canvassSoldListing.source, SOURCE),
            sql`${canvassSoldListing.dedupeKey} = ANY(${keys})`,
          ),
        );
      const have = new Set(existing.map((e) => e.dedupeKey));
      const stale = await tx
        .select({ id: canvassSoldListing.id })
        .from(canvassSoldListing)
        .where(
          and(
            eq(canvassSoldListing.tenantId, t.id),
            eq(canvassSoldListing.source, SOURCE),
            lt(canvassSoldListing.expiresAt, sql`CURRENT_DATE`),
          ),
        );
      return {
        dryRun: true,
        scanned: values.length,
        wouldInsert: values.filter((v) => !have.has(v.dedupeKey)).length,
        wouldPrune: stale.length,
      };
    }

    const inserted = await tx
      .insert(canvassSoldListing)
      .values(values)
      .onConflictDoNothing({
        target: [canvassSoldListing.tenantId, canvassSoldListing.source, canvassSoldListing.dedupeKey],
      })
      .returning({ id: canvassSoldListing.id });

    // Prune runs inside the same call so expiry never depends on a separate
    // job having succeeded. The weekly cron prunes too, for weeks with no pull.
    const pruned = await tx
      .delete(canvassSoldListing)
      .where(
        and(
          eq(canvassSoldListing.tenantId, t.id),
          eq(canvassSoldListing.source, SOURCE),
          lt(canvassSoldListing.expiresAt, sql`CURRENT_DATE`),
        ),
      )
      .returning({ id: canvassSoldListing.id });

    return {
      dryRun: false,
      scanned: values.length,
      inserted: inserted.length,
      skipped: values.length - inserted.length, // already present
      pruned: pruned.length,
    };
  });

  log.info("canvass.sold.ingest", { tenantId: t.id, ...result });
  return reply(result, 200);
}
