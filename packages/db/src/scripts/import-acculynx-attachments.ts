// Alta cutover, phase 2 — AccuLynx attachment import runner.
//
//   DATABASE_URL=... tsx src/scripts/import-acculynx-attachments.ts <tenantId> <exportDir> [--dry-run]
//
// exportDir is the on-disk export (~/Downloads/acculynx-export) with jobs/<guid>/
// {metadata.json, photos/*, docs/*}. --dry-run resolves + counts everything and
// touches nothing (no rows, no R2). A real run streams binaries to R2 and is
// idempotent via the import_record ledger, so a session-interrupted run resumes.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { r2Storage } from "@savvy/integrations";
import { adminDb } from "../admin-client";
import { tenant } from "../schema/tenancy";
import { importAccuLynxAttachments, type AttachmentJobBundle } from "../lifecycle/acculynx-attachments-import";

function fileForPrefix(dir: string, prefix: string): string | null {
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir).find((f) => f.startsWith(`${prefix}_`));
  return hit ? join(dir, hit) : null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const [tenantId, exportDir] = args.filter((a) => !a.startsWith("--"));
  if (!tenantId || !exportDir) {
    console.error("usage: tsx src/scripts/import-acculynx-attachments.ts <tenantId> <exportDir> [--dry-run]");
    process.exit(1);
  }

  const [t] = await adminDb.select({ id: tenant.id, name: tenant.name }).from(tenant).where(eq(tenant.id, tenantId));
  if (!t) { console.error(`tenant ${tenantId} not found`); process.exit(1); }

  const jobsDir = join(exportDir, "jobs");
  const guids = readdirSync(jobsDir).filter((d) => existsSync(join(jobsDir, d, "metadata.json")));
  console.log(`${dryRun ? "[DRY RUN] " : ""}importing attachments into "${t.name}": ${guids.length} job folders`);

  // Map each job's metadata + on-disk files → the lifecycle's bundle shape. The
  // on-disk path is resolved by fileId/id prefix (matches the exporter naming).
  const bundles: AttachmentJobBundle[] = [];
  const pathIndex = new Map<string, string>(); // "guid|relPath" → absolute path
  for (const guid of guids) {
    const jd = join(jobsDir, guid);
    const m = JSON.parse(readFileSync(join(jd, "metadata.json"), "utf8"));
    const docFiles = (m.docFiles ?? []).map((d: Record<string, unknown>) => {
      const abs = fileForPrefix(join(jd, "docs"), String(d.id));
      const relPath = `docs/${d.id}`;
      if (abs) pathIndex.set(`${guid}|${relPath}`, abs);
      return { id: d.id, folder: d.folder, name: d.name, mime: d.mime, size: d.size, relPath };
    }).filter((d: { id: unknown }) => pathIndex.has(`${guid}|docs/${d.id}`));
    const photoFiles = (m.photoFiles ?? []).map((p: Record<string, unknown>) => {
      const abs = fileForPrefix(join(jd, "photos"), String(p.fileId));
      const relPath = `photos/${p.fileId}`;
      if (abs) pathIndex.set(`${guid}|${relPath}`, abs);
      return { fileId: p.fileId, name: p.name, tags: p.tags, created: p.created, relPath };
    }).filter((p: { fileId: unknown }) => pathIndex.has(`${guid}|photos/${p.fileId}`));
    bundles.push({
      guid,
      estimates: m.estimates ?? [],
      invoices: (m.invoices?.Invoices ?? []),
      commThreads: m.comms?.threads ?? [],
      docFiles,
      photoFiles,
    });
  }

  const result = await importAccuLynxAttachments(tenantId, bundles, {
    storage: r2Storage,
    readFile: (guid, relPath) => {
      const abs = pathIndex.get(`${guid}|${relPath}`);
      return abs ? new Uint8Array(readFileSync(abs)) : null;
    },
    dryRun,
    onProgress: (d, total, guid) => console.log(`  [${d}/${total}] ${guid} committed`),
    // sharp runs here in the CLI (native, offline) — never in the app bundle.
    resizeVariant: async (bytes, width) => {
      const sharp = (await import("sharp")).default;
      const out = await sharp(Buffer.from(bytes)).rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      return new Uint8Array(out);
    },
  });

  console.log(`\n${dryRun ? "[DRY RUN] would import" : "imported"}:`);
  console.table(result);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
