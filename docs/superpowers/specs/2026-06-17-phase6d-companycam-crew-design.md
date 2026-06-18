# Phase 6D — CompanyCam + Crew Check-in (Design Spec, 2026-06-17)

The last functional v1 slice. Two field-ops subsystems in one spec:
**(A) a PIN-authed crew field surface** (check in/out + photo upload) and
**(B) a CompanyCam integration** (link a job to a CompanyCam project; ingest
photos by reference). Both surface as agent activity (MILO / SCOUT) in the
Command Center. Both degrade gracefully without external accounts — the crew
surface is fully local; CompanyCam runs against a fake gateway in tests.

## Goal

Give field crews a low-friction way to prove presence and capture jobsite photos,
and let jobsite photos taken in CompanyCam flow into the job record — all visible
as agent activity. Done-when: a crew member can PIN-in on a phone, see their
assigned job, check in/out, and upload photos; and a CompanyCam `photo.added`
webhook attaches a photo to the right job.

## Non-negotiables honored
- **Tenant isolation on every query.** Crew actions derive `tenantId` from a
  signed crew cookie (NOT Clerk) and write through `withTenant`. The CompanyCam
  webhook (no session) resolves tenant via `adminDb` by a globally-meaningful id,
  then writes through `withTenant` (the `markEsignBySubmission` pattern).
- **No new external secrets in repo.** CompanyCam OAuth via Nango; crew cookie +
  CompanyCam webhook HMAC use existing token/secret env.
- **Ships with tests; typecheck + lint clean.**

---

## Subsystem A — Crew field surface

### Auth & session
- Entry: `/(crew)/crew/[key]` where `[key]` = `tenant.publicKey` (mirrors
  `/(public)/intake/[key]`). This scopes the PIN namespace to one tenant.
- Crew enters a PIN. `crewLogin(key, pin)`:
  1. `adminDb` resolves the tenant by `publicKey`.
  2. Fetches that tenant's `role='crew'` users (small N) and verifies the PIN
     against each `pinHash` with `verifyPin` (scrypt). First match wins.
  3. On success, sets a signed httpOnly cookie `crew_session` =
     `signPayloadToken({ tenantId, crewUserId, exp }, SECRET)` (the existing
     `@savvy/core` HMAC helper the booking tokens use). `signPayloadToken` takes
     `Record<string,string>` and has **no built-in expiry**, so `exp` is an epoch
     string (now + ~12h) that `getCrewSession` checks after verifying the HMAC.
     Cookie is `httpOnly` + `secure` + `sameSite=lax`.
  4. On failure, returns `{ error: "invalid PIN" }` (no lockout in MVP).
- `getCrewSession()` (`lib/crew-session.ts`) reads the cookie, verifies + checks
  `exp`, returns `{ tenantId, crewUserId } | null`. Every crew action calls it
  first; null → the action returns `{ error: "not signed in" }` and the page
  redirects to PIN entry.
- `crewLogout()` clears the cookie.

### PIN storage
- `user.pinHash text` (nullable). Hashed with Node `crypto.scrypt` (no new dep).
  `hashPin(pin)` → `scrypt$<saltHex>$<hashHex>`; `verifyPin(pin, stored)` does a
  constant-time compare. Both pure in `@savvy/core/crew-pin.ts` (unit-tested).
- Admin sets/clears a crew member's PIN via `setCrewPin(userId, pin | null)`
  (Clerk-authed action; verifies the target user is in the caller's tenant and
  has `role='crew'`). Minimal settings UI lists crew users with a "set PIN" input.

### Crew screens (`app/(crew)/crew/[key]/`)
- **PIN entry** — shown when no valid `crew_session`. A numeric PIN field →
  `crewLogin`. On success, reload to the jobs list.
- **Today's jobs** — for the signed-in crew user, the jobs they're assigned to
  with active/near-term crew work. MVP source: jobs where `job.assignedUserId =
  crewUserId` OR an `appointment(type='crew', assigneeUserId=crewUserId)` falls
  on today; in stages `approved`/`production`/`closeout`. Each links to the job
  view. (Tenant-scoped read via `withTenant(session.tenantId)`.)
