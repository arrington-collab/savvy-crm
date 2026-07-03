# AI Photo QC (Slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a photo is ingested and attached to a job, run AI quality control — one vision call judging usability + subject-coverage, plus perceptual-hash near-duplicate detection — and flag bad photos into a `photo_quality` Needs-you exception.

**Architecture:** An Inngest workflow triggers on `photo/ingested` (shipped in Slice 1). It fetches the R2 bytes, computes a difference-hash (dHash) via `jimp` (decode) + a pure core hash function, compares against the job's other photo hashes, runs a `reflex`-tier vision classification through a NEW `@savvy/ai` `classifyImage`, computes a pure verdict, and writes `qc_status`/`qc_reasons`/`phash` (columns shipped in Slice 1). Flagged photos surface via a `photo_quality` exception. Pure logic (hash math, verdict, config) lives in `@savvy/core`; image decode + orchestration live in `@savvy/agents`; vision I/O in `@savvy/ai`.

**Tech Stack:** TypeScript, Vercel AI SDK **v4.3.19** (`ai` — multimodal via `messages` with `{type:'image', image}` parts), `jimp` (pure-JS image decode, NEW dep), Drizzle+Postgres (RLS), Inngest, Cloudflare R2, Vitest, pnpm monorepo.

## Global Constraints

- **Tenant isolation (non-negotiable):** every DB access via `withTenant`.
- **All AI via the gateway by capability** — use `classifyImage({ capability: "reflex", ... })`; never a hard-coded model string.
- **Fail-soft QC:** a vision or decode error must set `qc_status='skipped'` and never block ingestion or throw out of the workflow.
- **Events from apps/web only** — this slice CONSUMES `photo/ingested`; it does not emit new events (the workflow writes DB state; the exception is read from that state).
- **QC HAND-OFF CONTRACT (from Slice 1 final review):** the workflow MUST early-return when `jobId === null` (unmatched photos also emit `photo/ingested`); QC only runs on job-attached photos.
- **AI SDK v4 image part:** `{ role: "user", content: [{ type: "text", text }, { type: "image", image: <Uint8Array> }] }` — NOT the v5 `{type:"file", mediaType}` shape.
- **dHash:** 9×8 grayscale → 64-bit hash from adjacent-column comparisons; near-duplicate = Hamming distance ≤ `tenant.settings.jobs.photoQc.dupeMaxDistance` (default **10**), compared only within the same job.
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Test commands:** pure → `pnpm --filter @savvy/core vitest run <file>`; `@savvy/ai` → `pnpm --filter @savvy/ai vitest run <file>`; db/agents integration → run from the package against the local Postgres test DB.

---

### Task 1: Pure dHash + Hamming + QC config (`@savvy/core`)

**Files:**
- Create: `packages/core/src/photo-qc.ts`
- Create: `packages/core/src/photo-qc.test.ts`
- Modify: `packages/core/src/index.ts` (`export * from "./photo-qc";`)

**Interfaces:**
- Produces:
  ```ts
  dHash(gray9x8: number[][]): string          // 8 rows × 9 cols grayscale → 16-hex-char (64-bit) string
  hammingDistance(a: string, b: string): number
  parsePhotoQcConfig(raw: unknown): { enabled: boolean; dupeMaxDistance: number }  // defaults: enabled true, dupeMaxDistance 10
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/photo-qc.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { dHash, hammingDistance, parsePhotoQcConfig } from "./photo-qc";

// helper: a 8x9 matrix that strictly increases left→right so every adjacent
// comparison is "left < right" → all 64 bits 0.
const ramp = () => Array.from({ length: 8 }, () => Array.from({ length: 9 }, (_, c) => c * 10));

describe("dHash", () => {
  it("produces a 16-hex-char (64-bit) string", () => {
    expect(dHash(ramp())).toMatch(/^[0-9a-f]{16}$/);
  });
  it("is identical for identical input and differs for a changed pixel", () => {
    const a = ramp();
    expect(dHash(a)).toBe(dHash(ramp()));
    const b = ramp(); b[0] = [90, 80, 70, 60, 50, 40, 30, 20, 10]; // reverse row 0 → those bits flip
    expect(dHash(b)).not.toBe(dHash(a));
  });
});

describe("hammingDistance", () => {
  it("counts differing bits between two hex hashes", () => {
    expect(hammingDistance("0000000000000000", "0000000000000000")).toBe(0);
    expect(hammingDistance("0000000000000000", "000000000000000f")).toBe(4); // 0xf = 1111
    expect(hammingDistance("ffffffffffffffff", "0000000000000000")).toBe(64);
  });
});

describe("parsePhotoQcConfig", () => {
  it("defaults enabled true, dupeMaxDistance 10", () => {
    expect(parsePhotoQcConfig(undefined)).toEqual({ enabled: true, dupeMaxDistance: 10 });
  });
  it("respects overrides", () => {
    expect(parsePhotoQcConfig({ enabled: false, dupeMaxDistance: 4 })).toEqual({ enabled: false, dupeMaxDistance: 4 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && pnpm vitest run src/photo-qc.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/core/src/photo-qc.ts`:

