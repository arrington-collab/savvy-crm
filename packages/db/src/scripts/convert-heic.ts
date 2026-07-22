// One-time: convert imported HEIC photos (which neither jimp nor browsers can
// display) to JPEG, in place. For each kind='photo' mime='image/heic' document:
// download the HEIC from R2, decode → re-encode JPEG (heic-convert / libheif),
// overwrite the same R2 object with the JPEG bytes, and set mime='image/jpeg'
// (+ rewrite a .heic filename to .jpg). Idempotent: re-running skips anything
// already flipped to image/jpeg. After this, they behave like every other photo
// (server-side downscale + <img> render).
//
//   DATABASE_ADMIN_URL=… R2_* (or S3_*) env … tsx src/scripts/convert-heic.ts [--dry]

// heic-convert ships no type declarations (one-time ops script).
// @ts-expect-error - no @types for heic-convert
import convert from "heic-convert";
import { adminDb, document, and, eq } from "..";
import { r2Storage } from "@savvy/integrations";

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const rows = await adminDb
    .select({ id: document.id, r2Key: document.r2Key, filename: document.filename })
    .from(document)
    .where(and(eq(document.kind, "photo"), eq(document.mime, "image/heic")));

  console.log(`${rows.length} HEIC photos to convert${dry ? " (dry run)" : ""}`);
  let ok = 0, skipped = 0, failed = 0;

  for (const r of rows) {
    if (!r.r2Key) { skipped++; console.log(`- skip (no r2Key): ${r.filename}`); continue; }
    try {
      const { url } = await r2Storage.presignDownload({ key: r.r2Key });
      const res = await fetch(url);
      if (!res.ok) throw new Error(`R2 download ${res.status}`);
      const heic = Buffer.from(await res.arrayBuffer());
      const jpeg = (await convert({ buffer: heic, format: "JPEG", quality: 0.85 })) as Buffer;
      const newName = r.filename ? r.filename.replace(/\.heic$/i, ".jpg") : r.filename;
      if (dry) { console.log(`~ would convert ${r.filename} (${Math.round(heic.length / 1024)}KB → ${Math.round(jpeg.length / 1024)}KB)`); ok++; continue; }
      await r2Storage.putObject({ key: r.r2Key, bytes: new Uint8Array(jpeg), contentType: "image/jpeg" });
      await adminDb.update(document).set({ mime: "image/jpeg", filename: newName }).where(eq(document.id, r.id));
      ok++;
      console.log(`✓ ${r.filename} (${Math.round(heic.length / 1024)}KB → ${Math.round(jpeg.length / 1024)}KB)`);
    } catch (e) {
      failed++;
      console.log(`✗ ${r.filename}: ${(e as Error).message}`);
    }
  }
  console.log(`done — ${ok} converted, ${skipped} skipped, ${failed} failed`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
