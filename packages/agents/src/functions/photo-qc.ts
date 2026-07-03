import { Jimp } from "jimp";
import {
  getPhotoForQc, getJobPhotoHashes, setPhotoQc, withTenant, tenant, eq,
} from "@savvy/db";
import {
  dHash, hammingDistance, assessPhotoQc, parsePhotoQcConfig, z,
  type PhotoQcVision, type PhotoQcVerdict,
} from "@savvy/core";
import { classifyImage } from "@savvy/ai";
import { r2Storage } from "@savvy/integrations";
import { inngest } from "../client";

export type PhotoQcResult = {
  qcStatus: "passed" | "flagged" | "skipped";
  phash: string | null;
  reasons: unknown;
};

/**
 * Decode image bytes → 9×8 grayscale matrix (rows of 9 red-channel values) for the
 * pure `dHash` in @savvy/core. jimp v1: `Jimp.read(Buffer)`, `resize({w,h})`, `greyscale()`
 * are mutating; after greyscale R=G=B so we read the red channel at stride 4.
 */
async function toGray9x8(bytes: Uint8Array): Promise<number[][]> {
  const img = await Jimp.read(Buffer.from(bytes));
  img.resize({ w: 9, h: 8 }).greyscale();
  const { data } = img.bitmap;
  const rows: number[][] = [];
  for (let y = 0; y < 8; y++) {
    const row: number[] = [];
    for (let x = 0; x < 9; x++) row.push(data[(y * 9 + x) * 4]!);
    rows.push(row);
  }
  return rows;
}

/**
 * Testable core of photo QC with injected side-effects. Fetches bytes → decodes to a
 * 9×8 grayscale matrix → `dHash` → nearest same-job hash within `dupeMaxDistance` ⇒
 * `duplicateOf` → vision `classify` → `assessPhotoQc` verdict → persist via `setPhotoQc`.
 * FAIL-SOFT: any thrown error → persist `qcStatus:"skipped"` and return skipped (never throws).
 */
export async function runPhotoQc(deps: {
  tenantId: string;
  documentId: string;
  jobId: string;
  fetchBytes: (key: string) => Promise<Uint8Array>;
  classify: (bytes: Uint8Array, label: string | null) => Promise<PhotoQcVision>;
  cfg: { dupeMaxDistance: number };
}): Promise<PhotoQcResult> {
  const { tenantId, documentId, jobId, fetchBytes, classify, cfg } = deps;
  try {
    const photo = await getPhotoForQc({ tenantId, documentId });
    if (!photo || !photo.r2Key) {
      await setPhotoQc({ tenantId, documentId, phash: null, qcStatus: "skipped", qcReasons: {} });
      return { qcStatus: "skipped", phash: null, reasons: {} };
    }

    const bytes = await fetchBytes(photo.r2Key);
    const gray = await toGray9x8(bytes);
    const phash = dHash(gray);

    // Nearest existing same-job photo within the dedup threshold.
    const siblings = await getJobPhotoHashes({ tenantId, jobId, excludeDocumentId: documentId });
    let duplicateOf: string | null = null;
    let best = Infinity;
    for (const s of siblings) {
      const d = hammingDistance(phash, s.phash);
      if (d <= cfg.dupeMaxDistance && d < best) {
        best = d;
        duplicateOf = s.documentId;
      }
    }

    const vision = await classify(bytes, photo.label);
    const verdict: PhotoQcVerdict = assessPhotoQc({ vision, duplicateOf });
    const qcStatus = verdict.flagged ? "flagged" : "passed";

    await setPhotoQc({ tenantId, documentId, phash, qcStatus, qcReasons: verdict.reasons });
    return { qcStatus, phash, reasons: verdict.reasons };
  } catch {
    // Fail-soft: a decode/model/fetch error must not block ingestion or throw.
    await setPhotoQc({ tenantId, documentId, phash: null, qcStatus: "skipped", qcReasons: {} }).catch(() => {});
    return { qcStatus: "skipped", phash: null, reasons: {} };
  }
}

const visionSchema = z.object({
  usable: z.boolean(),
  quality: z.enum(["ok", "blurry", "dark", "obstructed"]),
  depictsCategory: z.boolean(),
  reason: z.string(),
});

/** Read one tenant's photo-QC config from settings.photoQc. */
async function loadPhotoQcConfig(tenantId: string) {
  const [t] = await withTenant(tenantId, (tx) =>
    tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId)),
  );
  const settings = (t?.settings ?? {}) as { photoQc?: unknown };
  return parsePhotoQcConfig(settings.photoQc);
}

/**
 * `photo/ingested` → per-photo vision usability/subject QC + dHash dedup within the job.
 * HAND-OFF CONTRACT: skip photos with no job (jobId===null) — they live in the unmatched
 * tray until manually matched. Config-gated per tenant; the QC step is itself fail-soft.
 */
export const photoQc = inngest.createFunction(
  { id: "photo-qc", concurrency: { limit: 5 } },
  { event: "photo/ingested" },
  async ({ event, step }) => {
    const { tenantId, documentId, jobId } = event.data;
    if (jobId == null) return { skipped: "no_job" };

    const cfg = await step.run("load-config", () => loadPhotoQcConfig(tenantId));
    if (!cfg.enabled) return { skipped: "disabled" };

    return step.run("qc", () =>
      runPhotoQc({
        tenantId,
        documentId,
        jobId,
        cfg: { dupeMaxDistance: cfg.dupeMaxDistance },
        fetchBytes: async (key) => {
          const { url } = await r2Storage.presignDownload({ key });
          const res = await fetch(url);
          if (!res.ok) throw new Error(`fetch ${res.status}`);
          return new Uint8Array(await res.arrayBuffer());
        },
        classify: async (bytes, label) => {
          const { object } = await classifyImage({
            capability: "reflex",
            image: { bytes },
            schema: visionSchema,
            prompt:
              `This is a roofing job-site photo categorized as "${label ?? "unknown"}". ` +
              `Judge if it is usable (sharp, well-lit, unobstructed) and whether it depicts a ${label ?? "roof feature"}.`,
          });
          return object;
        },
      }),
    );
  },
);
