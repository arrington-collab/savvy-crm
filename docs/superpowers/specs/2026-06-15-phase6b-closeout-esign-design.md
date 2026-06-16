# Phase 6B — Closeout E-Sign via DocuSeal (Design Spec)

**Date:** 2026-06-15
**Parent:** Phase 6 (Production & close-out) is delivered as sequenced slices — 6A (production spine: storage + photos + completion gate) ✅ merged; **6B (this spec): closeout e-sign — lien waivers & certificates of completion via DocuSeal**; then 6C (change orders), 6D (CompanyCam + crew check-in). Roadmap Phase 6 done-when: "a job goes approved → produced → closed with documents attached."

## 1. Summary

6B lets a rep send a **lien waiver** or **certificate of completion** for signature: the rep clicks "Send for signature" on a job, the customer receives a DocuSeal signing link by email, signs, and the **signed PDF lands as a `document` on the job**. Each completed signature is recorded as a billable event (the meter; the actual $0.50/contract charge is Phase 8). Both document types ship in 6B.

This reuses the 6A R2 storage spine (the signed PDF is stored exactly like any other document) and mirrors the Stripe webhook → event → durable-consumer pattern already in the codebase: the webhook returns 200 fast, and an Inngest function durably downloads and stores the signed PDF.

DocuSeal is **Savvy-mediated**: one Savvy-owned DocuSeal instance, one Savvy-level API key + base URL. Tenants never see or configure DocuSeal; submissions are tagged per tenant via metadata. Self-hosted vs cloud is purely where `DOCUSEAL_BASE_URL` points.

## 2. Scope decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| DocuSeal model | **Self-hosted, Savvy-mediated** — one Savvy instance, Savvy-level key/URL; tenants never see it; submissions tagged per tenant via metadata |
| Document types | **Both** lien waiver + certificate of completion (single `docType` enum) |
| Templates | **Standard now, per-tenant override later** — template IDs in `tenant.settings.esign`, defaulting to Savvy standard IDs from env |
| Signing delivery | **DocuSeal emails the signer + Savvy captures the link** — DocuSeal sends the email; Savvy also stores the signing URL so the rep can copy/resend + watch status |
| Prefill fields | **Standard set** — customer name, property address, date; **amount** additionally on lien waiver |
| Completion gating | **None** — signed docs are tracked, never block completion; the 6A photo gate stays the only completion gate |
| Billing | A `completed` `esign_request` is the **meterable unit**; the charge itself is **Phase 8** (billing meters). 6B only records the event. |

### Out of scope (deferred)
- **The actual e-sign charge** (sum completed requests per tenant, bill $0.50 each) → Phase 8 (billing meters). 6B records the meterable event so the data exists.
- **Per-tenant custom templates UI** — 6B reads template IDs from `settings.esign` (defaulting to env); editing them in a settings UI is deferred (seed/admin-set for now).
- **Completion gating on a signed cert** — explicitly NOT in 6B; photos remain the only completion gate (6A).
- **In-app signing / embedded signer** — DocuSeal hosts the signing page; Savvy links to it.
- **Reminders/auto-nudge** for unsigned requests — manual copy/resend only in 6B.
- **Declined/voided recovery flows** beyond recording the status.

## 3. Architecture approach

Reuse established patterns:
- **DocuSeal** is an injectable gateway (`DocusealGateway`) mirroring `StripeGateway`/`QboGateway`/`StorageGateway` — real impl hitting `DOCUSEAL_BASE_URL` + `makeFakeDocuseal` fake for tests.
- **Durable finalize** is an Inngest function (`esignFinalize`) on an `esign/completed` event — same webhook→event→durable-consumer shape as the Stripe money path. The webhook handler does the minimum (verify, mark, emit, 200) and the workflow does the slow work (download + store).
- **Storage** of the signed PDF reuses the 6A `StorageGateway` (R2) and the `document` table — no new storage code.
- **Config** lives in `tenant.settings.esign` (jsonb), parsed once by a `@savvy/core` zod schema with defaults from env — same pattern as `parseFinanceConfig` / `parseProductionConfig`.
- **Prefill** is pure logic in `@savvy/core` (`buildEsignPrefill`) so it's unit-testable without a DB or DocuSeal.

## 4. Data model changes (migration `0007`)

