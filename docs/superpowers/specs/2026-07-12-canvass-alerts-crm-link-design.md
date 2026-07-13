# Canvass Slice 2 — Sale→Contract Alerts & CRM Deep-Link — Design

**Status:** Draft for review
**Date:** 2026-07-12
**Builds on:** Slice 1 (v1.16.0-beta, shipped) and the gamification phases. Field app repo: `~/Sites/savvy-canvass`; backend: `savvy-crm`.

## Problem

Two field-feedback items share one missing piece — a durable link from a **sale knock** to the **contract/customer it became**:

- **#2** When a rep logs a sale but no signed contract follows within **30 minutes**, the **manager and the selling rep** should be alerted in-app (text later). Right now nobody is told; deals stall silently.
- **#1b** A sale in the End-of-Day report (and in an alert) should offer a **"View in CRM"** deep-link to the customer record — for a signed-in manager.

Both need the same foundation: knowing whether a given sale got a contract, and which CRM lead it created.

## Decisions (confirmed with Brett)

- Report/customer link target = **Both** — the in-app contact card (shipped in Slice 1) plus a "View in CRM" link that opens the lead in `savvy-crm` (realistically a signed-in manager).
- No-contract alert recipients = **managers + the selling rep**.
- In-app now; **text is a later phase** (Twilio is still mock-only on prod). The design leaves a clean SMS seam but does not build it.

## Architecture

The linkage rides on the **knock itself**, which avoids touching the contract intake path:

```
Rep logs a sale  ──▶ canvass_knock (outcome=sale, contract_signed_at=NULL)
      │                         │
      │                         └─▶ knocks route emits  canvass/sale.logged {knockId}
      │                                     │  (idempotent: event id = "sale:"+knockId)
      ▼                                     ▼
 Contract flow          Inngest  canvassSaleContractWatch
   signs?                 sleep 30m ─▶ re-read knock
      │                      • outcome still "sale" AND contract_signed_at IS NULL
      ▼                         └─▶ write canvass_alert rows (seller + each active manager)
 field app POSTs /contract      • else → no alert (contract landed in time)
   → gets {leadId} back
      │
      └─▶ field app STAMPS the sale knock: contract_signed_at = now, lead_id = leadId
           and re-upserts it (same clientId, same rep → allowed by the upsert's
           anti-steal setWhere).  This both silences the 30-min watcher and gives
           #1b its CRM lead id.
```

Why this shape:
- **No contract-route change.** `/api/canvass/contract` already returns `{ leadId }` synchronously (`createLeadForTenant`). The field app is the one place that knows both the sale knock and the resulting lead, so it does the stamp.
- **The knock is the source of truth** for "did this sale get a contract" — consistent with the whole gamification "derive from knocks" architecture.
- **The watcher is a pure timer.** It reads state at +30 min; it never has to correlate two independent writes.

## Data model changes

### `canvass_knock` — two new columns (additive)

```
contract_signed_at  timestamptz NULL   -- stamped by the field app when the sale's contract signs
lead_id             uuid NULL          -- FK → lead(id) ON DELETE SET NULL; the CRM lead the contract created
```

`upsertCanvassKnock` adds both to its mutable `onConflictDoUpdate` set (so a same-rep re-upsert can stamp them). The existing anti-steal `setWhere` (only the original rep may edit) is unchanged — the seller is the one stamping, so it passes.

### `canvass_alert` — new table (one row per recipient)

```
canvass_alert(
  id           uuid pk,
  tenant_id    uuid not null → tenant(id) cascade,
  kind         text not null,                 -- 'sale_no_contract' (only kind in v1)
  rep_id       uuid not null → canvass_rep(id) cascade,   -- the recipient
  knock_id     uuid → canvass_knock(id) set null,          -- the sale in question
  lead_id      uuid → lead(id) set null,                    -- for a CRM deep-link if present
  title        text not null,
  body         text not null,
  created_at   timestamptz not null default now(),
  read_at      timestamptz NULL              -- per-recipient read state
)
  RLS: tenant_isolation (savvy_app), same as every canvass table
  index (tenant_id, rep_id, read_at)   -- unread-per-rep lookups
```

**One row per recipient** (seller + each active manager at alert time). Rationale: gives clean per-user unread counts and read state, and a small tenant's manager set is tiny. New managers added *after* an alert fires won't see that past alert — acceptable for point-in-time event alerts.

## Backend — endpoints (all bearer + rate-limited, tenant-scoped via `withTenant`)

- `GET /api/canvass/alerts` — alerts where `rep_id = caller`, newest first, plus an `unread` count. Any authenticated rep (managers and reps both have explicit recipient rows).
- `POST /api/canvass/alerts/:id?action=read` — mark one alert read (only if `rep_id = caller`; returns `{ ok }`).
- `POST /api/canvass/alerts?action=read-all` — mark all the caller's alerts read (convenience for the bell "clear").
- Middleware allowlist extended for `alerts` and `alerts/:id`.

The `/eod` `sales[]` (Slice 1) and `/knocks` responses gain a `leadId` field (from the new column) so the field app can build the CRM link without another call.

## Backend — Inngest workflow