- **Job view** `crew/[key]/job/[jobId]` —
  - Header: customer name + address (read via crew session tenant).
  - **Check in / Check out** button. Check-in requests `navigator.geolocation`
    (best-effort): on grant, passes `lat`/`lng`; on deny/timeout, proceeds
    without. Shows the current open check-in (since `checkedInAt`) if any.
  - **Photo upload** — reuses the 6A presign→R2→record flow via crew variants
    (`crewPresignPhoto`/`crewRecordPhoto`), with a small label select
    (`before`/`after`/`other`). `<input capture="environment">`.
  - **Photo gallery** — this job's photos (R2 via presigned views; CompanyCam via
    `externalUrl`).

### Crew actions (`lib/crew-actions.ts`, all guard `getCrewSession()` first)
- `crewCheckIn(jobId, lat?, lng?)`: assert the crew is assigned to `jobId`
  (within session tenant); `withTenant(tx => openCheckIn(tx, {...}))`;
  `recordAgentRun({ agent:'scheduling', taskKey:'crew.checkin', jobId, status:'ok' })`.
  Returns `{ ok, checkinId }` or `{ error }`.
- `crewCheckOut(jobId, lat?, lng?)`: `closeCheckIn` the open row; same guard.
- `crewPresignPhoto(jobId, { filename, contentType })` and
  `crewRecordPhoto(jobId, { r2Key, label, filename, mime, sizeBytes })`:
  same logic as 6A `presignDocumentUpload`/`recordDocument` but tenant +
  authorization come from the crew session, and the action re-asserts the crew
  is assigned to `jobId` and that `r2Key` is under `${tenantId}/${jobId}/`.

### crew_checkin table (migration 0011)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid v7 PK | |
| `tenantId` | uuid notNull → tenant | `tenantIsolation()` policy + `savvy_app` grant |
| `jobId` | uuid notNull → job | |
| `crewUserId` | uuid notNull → user | |
| `checkedInAt` | timestamptz notNull default now | |
| `checkInLat` / `checkInLng` | double precision nullable | match `property.lat`/`lng` type |
| `checkedOutAt` | timestamptz nullable | |
| `checkOutLat` / `checkOutLng` | double precision nullable | |
| `createdAt` | timestamptz | |

Index `(tenantId, jobId)`.
- `openCheckIn(tx, { tenantId, jobId, crewUserId, lat?, lng? })` inserts a row.
  If an open row (null `checkedOutAt`) already exists for that crew+job, returns
  it (idempotent — no duplicate open check-in).
- `closeCheckIn(tx, { tenantId, jobId, crewUserId, lat?, lng? })` sets
  `checkedOutAt`/coords on the latest open row for that crew+job; no-op if none.

---

## Subsystem B — CompanyCam integration

### Gateway (`packages/integrations/src/companycam.ts`)
- `interface CompanyCamGateway`:
  - `verifyWebhook(rawBody, signature): boolean` — HMAC sha256 of the raw body
    with `COMPANYCAM_WEBHOOK_SECRET`; allows empty secret in dev/test (fails
    closed in prod), matching `docuseal.verifyWebhook`.
  - `parseEvent(payload): { type: string; projectId: string; photoId: string; url: string; capturedAt?: string } | null`
    — extracts the load-bearing fields from CompanyCam's event shape.
  - `getPhoto(o): Promise<{ url: string }>` — defined for completeness (real
    fetch via `nangoProxy`), **unused in the reference-by-URL flow** but present
    so a future pull-to-R2 mode is a small change.
- `httpCompanyCam` real impl uses `nangoProxy({ integrationId: COMPANYCAM_INTEGRATION(), ... })`.
  Env: `NANGO_COMPANYCAM_INTEGRATION_ID` (default `"companycam"`),
  `COMPANYCAM_WEBHOOK_SECRET`, `COMPANYCAM_API_KEY` (presence flips the default
  export real↔fake).