```ts
import { z } from "./schemas";

/**
 * Difference hash: takes a 9-wide × 8-tall grayscale matrix (rows of 9 values).
 * For each of the 8 rows, compare 8 adjacent column pairs (col c vs c+1): bit=1
 * if left > right. 64 bits total → 16 hex chars.
 */
export function dHash(gray9x8: number[][]): string {
  let bits = "";
  for (const row of gray9x8) {
    for (let c = 0; c < row.length - 1; c++) bits += row[c]! > row[c + 1]! ? "1" : "0";
  }
  // 64 bits → 16 hex chars
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

const HEX_BITS: Record<string, number> = {};
for (let n = 0; n < 16; n++) HEX_BITS[n.toString(16)] = (n.toString(2).match(/1/g) ?? []).length;

/** Number of differing bits between two equal-length hex hash strings. */
export function hammingDistance(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    d += (x.toString(2).match(/1/g) ?? []).length;
  }
  return d;
}

const photoQcSchema = z.object({
  enabled: z.boolean().default(true),
  dupeMaxDistance: z.number().int().min(0).max(64).default(10),
});
export type PhotoQcConfig = z.infer<typeof photoQcSchema>;
export function parsePhotoQcConfig(raw: unknown): PhotoQcConfig {
  return photoQcSchema.parse(raw ?? {});
}
```

- [ ] **Step 4: Barrel export + run tests**

Add `export * from "./photo-qc";` to `packages/core/src/index.ts`.
Run: `cd packages/core && pnpm vitest run src/photo-qc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/photo-qc.ts packages/core/src/photo-qc.test.ts packages/core/src/index.ts
git commit -m "feat(core): dHash + hammingDistance + photoQc config

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `classifyImage` vision extension (`@savvy/ai`)

**Files:**
- Modify: `packages/ai/src/client.ts`
- Test: `packages/ai/src/classify-image.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  classifyImage<T>(opts: {
    capability: Capability; prompt: string; system?: string;
    image: { bytes: Uint8Array }; schema: z.ZodType<T>;
  }): Promise<{ object: T; model: string }>
  ```

**Design note:** mirror the existing `completeObject`, but pass `messages` (with an image part) instead of `prompt`. Keep the Anthropic-gateway `mode: "tool"` branch that `completeObject` uses. Inject-free is impossible to unit-test against a real model, so the test uses the AI SDK's `MockLanguageModelV1` (from `ai/test`) to assert the request carried an image part and the parsed object is returned.

- [ ] **Step 1: Write the failing test**

Create `packages/ai/src/classify-image.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { MockLanguageModelV1 } from "ai/test";
import { classifyImageWith } from "./client";