`canvassSaleContractWatch` (`packages/agents/src/functions/`):
- Trigger: event `canvass/sale.logged` `{ tenantId, knockId, repId }`.
- `step.sleep("30m")`.
- `step.run`: in `withTenant(tenantId)`, re-read the knock. If `outcome === "sale"` and `contract_signed_at` is null:
  - Guard idempotency: if a `sale_no_contract` alert already exists for this `knock_id`, stop (no dupes).
  - Resolve recipients: the seller (`repId`) + all active managers (`isCanvassManager`/`canvass_rep.manager = true`).
  - Insert one `canvass_alert` per recipient with a clear title/body ("Sale with no contract yet — <contact/address>, 30 min elapsed").
- Registered in `packages/agents/src/index.ts` (import + `functions[]`), like `challengeSettleHourly`.

**Emit point:** the knocks route (`upsertCanvassKnock` caller), after a successful upsert whose result is `outcome === "sale"` and `contract_signed_at` is null, sends `canvass/sale.logged` with **event `id: "sale:" + knockId`** so Inngest dedupes re-emits (edits, appt→sale re-saves) — the 30-min clock starts once per sale and never restarts.

**SMS seam (not built this slice):** the recipient-insert step is the single place a future `getTenantSms` call for managers would attach. Documented, not implemented (Twilio mock on prod).

## Field app (`~/Sites/savvy-canvass`, next version `v1.17.0-beta`)

1. **Stamp on contract success.** In the contract-submit success handler (where `{ leadId }` comes back), set `k.contractSignedAt = Date.now()`, `k.leadId = leadId` on the originating sale knock (`pendingSaleKnockId`) and re-push it (`pushKnock`). The knocks POST body includes `contractSignedAt` + `leadId`.
2. **Alerts bell.** A bell in the header with an unread badge. Tapping opens an **Alerts** sheet listing the caller's alerts (title, body, time, unread dot). `pullAlerts()` runs on the existing 30-sec sync; opening the sheet marks them read (`read-all`). Each `sale_no_contract` alert row links to the sale — its in-app contact card (`openReportSale`/`openDetail`) and, for a manager, a "View in CRM" link.
3. **CRM deep-link (#1b).** `crmBase() = canvassBase().replace(/\/api\/canvass$/,'')`. A sale with a `leadId` shows **View in CRM** → `crmBase()+"/leads/"+leadId` (opens in a new tab; only useful to a signed-in manager, which is the intended audience). Added to both the report sale card (Slice 1's `openReportSale`) and the alert item. A sale with no `leadId` (no contract yet) shows no CRM link.
4. Version bumps: `APP_VERSION='1.17.0-beta'`, `sw.js` `V='canvass-v1.17.0'`.

## Testing

- **Pure/unit** — n/a for most (the logic is DB + timer); the recipient-resolution and the "should-alert" predicate (`outcome==='sale' && !contractSignedAt && no existing alert`) get a small unit if extracted.
- **DB-backed** (`packages/db` + route logic): knock stamp persists `contract_signed_at`/`lead_id`; alert insert + `listAlerts` scoping (a rep sees only their own rows); mark-read flips `read_at` only for the owner; the watcher's should-alert predicate (sale + null contract → N recipients; contract stamped → 0; existing alert → 0 dupes). Follow `canvass-knock-upsert.test.ts` / `canvass-spiff.test.ts` patterns; clear synthetic task_registry debris and run `--no-file-parallelism`.
- **Idempotency**: two `canvass/sale.logged` for one knock → one watcher → one set of alerts.
- `pnpm typecheck && pnpm lint && vitest` clean; the pre-existing `@savvy/integrations` vapi.ts error is ignored.

## Non-goals (YAGNI)

- **No SMS/text this slice** — in-app only; the manager-notify SMS seam is documented, not built.
- **No push notifications / web-push.**
- **No alert preferences or per-tenant thresholds** — 30 minutes is fixed in v1 (a constant, easy to lift later).
- **No auto-dismiss** of an alert if the contract is stamped *after* the 30-min mark — the alert is a point-in-time nudge; a late stamp just leaves a stale (harmless) alert. Revisit only if it annoys.
- **No new alert kinds** beyond `sale_no_contract` (the `kind` column is generic for the future).
- **No CRM SSO from the field app** — "View in CRM" is a plain link; whoever taps it authenticates with their own Clerk session (managers on a laptop).

## Risks / edge cases

- **Offline stamp.** If the contract signs but the knock re-upsert doesn't reach the server (rep offline), the watcher fires a *false* no-contract alert. Mitigation: the field app already re-syncs knocks (`resyncKnocks`), so the stamp lands on reconnect; the alert is a nudge, not a hard failure. Acceptable for v1.
- **appt→sale edits.** A knock edited from appt to sale triggers the watcher via the same emit rule; idempotent event id keeps it to one watcher.
- **Manager set changes.** Recipients are resolved at alert time; later-added managers don't see past alerts (fine for events).
- **Rate limits.** `pullAlerts` on the 30-sec sync uses the existing `canvass-read` bucket; well within limits.

## Migration & deploy

- One additive migration: two nullable columns on `canvass_knock` + the `canvass_alert` table (+ RLS/indexes/FKs, all guarded). No backfill. Local drizzle number = prod number − 1 (apply via Supabase MCP as the next prod number).
- Backend deploy `vercel --prod --archive=tgz --force`; field app `wrangler pages deploy`.

## Open questions

- **CRM link text/placement** on the alert vs the report — assumed a small "View in CRM" link; fine to tune in the plan.
- **Bell placement** in the field-app header — assumed top-right next to the existing sync chip; confirm during build.