- `makeFakeCompanyCam()` returns deterministic fakes + a `calls` array
  (qbo.ts pattern). Exported from `index.ts`.
- Real CompanyCam API/event/signature shapes are **best-effort/sandbox-validated**
  (like QBO/Roofr) — confirm against the live service before prod.

### Linking a job to a CompanyCam project
- `job.companycamProjectId text` (nullable). `linkCompanyCamProject(jobId, projectId)`
  (Clerk-authed, tenant-scoped) sets it; a small input on the job-detail Docs tab.
- `tenant.companycamConnectionId text` (nullable, Nango connection). Saved by
  `saveCompanyCamConnection(connectionId)` via `adminDb` scoped by `getTenantId()`
  (tenant table has no RLS; `savvy_app` can't UPDATE it — existing gotcha),
  verifying the Nango connection belongs to the caller's tenant (IDOR defense,
  like `saveQuickBooksConnection`). The Nango connect button is a stub like QBO's
  (real OAuth pending sandbox).

### Webhook (`app/api/companycam/webhook/route.ts`)
1. `raw = await req.text()`; `if (!httpCompanyCam.verifyWebhook(raw, sig)) → 401`.
2. `ev = httpCompanyCam.parseEvent(JSON.parse(raw))`; if null or not a
   photo-added event → `200 { ok: true }` (no-op).
3. `recordCompanyCamPhoto({ projectId, photoId, url, capturedAt })`
   (`@savvy/db lifecycle/companycam.ts`): `adminDb` finds the `job` with
   `companycamProjectId = projectId` (globally-unique mapping) → resolves
   `tenantId` → `withTenant` insert a `document` row
   (`kind:'photo', source:'companycam', externalUrl:url, jobId, customerId`).
   **Idempotent**: skip if a `companycam` document already exists for that
   `photoId` (store `photoId` to dedupe — see schema note). Unknown project →
   returns null → route responds `200` no-op.
