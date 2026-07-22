// Pre-generate the photo width variants (192 + 1600) so the view route streams
// ready-made bytes with no request-time resize. Runs OFFLINE with sharp (native
// libvips) — the resize never touches the Vercel function. For each photo with
// thumbs_ready=false: download the original from R2, sharp-resize to each width,
// putObject the variant at photoVariantKey(...), and flip thumbs_ready=true.
// Idempotent: re-running skips anything already flagged. --dry lists without writing.
//
//   DATABASE_ADMIN_URL=… R2_* env … tsx src/scripts/pregenerate-thumbnails.ts [--dry] [--limit=N]

import sharp from "sharp";
import { adminDb, document, and, eq, isNotNull } from "..";
import { photoVariantKey, PHOTO_VARIANT_WIDTHS } from "@savvy/core";
import { r2Storage } from "@savvy/integrations";

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;

  let rows = await adminDb
    .select({ id: document.id, r2Key: document.r2Key })
    .from(document)
    .where(and(eq(document.kind, "photo"), eq(document.thumbsReady, false), isNotNull(document.r2Key)));
  if (limit) rows = rows.slice(0, limit);

  console.log(`${rows.length} photos need variants${dry ? " (dry run)" : ""}`);
  let ok = 0, failed = 0;

  for (const r of rows) {
    if (!r.r2Key) continue;
    try {
      const { url } = await r2Storage.presignDownload({ key: r.r2Key });
      const res = await fetch(url);
      if (!res.ok) throw new Error(`R2 download ${res.status}`);
      const original = Buffer.from(await res.arrayBuffer());

      for (const w of PHOTO_VARIANT_WIDTHS) {
        const out = await sharp(original)
          .rotate() // honour EXIF orientation
          .resize({ width: w, withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        if (!dry) await r2Storage.putObject({ key: photoVariantKey(r.r2Key, w), bytes: new Uint8Array(out), contentType: "image/jpeg" });
      }
      if (!dry) await adminDb.update(document).set({ thumbsReady: true }).where(eq(document.id, r.id));
      ok++;
      if (ok % 100 === 0) console.log(`… ${ok}/${rows.length}`);
    } catch (e) {
      failed++;
      console.log(`✗ ${r.id}: ${(e as Error).message}`);
    }
  }
  console.log(`done — ${ok} generated, ${failed} failed`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