### 4.1 New table `esign_request` (`packages/db/src/schema/ops.ts`)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `tenantId` | uuid | RLS scope |
| `jobId` | uuid → `job` | |
| `customerId` | uuid → `customer` | |
| `docType` | text | `lien_waiver` \| `cert` (free text + zod-validated at the edge, per the `noUncheckedIndexedAccess`/enum-widening gotchas) |
| `templateId` | text | resolved from `settings.esign` at send time |
| `docusealSubmissionId` | text | DocuSeal's submission id |
| `status` | text | `draft` \| `sent` \| `completed` \| `declined` \| `voided` |
| `signingUrl` | text (nullable) | captured at send; rep can copy/resend |
| `documentId` | uuid → `document` (nullable) | set on completion when the signed PDF is stored |
| `sentAt` | timestamptz (nullable) | |
| `completedAt` | timestamptz (nullable) | |
| `createdAt` | timestamptz default now | |

- **RLS:** `tenantIsolation()` policy (non-superuser `savvy_app` enforced); add a case to `packages/db/tests/isolation.test.ts`.
- **Index:** `(tenantId, jobId)` for the per-job list.
- **Unique:** `(tenantId, docusealSubmissionId)` — makes the webhook idempotent (a replayed webhook can't create a second request; lookup-by-submission is the natural key).

### 4.2 `document.source`
The signed PDF is stored as a `document` with `source: "docuseal"`. `document.source` is already free `text` (6A) — no schema change, just a new value. `document.kind` uses `lien_waiver` / `cert` to mirror `docType` (also free text).

### 4.3 `tenant.settings.esign` (jsonb, no new table)
Parsed by a `@savvy/core` zod schema (`parseEsignConfig`) with defaults from env:
```jsonc
{ "templates": {
    "lien_waiver": "<DOCUSEAL_TEMPLATE_LIEN_WAIVER>",
    "cert":        "<DOCUSEAL_TEMPLATE_CERT>"
} }
```
- Defaults come from `DOCUSEAL_TEMPLATE_LIEN_WAIVER` / `DOCUSEAL_TEMPLATE_CERT` env so existing tenants (settings `{}`) resolve to the Savvy standard templates. A tenant overriding a template is a future config change, no schema churn.
- `tenant` table has **no RLS** (per repo rule) — write `settings.esign` via `adminDb`, scoped by `getTenantId()`; read via the parser.

## 5. DocuSeal gateway (`packages/integrations/src/docuseal.ts`)

```ts
export interface DocusealGateway {
  createSubmission(o: {
    templateId: string;
    signer: { name: string; email: string };
    fields: { name: string; default_value: string }[];
    metadata: { tenantId: string; jobId: string; docType: string };
  }): Promise<{ submissionId: string; signingUrl: string }>;

  verifyWebhook(rawBody: string, signature: string | null):
    { submissionId: string; status: "completed" | "declined" } | null;

  downloadSignedPdf(o: { submissionId: string }): Promise<{ bytes: Uint8Array; mime: string }>;
}
```
- **`realDocuseal`** — hits `DOCUSEAL_BASE_URL` with `X-Auth-Token: DOCUSEAL_API_KEY`. `createSubmission` POSTs a submission for `templateId` with the prefill `fields` (DocuSeal's documented `"fields":[{"name","default_value"}]` shape — confirmed against Brett's roofing-tracker prior art) and returns the submission id + the signer's signing URL. `verifyWebhook` validates the payload signature against `DOCUSEAL_WEBHOOK_SECRET` and extracts `{submissionId, status}`. `downloadSignedPdf({ submissionId })` GETs the submission's signed document from the DocuSeal API (by id, so no possibly-expiring URL is threaded through the event).
- **`makeFakeDocuseal()`** — deterministic `submissionId`/`signingUrl`, records calls, and synthesizes a webhook payload + signed-PDF bytes for tests (same shape as `makeFakeStripe`/`makeFakeStorage`/`makeFakeQbo`).
- **Env** (documented in `.env.example`): `DOCUSEAL_BASE_URL`, `DOCUSEAL_API_KEY`, `DOCUSEAL_WEBHOOK_SECRET`, `DOCUSEAL_TEMPLATE_LIEN_WAIVER`, `DOCUSEAL_TEMPLATE_CERT`. Until configured, the real gateway throws a clear `docuseal_not_configured` error; tests use the fake.
- **Note:** DocuSeal's exact auth header + webhook signature scheme are best-effort and **sandbox-validated** (same approach as QBO). The gateway interface isolates any correction to one file.

## 6. Send flow (server action, `apps/web/src/lib/esign-actions.ts`)

`sendForSignature({ jobId, docType })` — under `withTenant` / `getTenantId()`:
1. Load job + customer + property, **tenant-scoped**; verify the job belongs to the tenant.
2. **Require `customer.email`** — return a typed `{ error: "no_customer_email" }` result if missing (no submission created).
3. Resolve `templateId = parseEsignConfig(tenant.settings).templates[docType]`.
4. Build prefill via `buildEsignPrefill(docType, { customer, property, job, date })` (§8).
5. `createSubmission(...)` with `metadata { tenantId, jobId, docType }` — **outside** any open transaction (it's an outbound HTTP call; read in one tx, call DocuSeal, insert in a second tx — per the repo I/O-outside-`withTenant` rule).
6. Insert `esign_request` (`status: "sent"`, `sentAt: now`, `signingUrl`, `docusealSubmissionId`).
7. `revalidatePath('/jobs/[id]')`; return the request + signing URL.

## 7. Webhook + durable finalize

### 7.1 Webhook `POST /api/docuseal/webhook` (public route)
- Add to the middleware **PUBLIC** allowlist (same as the Stripe webhook) — it's called by DocuSeal, not an authenticated user.
- Read the **raw body**; `verifyWebhook(rawBody, signature)` → **400** on a bad/missing signature (no DB touch).
- Find the `esign_request` by `docusealSubmissionId` (admin/cross-tenant lookup by the unique key — the webhook has no Clerk session; resolve `tenantId` from the row, then operate scoped).
- On `status: "completed"`: set `status="completed"`, `completedAt=now`; emit Inngest `esign/completed { requestId, tenantId }`; return **200 fast**.
- On `status: "declined"`: set `status="declined"`; 200.
- Unknown submission / already-completed → log + **200** (idempotent; no error).

### 7.2 `esignFinalize` Inngest fn (`packages/agents/src/functions/esign.ts`)
On `esign/completed`:
1. Load the `esign_request` (tenant-scoped via the event's `tenantId`).
2. **Idempotency:** if `documentId` is already set, skip (return early) — a replayed event stores nothing twice.
3. `downloadSignedPdf({ submissionId })` using the request's stored `docusealSubmissionId` (fetched by id from DocuSeal — nothing URL-shaped needs to survive the event hop).
4. Store the bytes in R2 via the 6A `StorageGateway` under a tenant-scoped key `${tenantId}/${jobId}/esign-${requestId}.pdf`; insert a `document` row (`kind: docType`, `source: "docuseal"`, `customerId`, `sizeBytes`, `mime: "application/pdf"`).
5. Set `esign_request.documentId` to the new document.
6. Write an `agent_run` row (`status` free text: `ok`/`error`). Re-hydrate any `Date` crossing a `step.run` boundary with `new Date(x)` (Inngest serializes Date→ISO).

This mirrors the Stripe webhook→event→durable-consumer flow and reuses 6A R2 storage — the signed PDF is just another `document`.

## 8. Prefill (pure core, `packages/core/src/esign.ts`)

```ts
export function buildEsignPrefill(
  docType: "lien_waiver" | "cert",
  ctx: { customerName: string; propertyAddress: string; date: string; amount?: string },
): { name: string; default_value: string }[];
```
- Both types: `customer_name`, `property_address`, `date`.
- `lien_waiver` additionally: `amount` (omitted/empty when not supplied).
- Field **names** are placeholders matching the standard Savvy templates; correcting them to the real template field names is a one-line map change (templates may not exist yet — build against the assumed set, wire real names when templates are created).
- Plus `parseEsignConfig(raw, envDefaults) -> { templates: Record<"lien_waiver"|"cert", string> }`.

## 9. UI (`apps/web/src/app/(app)/jobs/[id]`, new "E-sign" section/tab)

- **Send control:** a "Send for signature" button with a doc-type picker (lien waiver / certificate of completion). On submit → `sendForSignature` → optimistic refresh. Disabled with a hint if `customer.email` is missing.
- **Requests list:** each `esign_request` with a **status badge** (`sent`/`completed`/`declined`/`voided`), the doc type, and timestamps.
  - While `sent`: a **copy-signing-link** button (the captured `signingUrl`) so the rep can resend manually.
  - Once `completed`: a **signed-PDF link** via `presignDocumentView(documentId)` (reuses 6A).
- No completion-gate surfacing here — 6B does not gate completion (§2).

## 10. Error handling
- **Send:** job not tenant's → typed error result; missing `customer.email` → `{ error: "no_customer_email" }`, no submission; DocuSeal unreachable / not configured → `docuseal_not_configured` surfaced as a result (no row written).
- **Webhook:** bad/missing signature → 400, no DB touch. Unknown or already-completed submission → 200 + log (idempotent). The handler never does slow work — download/store is the durable fn's job.
- **Finalize:** retried by Inngest on failure; idempotent via the `documentId`-set check (no duplicate documents on replay). A download failure retries; a permanent failure logs an `error` `agent_run` and leaves `documentId` null (the request is still `completed`; the PDF can be re-fetched).
- **Decline:** recorded as `status="declined"`; no document, no error.

## 11. Testing
- **Unit (`@savvy/core`):** `parseEsignConfig` (env defaults, partial override, empty settings); `buildEsignPrefill` (both types, amount present/absent on lien waiver, cert omits amount).
- **Gateway (`@savvy/integrations`):** `makeFakeDocuseal` returns deterministic submission/url, records calls, synthesizes a verifiable webhook payload + signed-PDF bytes; `verifyWebhook` rejects a bad signature.
- **Integration (`@savvy/db` / `@savvy/agents`):** webhook marks the request `completed` + emits `esign/completed` + is idempotent on replay (unique `(tenant,submissionId)`); `esignFinalize` stores the PDF as a `document`, sets `documentId`, and stores **once** on a replayed event.
- **RLS:** extend `packages/db/tests/isolation.test.ts` to cover `esign_request` — cross-tenant read returns zero.
- **e2e (Playwright):** on a job, "Send for signature" (lien waiver, fake DocuSeal) creates a `sent` request with a copy-link; simulate the webhook → request flips to `completed` and a signed-PDF link appears. Use `getByRole("button", {name})` for tab triggers (the `TabsTrigger` gotcha).
- **Static gate:** `pnpm typecheck && pnpm lint && pnpm test` green.

## 12. Definition of done (per repo CLAUDE.md)
- [ ] `esign_request` table + `tenant.settings.esign` added; migration `0007`; `esign_request` covered by the RLS isolation test; unique `(tenantId, docusealSubmissionId)`.
- [ ] `DocusealGateway` (real + `makeFakeDocuseal`); no hard-coded provider strings in feature code; all DocuSeal access through the gateway.
- [ ] Send action is tenant-scoped, requires `customer.email`, resolves the template from `settings.esign`, and does the DocuSeal HTTP call **outside** the `withTenant` tx.
- [ ] Webhook is a PUBLIC route, verifies the signature (400 on bad), returns 200 fast, and is idempotent; durable `esignFinalize` downloads + stores the signed PDF via the 6A `StorageGateway` and is idempotent via `documentId`.
- [ ] A `completed` `esign_request` is the meterable unit (Phase 8 bills it); **no completion gating added** — photos remain the only completion gate.
- [ ] `DOCUSEAL_*` env documented in `.env.example`; no secrets committed.
- [ ] Unit + gateway + integration + RLS + e2e tests pass; typecheck + lint clean.
- [ ] One reviewed PR (base **main**) with a clear summary.

## 13. Tracked follow-ups (deferred)
- **E-sign billing meter** (sum `completed` requests per tenant → $0.50 each) — Phase 8.
- **Per-tenant template config UI** in settings (6B reads `settings.esign`; editing it is admin/seed for now).
- **Reminders / auto-nudge** for unsigned requests.
- **Confirm DocuSeal auth header + webhook signature scheme** against the live instance (best-effort/sandbox-validated in 6B; gateway isolates the fix).
- **Real template field names** wired into `buildEsignPrefill` once the standard templates are built.
- **Voided/decline recovery UX** beyond status display.
