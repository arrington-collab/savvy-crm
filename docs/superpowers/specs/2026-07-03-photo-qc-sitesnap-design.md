# SiteSnap Photo Ingestion + AI Photo QC — Design

**Date:** 2026-07-03
**Status:** Draft (pending user review)
**Spec section:** Jobs domain — net-new enhancement #2 (AI photo QC), expanded to include the SiteSnap photo-ingestion source.

## Problem

Two related gaps:

1. **Photo source.** Field photos will be captured in **SiteSnap** (an in-house web app, `sitesnap-pi.vercel.app`, still in development), organized by *Project* and pre-*categorized*. Savvy has no ingestion path for them — today only CompanyCam and manual uploads land as `document.kind='photo'`.
2. **No quality control.** The existing `photo_incomplete` exception only checks whether a required-photo **label is present**, never whether the image is any good. Blurry, dark, mislabeled, or duplicate photos flow through unnoticed until someone eyeballs them.

This feature (a) ingests SiteSnap photos into Savvy jobs, and (b) runs AI quality control on ingested photos, routing bad ones to the Needs-you queue.

## Decisions (locked with Brett)

| Decision | Choice |
|---|---|
| Build shape | **Two slices, one combined spec.** Slice 1 = SiteSnap ingestion; Slice 2 = AI photo QC. Sequential spec→plan→PR each. |
| QC defect classes | **Quality** (blurry/dark/unusable) + **subject-coverage** (image matches its category) + **near-duplicates**. |
| Quality + subject = one call | Both judged in a **single vision request per photo** (`reflex` tier). |
| Duplicates | **Perceptual hash (dHash)** within the same job — deterministic, no AI cost. |
| Checklist coupling | **None** — category is an opaque string; do NOT wire into the `photo_incomplete` required-photo checklist in v1. |
| SiteSnap coupling | **Savvy defines the inbound webhook**; SiteSnap conforms when ready. Built/tested against a fake producer — no dependency on SiteSnap being finished. |
| Job linkage | **Match by property address** (normalize → resolve property → pick job). Misses go to an **unmatched-photos** tray. |
| Image durability | **Copy bytes into Savvy R2 on ingest** (don't depend on SiteSnap-hosted URLs staying alive). |

## Technical defaults chosen (flag for veto — not separately asked)

1. **pHash = dHash (difference hash), computed via `jimp`.** `jimp` is pure-JS (no native build → CI-friendly; nothing image-related exists in the repo today). Near-duplicate = Hamming distance ≤ `jobs.photoQc.dupeMaxDistance` (default **10** of 64), compared only against other photos **on the same job**.
2. **Vision input = R2 bytes, not a public URL.** QC fetches the stored image bytes from R2 and passes them to the model as image content, so we never depend on a public/signed URL. Requires a `get`/`download` method on the `StorageGateway` (add if absent).
3. **Address→job selection rule:** normalize the address (lowercase, trim, collapse whitespace, standardize common abbreviations), find the tenant's `property` by normalized address; pick the **most recent job on that property whose stage is not `closed`/`lost`**; if none open, the newest job; if no property/job, **unmatched**.
4. **Two new exception kinds:** `photo_unmatched` (Slice 1 — ingestion couldn't find a job) and `photo_quality` (Slice 2 — QC flagged photos). Both surface in the existing `/exceptions` Needs-you queue.
5. **Auth:** a per-tenant ingestion key stored in `tenant.settings.sitesnap.ingestKey` (no schema change); the webhook resolves the tenant by that key (SiteSnap is ours, so a bearer key is simpler than CompanyCam-style HMAC).
6. **QC runs on matched photos only** (`photo/ingested` with a `jobId`). Unmatched photos wait in the tray; matching them later re-emits `photo/ingested` and triggers QC then.

---

## Slice 1 — SiteSnap Ingestion

Mirrors the proven CompanyCam webhook (`apps/web/src/app/api/companycam/webhook/route.ts` + `recordCompanyCamPhoto`), swapping HMAC→bearer-key and project-id→address matching, and adding an R2 copy.

### Inbound webhook — `POST /api/sitesnap/photos` (apps/web)
- `runtime = "nodejs"`.
- Auth: `Authorization: Bearer <key>` → resolve tenant where `settings.sitesnap.ingestKey === key`. 401 on miss.
- Body (Savvy-defined contract): `{ address: string, category: string, imageUrl: string, capturedAt?: string, externalPhotoId: string }`.
- Handler:
  1. Fetch the image bytes from `imageUrl`; on failure → 502 (SiteSnap retries).
  2. Resolve job via `resolvePhotoJob({ tenantId, address })` (see db).
  3. Copy bytes to R2 (`r2Storage.put`), get `r2Key`.
  4. `recordSiteSnapPhoto(...)` — insert a `document` row (`kind='photo'`, `source='sitesnap'`, `label=category`, `r2Key`, `captureAddress=address`, `sitesnapPhotoId=externalPhotoId`, `jobId` or null). Idempotent on `(tenantId, sitesnapPhotoId)` — a repeat webhook no-ops.
  5. Emit `photo/ingested` `{ tenantId, documentId, jobId | null }` (fail-soft).
  6. If unmatched (`jobId` null) → the `photo_unmatched` exception surfaces it (built from a reader).

### DB (`@savvy/db`)
- `resolvePhotoJob({ tenantId, address }): Promise<{ jobId: string } | null>` — normalized-address property lookup + job-selection rule above. Tenant-scoped.
- `recordSiteSnapPhoto(...)` — idempotent insert (adminDb resolves tenant like `recordCompanyCamPhoto`; RLS-scoped writes). Returns `{ created, documentId, tenantId, jobId }`.
- `listUnmatchedPhotos(tenantId)` — for the exception/tray.
- `matchPhotoToJob({ tenantId, documentId, jobId })` — manual assignment from the tray; re-emits `photo/ingested`.

### Migration (`document` table)
Add: `phash text`, `qcStatus text default 'pending'` (`pending|passed|flagged|skipped`), `qcReasons jsonb`, `captureAddress text`, `sitesnapPhotoId text`. Unique index on `(tenant_id, sitesnap_photo_id)` (partial, where not null) for idempotency. `source` accepts `'sitesnap'` (it's a free-text column — no enum change).

### Unmatched tray
A `photo_unmatched` exception kind: one row per unmatched photo (or grouped "N photos need a job"), linking to a small assignment UI (reuse the exceptions surface). Action: pick a job → `matchPhotoToJob` → QC fires.

---

## Slice 2 — AI Photo QC

Source-agnostic: triggers on `photo/ingested` for any matched photo (SiteSnap today; CompanyCam/manual later for free).

### Vision extension (`@savvy/ai`)
The client is text-only today. Add:
```ts
classifyImage<T>(opts: {
  capability: Capability;          // 'reflex'
  prompt: string; system?: string;
  image: { bytes: Uint8Array; mime: string };
  schema: z.ZodType<T>;
}): Promise<{ object: T; model: string }>
```
Implemented with the Vercel AI SDK's multimodal `messages` (an image part + a text part) via `generateObject`. Capability tiers already resolve to vision-capable models (`reflex` → gemini-flash / Claude Haiku).

### QC workflow (`@savvy/agents`, Inngest, on `photo/ingested`)
Durable, `cancelOn` not needed (one-shot per photo). Steps:
1. **Load** the `document` (must be `kind='photo'`, have a `jobId`, `qcStatus='pending'`). Skip otherwise.
2. **Fetch bytes** from R2 (`r2Storage.get(r2Key)`).
3. **Vision QC** — `classifyImage(reflex, ...)` with schema `{ usable: boolean, quality: "ok"|"blurry"|"dark"|"obstructed", depictsCategory: boolean, reason: string }`. The prompt passes the photo's `category` (label). Fail-soft: on model error, set `qcStatus='skipped'` and stop (don't block ingestion).
4. **Dedup** — compute dHash (`jimp`), compare to other photos on the job that already have a `phash`; nearest Hamming ≤ threshold ⇒ duplicate. Store the new photo's `phash`.
5. **Verdict** — `flagged` if `!usable || !depictsCategory || isDuplicate`, else `passed`. Write `qcStatus` + `qcReasons` (structured: `{ quality?, wrongCategory?, duplicateOf? }`).
6. **Surface** — a flagged photo contributes to the job's `photo_quality` exception (built by a reader over `qcStatus='flagged'` photos). Action: crew re-takes, or a staffer dismisses (sets `qcStatus='passed'`).

### Core (`@savvy/core`, pure, unit-tested)
- `dHash(grayscale: number[][]): string` and `hammingDistance(a, b): number` — pure hashing/compare (the `jimp` decode lives in the agent; the hash math is pure and tested).
- `assessPhotoQc(input): { flagged: boolean; reasons: {...} }` — pure verdict rule from the vision result + dup result.
- QC config parser `parsePhotoQcConfig` (`tenant.settings.jobs.photoQc`: `enabled` default true, `dupeMaxDistance` default 10).

### Exception (`@savvy/core` + `apps/web`)
Add `photo_quality` to the `ExceptionKind` union + `buildExceptionQueue`; add a `PhotoQualityInput` type and a query in `exception-queries.ts` reading flagged photos grouped by job.

---

## Data flow

```
SiteSnap ──POST /api/sitesnap/photos (bearer key)──▶ Savvy
  fetch bytes → resolvePhotoJob(address)
     ├─ job → copy to R2 → document(kind=photo, source=sitesnap, jobId) → emit photo/ingested
     └─ no job → document(jobId=null) → photo_unmatched exception (tray)
                              │
                    (photo/ingested, jobId present)
                              ▼
             QC workflow (Inngest)
               fetch R2 bytes
               ├─ classifyImage(reflex) → usable? depictsCategory?
               ├─ dHash vs job's photos → duplicate?
               └─ verdict → qcStatus/qcReasons
                     └─ flagged → photo_quality exception (Needs-you)
```

## Error handling
- **Image fetch / R2 failure on ingest** → 502, SiteSnap retries (webhook is idempotent on `sitesnapPhotoId`).
- **Unresolvable address** → store unmatched (not an error); tray handles it.
- **Vision model error** → `qcStatus='skipped'`, fail-soft (never blocks ingestion or the board).
- **Duplicate webhook** → idempotent no-op via the unique `(tenant, sitesnapPhotoId)` index.
- **Tenant isolation** — every read/write via `withTenant`; `recordSiteSnapPhoto` resolves tenant from the ingestion key (admin path, like CompanyCam), all row writes RLS-scoped.

## Testing
- **Slice 1:** integration — webhook auth (valid/invalid key); matched-by-address insert (document row, R2 put called via fake storage, `photo/ingested` emitted); unmatched path (jobId null, tray reader); idempotent replay; `resolvePhotoJob` unit-ish (address normalization, job-selection rule) integration against seeded properties/jobs.
- **Slice 2:** pure — `dHash`/`hammingDistance` (known bitmaps → stable hash; near-dup within threshold, distinct beyond), `assessPhotoQc` (each flag reason + passing), `parsePhotoQcConfig`. Integration — QC workflow with a **fake vision gateway** + **fake storage**: usable+on-category+unique → passed; blurry → flagged; wrong-category → flagged; duplicate (two near-identical fixtures) → flagged with `duplicateOf`; model error → skipped. Exception reader returns flagged photos grouped by job.
- Vision extension: unit test `classifyImage` against a fake model asserting the image part is included in the request.

## Out of scope (v1)
- Wiring category → the required-photo checklist (`photo_incomplete`) — deliberate.
- Cross-job duplicate detection (only within a job).
- Auto-deleting duplicates (we flag, humans decide).
- Building SiteSnap's side (its capture UI / project model) — we only define + consume the webhook.
- Image-embedding-based similarity (dHash suffices for near-dups).

## Suggested build order
Slice 1 (ingestion, shippable alone) → Slice 2 (QC). Each: worktree → TDD → PR `--base main` → CI green → squash-merge.