4. On insert, `recordAgentRun({ agent:'scheduling', taskKey:'photo.companycam', jobId, status:'ok' })`.
5. Return `200 { ok: true }`. No Inngest needed — reference-by-URL is a single DB
   write (unlike 6B's heavy PDF finalize).

### document alters (migration 0011)
- `external_url text` nullable (CompanyCam-hosted URL).
- `r2_key` → **drop NOT NULL** (CompanyCam docs have no R2 object).
- `companycam_photo_id text` nullable (dedupe key for webhook idempotency).
- Display branch (Docs tab + crew gallery): `externalUrl ? <img src={externalUrl}> : presignedR2View`.
- CompanyCam photos are **unlabeled** (no `label`) → they appear in the gallery
  but do not auto-count toward the 6A completion-photo gate. (Labeling them is a
  future enhancement.)

---

## Agent surfacing (no schema/enum change)
- `recordAgentRun` calls use `agent='scheduling'` with `taskKey`
  `crew.checkin` (and `crew.checkout`) and `photo.companycam`.
- `resolveAgent` (`apps/web/src/lib/agents.ts`) gains one branch: for
  `agent==='scheduling'`, if `taskKey` starts with `photo.` → **SCOUT**, else →
  **MILO**. (A persona fronting more than one taskKey is already how ATLAS/NOVA
  share `comms`.) No new `AGENT` enum value; `claims` stays the pure
  insurance-add-on boundary. These runs auto-appear in the existing Command
  Center feed + the `scheduling` coverage card.

## Job detail integration
- Docs tab renders CompanyCam (`externalUrl`) photos beside R2 photos and adds
  the "Link CompanyCam project" input (admin).
- A check-in history strip on job detail shows recent `crew_checkin` rows
  (crew name + in/out times + distance-from-property when GPS present), attributed
  to MILO.

## Data flow (end to end)
*Crew:* `/crew/[key]` → PIN → `crewLogin` (scrypt verify) → signed cookie →
today's jobs → job → check in (best-effort GPS) → `openCheckIn` +
`recordAgentRun(scheduling/crew.checkin)` → MILO on the board + job; photo →
`crewPresignPhoto`→browser PUT R2→`crewRecordPhoto(source=savvy,label)`.
*CompanyCam:* admin links job→project → CompanyCam `photo.added` webhook → HMAC
verify → parse → `adminDb` job-by-project → `withTenant` insert
`document(source=companycam, externalUrl)` (dedup by `photoId`) →
`recordAgentRun(scheduling/photo.companycam)` → SCOUT + Docs tab.

## Error handling
- Invalid/expired crew cookie → action `{ error }` + page redirect to PIN entry.
- GPS denied/timeout → check-in proceeds with null coords.
- Crew not assigned to the job → action `{ error: "not your job" }` (fails closed).
- Webhook: bad HMAC → 401; unknown project / non-photo event / duplicate
  `photoId` → `200` no-op (idempotent).
- `crewRecordPhoto`: rejects `r2Key` not under `${tenantId}/${jobId}/` (IDOR).

## Testing
- `@savvy/core`: `crew-pin` — `hashPin`/`verifyPin` round-trip, wrong PIN fails,
  format/constant-time.
- `@savvy/db` integration: `crew_checkin` (open, idempotent re-open, close,
  close-with-no-open no-op, cross-tenant isolation); `recordCompanyCamPhoto`
  (resolve job by `companycamProjectId`, insert `source=companycam`+`externalUrl`,
  dedupe by `photoId`, unknown project → null, cross-tenant).
- `@savvy/integrations`: `companycam` fake gateway (`makeFakeCompanyCam` calls +
  `verifyWebhook` empty-secret allow + `parseEvent` shape) — qbo.test.ts pattern.
- Playwright e2e:
  1. **crew**: seed a `role='crew'` user with a known PIN + an assigned
     production job → `/crew/<publicKey>` → enter PIN → see the job → check in →
     check out → assert two `crew_checkin` states + a `scheduling/crew.checkin`
     `agent_run`.
  2. **companycam**: seed a job with `companycamProjectId` set → POST the webhook
     with a fake `photo.added` payload (empty HMAC secret in test, like docuseal)
     → assert a `source=companycam` `document` with `externalUrl` on the job +
     a `scheduling/photo.companycam` `agent_run` (→ SCOUT).
- Full gate: `pnpm typecheck && pnpm lint && pnpm test` green; both e2e pass.
- `.env.example` updated with the new CompanyCam env keys.

## Out of scope (this slice)
- Real-time/websocket crew status (Command Center stays poll/refresh).
- Offline PWA / service worker.
- Pull CompanyCam photos into R2 (reference-by-URL chosen; the gateway's
  `getPhoto` is defined so this is a future small change).
- PIN lockout / rate-limiting; crew push notifications.
- Customer photo sharing (`document.sharedWith` stays deferred).
- Auto-labeling CompanyCam photos / counting them toward the completion gate.
- Real CompanyCam API/signature validation (best-effort until sandbox creds).

## File structure
| Package | Create / modify |
|---|---|
| `packages/db` | schema: `crew_checkin` (new, in `schema/ops.ts`), alter `document` (+`external_url`,`companycam_photo_id`, `r2_key` nullable), `job` (+`companycam_project_id`), `user` (+`pin_hash`), `tenant` (+`companycam_connection_id`); migration `0011` (+ `rls-grants.sql` for the new table); `lifecycle/crew-checkin.ts`; `lifecycle/companycam.ts`; barrel exports |
| `packages/core` | `crew-pin.ts` (+test) |
| `packages/integrations` | `companycam.ts` (+`makeFakeCompanyCam`, +test); `index.ts` export |
| `apps/web` | `app/(crew)/crew/[key]/` (PIN entry, jobs list, job view); `lib/crew-session.ts`; `lib/crew-actions.ts`; `app/api/companycam/webhook/route.ts`; `lib/companycam-actions.ts`; `setCrewPin` action + minimal settings UI; Docs-tab render of `externalUrl` + link input + check-in strip; `resolveAgent` photo.* branch; e2e `crew.spec.ts` + `companycam.spec.ts` |