describe("classifyImage", () => {
  it("sends an image part and returns the parsed object", async () => {
    let sawImage = false;
    const model = new MockLanguageModelV1({
      defaultObjectGenerationMode: "json",
      doGenerate: async ({ prompt }) => {
        // prompt is the normalized messages array; find an image part
        const parts = Array.isArray(prompt) ? prompt.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])) : [];
        sawImage = parts.some((p: any) => p.type === "image");
        return { finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 }, text: JSON.stringify({ usable: true }) };
      },
    });
    const res = await classifyImageWith(model, {
      prompt: "is this usable?", image: { bytes: new Uint8Array([1, 2, 3]) },
      schema: z.object({ usable: z.boolean() }),
    });
    expect(sawImage).toBe(true);
    expect(res.object).toEqual({ usable: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ai && pnpm vitest run src/classify-image.test.ts`
Expected: FAIL — `classifyImageWith` not exported.

- [ ] **Step 3: Implement**

In `packages/ai/src/client.ts`, add a model-injectable core plus the capability-resolving wrapper (the injectable form is what the test drives; the public `classifyImage` resolves the gateway model like `completeObject` does):

```ts
import type { LanguageModelV1 } from "ai";

/** Vision classify against an explicit model (used by tests + the public wrapper). */
export async function classifyImageWith<T>(
  model: LanguageModelV1,
  opts: { prompt: string; system?: string; image: { bytes: Uint8Array }; schema: z.ZodType<T>; anthropic?: boolean },
): Promise<{ object: T; model: string }> {
  const res = await generateObject({
    model,
    ...(opts.anthropic ? { mode: "tool" as const } : {}),
    schema: opts.schema,
    system: opts.system,
    messages: [{ role: "user", content: [{ type: "text", text: opts.prompt }, { type: "image", image: opts.image.bytes }] }],
  });
  return { object: res.object as T, model: (model as { modelId?: string }).modelId ?? "unknown" };
}

export async function classifyImage<T>(opts: {
  capability: Capability; prompt: string; system?: string; image: { bytes: Uint8Array }; schema: z.ZodType<T>;
}): Promise<{ object: T; model: string }> {
  const modelId = resolveModel(opts.capability, process.env.LITELLM_BASE_URL);
  const anthropic = isAnthropicGateway(process.env.LITELLM_BASE_URL);
  const { object } = await classifyImageWith(gateway()(modelId), { ...opts, anthropic });
  return { object, model: modelId };
}
```

Export both from the `@savvy/ai` barrel (`packages/ai/src/index.ts`) — add `classifyImage` (and `classifyImageWith` if the barrel lists names) next to `complete, completeObject, embed`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/ai && pnpm vitest run src/classify-image.test.ts`
Expected: PASS. (If `MockLanguageModelV1`'s import path differs in 4.3.19, it is exported from `ai/test` — confirm and adjust the import.)

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/client.ts packages/ai/src/classify-image.test.ts packages/ai/src/index.ts
git commit -m "feat(ai): classifyImage — multimodal vision classification via the gateway

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `assessPhotoQc` verdict + `photo_quality` exception (`@savvy/core`)

**Files:**
- Modify: `packages/core/src/photo-qc.ts` (+ its test)
- Modify: `packages/core/src/exception-queue.ts` (+ its test)

**Interfaces:**
- Produces:
  ```ts
  type PhotoQcVision = { usable: boolean; quality: "ok" | "blurry" | "dark" | "obstructed"; depictsCategory: boolean; reason: string };
  type PhotoQcVerdict = { flagged: boolean; reasons: { quality?: string; wrongCategory?: boolean; duplicateOf?: string } };
  assessPhotoQc(input: { vision: PhotoQcVision; duplicateOf: string | null }): PhotoQcVerdict
  // exception-queue gains "photo_quality" + PhotoQualityInput = { documentId: string; jobId: string; label: string | null; reason: string; occurredAt: Date | null }
  ```

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/photo-qc.test.ts`:

```ts
import { assessPhotoQc } from "./photo-qc";
const ok = { usable: true, quality: "ok" as const, depictsCategory: true, reason: "" };

it("passes a usable, on-category, unique photo", () => {
  expect(assessPhotoQc({ vision: ok, duplicateOf: null }).flagged).toBe(false);
});
it("flags unusable, wrong-category, and duplicate photos with reasons", () => {
  expect(assessPhotoQc({ vision: { ...ok, usable: false, quality: "blurry" }, duplicateOf: null }))
    .toEqual({ flagged: true, reasons: { quality: "blurry" } });
  expect(assessPhotoQc({ vision: { ...ok, depictsCategory: false }, duplicateOf: null }).reasons.wrongCategory).toBe(true);
  expect(assessPhotoQc({ vision: ok, duplicateOf: "doc-9" }).reasons.duplicateOf).toBe("doc-9");
});
```

Add to `packages/core/src/exception-queue.test.ts`:

```ts
it("emits a photo_quality exception per flagged photo", () => {
  const q = buildExceptionQueue({
    atRiskJobs: [], overdueInvoices: [], missedAppointments: [], overdueTasks: [],
    materialDeliveries: [], taskNeedsApprovals: [], weatherAtRisks: [], roofTypeNeeded: [],
    marginOutliers: [], photoIncomplete: [], photoUnmatched: [],
    photoQuality: [{ documentId: "d1", jobId: "j1", label: "ridge", reason: "blurry", occurredAt: new Date() }],
  });
  const row = q.items.find((i) => i.kind === "photo_quality");
  expect(row).toBeTruthy();
  expect(row!.detail).toContain("blurry");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && pnpm vitest run src/photo-qc.test.ts src/exception-queue.test.ts`
Expected: FAIL — `assessPhotoQc` / `photo_quality` missing.

- [ ] **Step 3: Implement `assessPhotoQc`** (append to `photo-qc.ts`)

```ts
export type PhotoQcVision = { usable: boolean; quality: "ok" | "blurry" | "dark" | "obstructed"; depictsCategory: boolean; reason: string };
export type PhotoQcVerdict = { flagged: boolean; reasons: { quality?: string; wrongCategory?: boolean; duplicateOf?: string } };

/** Pure verdict: flag if unusable, off-category, or a near-duplicate. */
export function assessPhotoQc(input: { vision: PhotoQcVision; duplicateOf: string | null }): PhotoQcVerdict {
  const reasons: PhotoQcVerdict["reasons"] = {};
  if (!input.vision.usable) reasons.quality = input.vision.quality === "ok" ? "unusable" : input.vision.quality;
  if (!input.vision.depictsCategory) reasons.wrongCategory = true;
  if (input.duplicateOf) reasons.duplicateOf = input.duplicateOf;
  return { flagged: Object.keys(reasons).length > 0, reasons };
}
```

- [ ] **Step 4: Implement the `photo_quality` exception** (in `exception-queue.ts`)

- Add `"photo_quality"` to the `ExceptionKind` union and `KINDS` array.
- Add `export type PhotoQualityInput = { documentId: string; jobId: string; label: string | null; reason: string; occurredAt: Date | null };` and `photoQuality?: PhotoQualityInput[]` to the input type.
- Add the push loop before the sort, mirroring `photoIncomplete`:

```ts
  for (const p of input.photoQuality ?? []) {
    items.push({
      kind: "photo_quality",
      severity: "medium",
      title: "Photo needs attention",
      detail: `${p.label ? `${p.label}: ` : ""}${p.reason}`,
      href: `/jobs/${p.jobId}`,
      occurredAt: p.occurredAt,
    });
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/core && pnpm vitest run src/photo-qc.test.ts src/exception-queue.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/photo-qc.ts packages/core/src/photo-qc.test.ts packages/core/src/exception-queue.ts packages/core/src/exception-queue.test.ts
git commit -m "feat(core): assessPhotoQc verdict + photo_quality exception

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Photo-QC DB readers/writers (`@savvy/db`) + exception wiring (`apps/web`)

**Files:**
- Modify: `packages/db/src/lifecycle/photos.ts`
- Modify: `packages/db/src/index.ts` (exports)
- Modify: `apps/web/src/lib/exception-queries.ts` (feed `photoQuality`)
- Test: `packages/db/src/lifecycle/photos-qc.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  getPhotoForQc(input: { tenantId: string; documentId: string }): Promise<{ jobId: string | null; r2Key: string | null; label: string | null; qcStatus: string | null } | null>
  getJobPhotoHashes(input: { tenantId: string; jobId: string; excludeDocumentId: string }): Promise<{ documentId: string; phash: string }[]>
  setPhotoQc(input: { tenantId: string; documentId: string; phash: string | null; qcStatus: string; qcReasons: unknown }): Promise<void>
  listFlaggedPhotos(tenantId: string): Promise<{ documentId: string; jobId: string; label: string | null; reason: string; occurredAt: Date }[]>
  ```

- [ ] **Step 1: Write the failing integration tests**

Create `packages/db/src/lifecycle/photos-qc.test.ts` (seed a tenant/customer/property/job + `document` rows via `adminDb`; mirror the seed style in `photos-record.test.ts`). Cover:
- `getPhotoForQc` returns the doc's jobId/r2Key/label/qcStatus; null for a missing id.
- `getJobPhotoHashes` returns other photos' `{documentId,phash}` on the job (only rows with a non-null `phash`), excluding the given id.
- `setPhotoQc` writes phash/qcStatus/qcReasons; a follow-up `getPhotoForQc` shows the new qcStatus.
- `listFlaggedPhotos` returns rows where `qcStatus='flagged'` with a `reason` derived from `qcReasons` (store a `{reason:"blurry"}`-shaped qcReasons and assert the reason surfaces).

(Write the full test bodies following the `photos-record.test.ts` pattern — explicit `createdAt` where ordering matters, fresh `crypto.randomUUID()` per tenant, assertions on DB state read back via `withTenant`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/db && pnpm vitest run src/lifecycle/photos-qc.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement** (append to `packages/db/src/lifecycle/photos.ts`, extend the barrel export line)

```ts
export async function getPhotoForQc(input: { tenantId: string; documentId: string }): Promise<{ jobId: string | null; r2Key: string | null; label: string | null; qcStatus: string | null } | null> {
  return withTenant(input.tenantId, async (tx) => {
    const [d] = await tx.select({ jobId: document.jobId, r2Key: document.r2Key, label: document.label, qcStatus: document.qcStatus })
      .from(document).where(and(eq(document.id, input.documentId), eq(document.kind, "photo")));
    return d ?? null;
  });
}

export async function getJobPhotoHashes(input: { tenantId: string; jobId: string; excludeDocumentId: string }): Promise<{ documentId: string; phash: string }[]> {
  return withTenant(input.tenantId, async (tx) => {
    const rows = await tx.select({ documentId: document.id, phash: document.phash })
      .from(document).where(and(eq(document.jobId, input.jobId), eq(document.kind, "photo"), isNotNull(document.phash), ne(document.id, input.excludeDocumentId)));
    return rows.filter((r): r is { documentId: string; phash: string } => r.phash != null);
  });
}

export async function setPhotoQc(input: { tenantId: string; documentId: string; phash: string | null; qcStatus: string; qcReasons: unknown }): Promise<void> {
  await withTenant(input.tenantId, (tx) => tx.update(document)
    .set({ phash: input.phash, qcStatus: input.qcStatus, qcReasons: input.qcReasons })
    .where(and(eq(document.id, input.documentId), eq(document.tenantId, input.tenantId))));
}

export async function listFlaggedPhotos(tenantId: string): Promise<{ documentId: string; jobId: string; label: string | null; reason: string; occurredAt: Date }[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.select({ id: document.id, jobId: document.jobId, label: document.label, qcReasons: document.qcReasons, createdAt: document.createdAt })
      .from(document).where(and(eq(document.kind, "photo"), eq(document.qcStatus, "flagged"), isNotNull(document.jobId)));
    return rows.map((r) => ({
      documentId: r.id, jobId: r.jobId!, label: r.label,
      reason: reasonText(r.qcReasons), occurredAt: r.createdAt,
    }));
  });
}

// Turn the structured qcReasons object into a short human string for the exception detail.
function reasonText(raw: unknown): string {
  const r = (raw ?? {}) as { quality?: string; wrongCategory?: boolean; duplicateOf?: string };
  const parts: string[] = [];
  if (r.quality) parts.push(r.quality);
  if (r.wrongCategory) parts.push("wrong category");
  if (r.duplicateOf) parts.push("duplicate");
  return parts.join(", ") || "flagged";
}
```

Add `isNotNull`, `ne` to the `drizzle-orm` import if missing. Extend the `photos.ts` barrel export line to include the four new names.

- [ ] **Step 4: Wire `photo_quality` into apps/web**

In `apps/web/src/lib/exception-queries.ts`: import `listFlaggedPhotos` + `PhotoQualityInput`; build `photoQuality` from the reader (map `documentId/jobId/label/reason/occurredAt` straight through); pass it into `buildExceptionQueue({...})`. Mirror the `photoUnmatched` wiring shipped in Slice 1.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd packages/db && pnpm vitest run src/lifecycle/photos-qc.test.ts` → PASS.
Run: `pnpm --filter @savvy/db --filter @savvy/web typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/photos.ts packages/db/src/index.ts packages/db/src/lifecycle/photos-qc.test.ts apps/web/src/lib/exception-queries.ts
git commit -m "feat(db): photo-QC readers/writers + wire photo_quality exception

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: QC Inngest workflow (`@savvy/agents`)

**Files:**
- Create: `packages/agents/src/functions/photo-qc.ts`
- Create: `packages/agents/src/functions/photo-qc.test.ts`
- Modify: `packages/agents/src/index.ts` (register the function)
- Modify: `packages/agents/package.json` (add `jimp` dependency)

**Interfaces:**
- Consumes: `getPhotoForQc`, `getJobPhotoHashes`, `setPhotoQc` (`@savvy/db`); `dHash`, `hammingDistance`, `assessPhotoQc`, `parsePhotoQcConfig`, `parseFinanceConfig`-style settings read (`@savvy/core`); `classifyImage` (`@savvy/ai`); `r2Storage.presignDownload` (`@savvy/integrations`); `jimp`.
- Produces: `photoQc` Inngest function on `photo/ingested`, and a testable pure-ish helper:
  ```ts
  export async function runPhotoQc(deps: {
    tenantId: string; documentId: string; jobId: string;
    fetchBytes: (key: string) => Promise<Uint8Array>;
    classify: (bytes: Uint8Array, label: string | null) => Promise<PhotoQcVision>;
    cfg: { dupeMaxDistance: number };
  }): Promise<{ qcStatus: "passed" | "flagged" | "skipped"; phash: string | null; reasons: unknown }>
  ```

**Design notes:**
- `runPhotoQc` is the unit under test — inject `fetchBytes` and `classify` so the test uses fixture bytes + a stub vision result (no R2, no model). It: fetches bytes → `jimp` decode → resize to 9×8 grayscale → build `number[][]` → `dHash` → load job hashes → nearest Hamming ≤ `dupeMaxDistance` ⇒ `duplicateOf` → `classify` → `assessPhotoQc` → `setPhotoQc(phash, flagged?"flagged":"passed", reasons)`. On any thrown error inside, catch → `setPhotoQc(null-or-phash, "skipped", {})` and return skipped (fail-soft).
- The **jimp decode → 9×8 grayscale** step (agent-only, jimp v1: `const img = await Jimp.read(Buffer.from(bytes)); img.resize({w:9,h:8}).greyscale();` then read each pixel's red channel as the gray value). Confirm the installed jimp major's resize/greyscale API and pixel access (`img.bitmap.data` RGBA or `img.getPixelColor`) and build the `number[][]`. If jimp v1's API differs, adapt — the grayscale matrix is the contract into core's pure `dHash`.
- The Inngest `photoQc` function: trigger `{ event: "photo/ingested" }`; **early-return if `event.data.jobId == null`** (HAND-OFF CONTRACT); load tenant settings → `parsePhotoQcConfig`; if `!enabled` return skipped; `step.run` wraps `runPhotoQc` with real `fetchBytes` (presignDownload → fetch → bytes) and real `classify` (`classifyImage({capability:"reflex", ...})` with a prompt that names the photo's `label`/category and requests the `PhotoQcVision` schema).
- The vision prompt + schema: `classifyImage({ capability: "reflex", image:{bytes}, schema: z.object({ usable: z.boolean(), quality: z.enum(["ok","blurry","dark","obstructed"]), depictsCategory: z.boolean(), reason: z.string() }), prompt: \`This is a roofing job-site photo categorized as "${label ?? "unknown"}". Judge if it is usable (sharp, well-lit, unobstructed) and whether it depicts a ${label ?? "roof feature"}.\` })`.

- [ ] **Step 1: Add jimp + write the failing test**

Add `jimp` to `packages/agents/package.json` dependencies; `pnpm install`.
Create `packages/agents/src/functions/photo-qc.test.ts` exercising `runPhotoQc` against the real DB (seed a job + two photo docs, one with a `phash` already set to force a duplicate), a `fetchBytes` returning a tiny generated PNG (or a committed fixture), and a stub `classify`:
- usable+on-category+no-dup → `qcStatus: "passed"`, phash written.
- `classify` returns `usable:false` → `qcStatus: "flagged"`, reasons.quality set.
- a photo whose dHash is within `dupeMaxDistance` of the seeded one → `flagged` with `reasons.duplicateOf`.
- `fetchBytes` throws → `qcStatus: "skipped"` (fail-soft), no throw.

(Generate a minimal valid PNG for the fixture — e.g. jimp `new Jimp({width:9,height:8,color:0xffffffff})` encoded to a buffer in a test helper — so decode is deterministic. For the duplicate case, seed the other doc's `phash` to the exact dHash the fixture will produce.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agents && pnpm vitest run src/functions/photo-qc.test.ts`
Expected: FAIL — `runPhotoQc` not defined.

- [ ] **Step 3: Implement `runPhotoQc` + the `photoQc` Inngest function**

Write `packages/agents/src/functions/photo-qc.ts` per the design notes (jimp decode → grayscale matrix → core dHash/assess; fail-soft skipped on error; the durable function early-returns on null jobId and wraps `runPhotoQc` in a `step.run`). Register `photoQc` in `packages/agents/src/index.ts` (mirror how other functions are exported/registered).

- [ ] **Step 4: Run test + typecheck**

Run: `cd packages/agents && pnpm vitest run src/functions/photo-qc.test.ts` → PASS.
Run: `pnpm --filter @savvy/agents typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/functions/photo-qc.ts packages/agents/src/functions/photo-qc.test.ts packages/agents/src/index.ts packages/agents/package.json pnpm-lock.yaml
git commit -m "feat(agents): photo-QC workflow — vision usability/subject + dHash dedup on photo/ingested

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (Slice 2 section):**
- Vision extension (`classifyImage`) → Task 2. ✓
- Per-photo vision QC (usable + depictsCategory) → Task 5 (prompt/schema) + Task 3 (verdict). ✓
- dHash dedup within a job → Task 1 (pure) + Task 5 (decode + compare) + Task 4 (`getJobPhotoHashes`). ✓
- `assessPhotoQc` verdict → Task 3. ✓
- `parsePhotoQcConfig` → Task 1. ✓
- Fail-soft skipped on model/decode error → Task 5 (`runPhotoQc` catch). ✓
- Write `qc_status`/`qc_reasons`/`phash` (columns from Slice 1) → Task 4 (`setPhotoQc`). ✓
- `photo_quality` exception → Task 3 (kind) + Task 4 (reader + wiring). ✓
- HAND-OFF CONTRACT: early-return on `jobId===null` → Task 5 (Inngest trigger guard). ✓

**Placeholder scan:** Task 4 Step 1 and Task 5 Step 1 describe test bodies rather than pasting them verbatim (the seeds mirror the shipped `photos-record.test.ts` pattern and the fixture-PNG generation is described) — acceptable because the interfaces + assertions are fully specified and the pattern to copy is named. The "confirm jimp v1 API" and "confirm MockLanguageModelV1 import path" notes are real verify-against-installed-version instructions, not placeholders. All production code is complete.

**Type consistency:** `PhotoQcVision`/`PhotoQcVerdict` shapes are identical across Task 3 (def), Task 5 (classify return + runPhotoQc), and the vision schema. `qcReasons` structured shape `{quality?,wrongCategory?,duplicateOf?}` is consistent between `assessPhotoQc` (Task 3), `setPhotoQc` (Task 4), and `reasonText`/`listFlaggedPhotos` (Task 4). `PhotoQualityInput` matches between Task 3 def, its test, and the Task 4 reader/wiring.

## Out of scope / follow-ups
- `/photos/unmatched` tray page + whether `matchPhotoToJob` re-emits `photo/ingested` (so QC fires on manually-matched photos) — Slice 1 follow-up; when built, that action should `inngest.send("photo/ingested", ...)`.
- A dedicated "dismiss / re-take" action on the `photo_quality` exception (mark `qc_status='passed'`) — a small follow-up; not required for the detect+surface loop.
- Image-embedding-based similarity (dHash suffices for near-dups).
