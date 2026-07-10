# Leads Overhaul — Slice 3: Source Taxonomy + Referral Fees

**Date:** 2026-07-09
**Status:** Design approved — ready for implementation plan
**Worktree:** `.claude/worktrees/leads-slice-3` (branch `worktree-leads-slice-3`, off `origin/main` @ `c27396d`)
**Migration:** 0072 (see §7 — pinned at implementation after Slice 2's #172 / migrations 0070–0071 land)
**Source prompt:** `docs/superpowers/specs/prompts-leads-slices-2-5.md` (Slice 3 section)

## Goal

Replace the free-text (partly-picker) `lead.source` with a **structured source taxonomy** —
a closed enum + a `source_detail` jsonb with per-source conditional fields — and build the
**referral-fee money event** that pays a referrer when a referred lead's job collects its
first payment. Plus per-person attribution and a `lead.source_taxonomy` evidence check.

One combined slice (owner decision), one migration (0072).

## Key decisions (resolved during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Scope | ONE combined slice (taxonomy + referral fees + attribution) | Owner call; sequence taxonomy work before the finance/referral surface within the plan |
| Target taxonomy | Spec enum (`referral, insurance_agent, ads, realtor, partner, other`) + machine sources first-class (`web, inbound_call, canvass, direct_mail`) | Matches the owner spec's conditional-field/attribution design |
| Custom tenant sources | KEEP — a custom selection stores `source='other'` + label in `source_detail`; picker still lists `tenant.settings.leadSources` customs | Preserves the existing add-your-own feature while keeping the enum closed |
| Storage | `text` + core const `LEAD_SOURCE_VALUES` (app-enforced), NOT pgEnum | Consistent with roof types (Slice 2); avoids Postgres enum-alter pain when sources change |
| `referral_fee_cents` | In `source_detail` (referral), not a dedicated column | Per spec; the payable reads it from jsonb |
| Referral payable | NEW `referral_payment` table (commission-style idempotency), NOT reuse `commission` | Commission is per-USER sales pay; a referral fee is owed to an EXTERNAL person — distinct entity |
| First-payment guard | The payable's `unique(tenant_id, job_id)` doubles as the first-payment idempotency guard | One constraint enforces "once per job" AND "only first payment"; repeat `invoice/paid` is a no-op |
| Approval gate | Tenant threshold in `tenant.settings` (new core parser); over-threshold → `pending` + a `job_checklist_item` approval card (depreciation-style, stable key) | Reuses the two established approval patterns |
| Attribution | On-demand query function, NOT a materialized table/view | YAGNI — the #242 coffee list consumes it later |

## Non-goals (scope guards)

- **No CAC dashboard UI.** A `leadSourceSummary(tenantId)` query is enough; reporting UI is future.
- **No referrer/person entity.** Names live in `source_detail`; attribution aggregates on name.
- **No auto-payout/Stripe transfer** to referrers. The payable row + approval card is the deliverable; actually paying the referrer is out of scope.
- **No pgEnum.** `lead.source` stays `text`.
- **No change to the machine-source paths' behavior** beyond setting a valid enum member.

## Current-state anchors (from survey, read on `origin/main`)

- `lead.source`: `packages/db/src/schema/crm.ts:50` — `text("source")`, nullable. `lead` table at `:47`. No `source_detail`, no `referral_fee_cents` (greenfield).
- Zod: `packages/core/src/schemas.ts:37` `leadIntakeObject`; source at `:44` = `z.string().min(1).max(60).default("web")`; refined `leadIntakeSchema` at `:65`. Canvass omits source: `packages/db/.../canvass.ts:9` `leadIntakeObject.omit({ source: true })`.
- Creation writers: `apps/web/src/lib/intake.ts:34` `createLeadForTenant` (insert `source` at `:83`, emits `lead/created` at `:88`); server action `apps/web/src/lib/lead-actions.ts:9` `createLead`; intake API `apps/web/src/app/api/leads/route.ts:9,27`.
- Hard-coded machine sources: public intake `intake/[key]/page.tsx:24` (`"web"`), `api/canvass/contract/route.ts:70` (`"door-knocking"`), `api/twilio/inbound/route.ts:30` (`"inbound-call"`), `api/twilio/voice/route.ts:45` (`"after-hours-voicemail"`), `api/voice/vapi/route.ts:109,206` (`"inbound-call"`), `lib/intake-schedule.ts:54`.
- **Existing partial taxonomy:** `packages/core/src/lead-sources.ts` (`DEFAULT_LEAD_SOURCES`, `mergeLeadSources`); `apps/web/src/components/LeadSourceSelect.tsx`; custom sources in `tenant.settings.leadSources` via `packages/db/src/lifecycle/lead-sources.ts` (`getCustomLeadSources:5`, `addLeadSource`), actions `apps/web/src/lib/lead-source-actions.ts`. Form `apps/web/src/app/(app)/leads/new/NewLeadForm.tsx:32,54,113`.
- **Legacy value set** to migrate (Q2): stored — `web`, `door-knocking`, `inbound-call`, `after-hours-voicemail`, `referral`, `NULL`; picker — `referral, repeat, door_knock, storm_canvass, website, google, facebook, yard_sign, carrier, other`; test — `seed, e2e, test, other`. (Do NOT touch `document.source`/`measurement.source`/`estimate.source`/`customer.email_source`.)
- Payable/idempotency pattern: `commission` table `packages/db/src/schema/finance.ts:87-108` (unique `commission_tenant_invoice_uniq` `:104`); writer `packages/db/src/lifecycle/commission.ts:16` `recordCommission`; Inngest `commissionOnPaid` `packages/agents/src/functions/commission.ts:18` on `invoice/paid`.
- Threshold patterns: estimate `packages/core/src/estimate-settings.ts:23,38` (parked-timestamp over threshold); depreciation approval card `packages/db/src/lifecycle/depreciation-recovery.ts:9` (`DEPRECIATION_APPROVAL_TASK_KEY`, `job_checklist_item`, idempotent on `(jobId,key)` `:100,122`). Tenant settings jsonb `packages/db/src/schema/tenancy.ts:20`.
- Payment model: `payment` `finance.ts:73` (unique `(tenant, stripePaymentId)` `:84`); `invoice` `finance.ts:56` (`jobId`, `amountPaid` `:59`); `recordStripePayment` `packages/db/src/lifecycle/invoices.ts:79` (sets `invoice.status="paid"` at `:93-97`); Stripe webhook emits `invoice/paid` `apps/web/src/app/api/stripe/webhook/route.ts:52`; event typed `packages/agents/src/client.ts:27`. **No `job.firstPaymentAt` / first-payment concept exists.**
- Conversion: `convertLeadToJob` `packages/db/src/lifecycle/appointments.ts:198` (job insert carries `leadId`; does NOT copy source). `job.leadId` `packages/db/src/schema/jobs.ts:18`; job has no `source`.
- Reporting: `lead.source` only displayed (`leads-queries.ts:32,117`; `leads/page.tsx:94`; `leads/[id]/page.tsx:90`). CAC-by-source greenfield.
- Attribution/partner: greenfield (nothing exists).
- Evidence: `packages/core/src/verification/checks.ts:44` `evidenceChecks`; `packages/db/seeds/master-task-list.ts:46` `CHECK_BINDINGS`; **bound-set test** `packages/db/tests/master-task-list.test.ts:64-70` (adding a binding requires an assertion here).
- Migration: `origin/main` at idx 69 (`0069_narrow_miracleman`). Slice 2 (#172) adds 0070/0071.

## Design

### 1. Source taxonomy — schema + core

Core const + types (`packages/core/src/lead-sources.ts` extended, or a new `lead-source-taxonomy.ts`):

```ts
export const LEAD_SOURCE_VALUES = [
  // human/marketing
  "referral", "insurance_agent", "ads", "realtor", "partner", "other",
  // machine (first-class, exempt from the required-source rule)
  "web", "inbound_call", "canvass", "direct_mail",
] as const;
export type LeadSource = (typeof LEAD_SOURCE_VALUES)[number];

export const AD_PLATFORM_VALUES = ["google_lsa", "google_ads", "meta", "nextdoor", "other"] as const;
export const MACHINE_LEAD_SOURCES = ["web", "inbound_call", "canvass", "direct_mail"] as const;
```

`source_detail` zod **discriminated union** (`leadSourceDetailSchema`), keyed by source:

```ts
referral        → { referrer_name: string; referrer_contact?: string; referral_fee_cents?: number }
insurance_agent → { agency: string; agent_name?: string }
ads             → { platform: (typeof AD_PLATFORM_VALUES)[number] }
realtor         → { name: string; brokerage?: string }
partner         → { name: string }
other           → { note?: string; custom_source_key?: string; custom_label?: string }
web|inbound_call|canvass|direct_mail → {} (empty)
```

Schema (`packages/db/src/schema/crm.ts`, migration 0072): add `lead.sourceDetail: jsonb("source_detail")` (nullable). `lead.source` stays `text` (app-enforced against `LEAD_SOURCE_VALUES`).

### 2. Legacy migration — zero orphans

Migration 0072 includes a data step mapping **every** existing `lead.source` (and `NULL`):

| legacy | → source | source_detail |
|---|---|---|
| `web`, `website` | `web` | `null` |
| `door-knocking`, `door_knock`, `storm_canvass` | `canvass` | `null` |
| `inbound-call` | `inbound_call` | `null` |
| `after-hours-voicemail` | `inbound_call` | `{ "note": "after-hours voicemail" }` |
| `referral` | `referral` | `null` (referrer unknown for legacy) |
| `google` | `ads` | `{ "platform": "google_ads" }` |
| `facebook` | `ads` | `{ "platform": "meta" }` |
| `carrier` | `insurance_agent` | `null` |
| `yard_sign` | `other` | `{ "note": "yard sign" }` |
| `repeat` | `other` | `{ "note": "repeat customer" }` |
| tenant custom `X` | `other` | `{ "custom_label": "X" }` |
| test values `seed`/`e2e`/`test` | `web` | `null` |
| `other` | `other` | `null` |
| `NULL` | `web` | `null` |

Any value not in the map → `other` `{ "custom_label": <original> }` (belt-and-suspenders; SQL `CASE ... ELSE`).
**Red-path test:** after migration, `SELECT count(*) FROM lead WHERE source NOT IN (LEAD_SOURCE_VALUES)` = 0.

### 3. Required source on manual creation

- `leadIntakeObject` (`schemas.ts`): `source` becomes a `z.enum(LEAD_SOURCE_VALUES)` **required** (drop `.default("web")`); add `sourceDetail` validated by `leadSourceDetailSchema` refined against the chosen source (a manual `referral`/`insurance_agent`/`realtor`/`partner`/`ads` requires its detail's mandatory fields; `other` allows note/custom).
- **Machine paths keep a separate, non-refined insert** that sets a machine source programmatically (they must NOT be forced through the required-source picker rule). Provide `createMachineLead(...)` or let `createLeadForTenant` accept a pre-set machine source that bypasses the manual refinement. `canvass.ts` sets `canvass`; twilio/vapi set `inbound_call`; public intake sets `web`.
- **Legacy/back-compat:** the required-`referrer_name` rule applies only to NEW manual creation. Migrated legacy `referral` rows keep `source_detail = null` and are NOT retroactively invalid — the `lead.source_taxonomy` evidence check verifies the *source* is valid, not that detail fields are complete.
- UI: `NewLeadForm` + `LeadSourceSelect` render the enum members; on select, show that source's conditional follow-up fields (referrer name/contact/fee cents, agency/agent, ad platform, realtor name/brokerage, partner name, other note). Tenant customs from `tenant.settings.leadSources` remain selectable → `source='other'` + `source_detail.custom_label`.

### 4. Referral fee → payable money event

Schema (0072): new `referral_payment` table:
```ts
referralPayment = pgTable("referral_payment", {
  id, tenantId, jobId (FK job), leadId (FK lead), payeeName: text,
  amountCents: integer, status: text /* "pending" | "approved" | "paid" */, createdAt,
}, (t) => [uniqueIndex("referral_payment_tenant_job_uniq").on(t.tenantId, t.jobId), tenantIsolation()])
```

Config (core): `parseReferralConfig(tenant.settings.referral)` → `{ approvalThresholdCents: number | null }`.

**"First payment" interpretation:** the trigger is the job's first `invoice/paid` event (an invoice becoming fully collected). We do NOT track partial payments — `invoice/paid` is the only "money in" signal that exists, and the `unique(tenant_id, job_id)` guard makes the payable fire on whichever paid invoice comes first. This is the defensible reading of "first payment collected" with the current event model.

Flow (agents Inngest fn on `invoice/paid`, or extend an existing subscriber):
1. Resolve the paid invoice's `job` and its `lead` (`job.leadId`). No payment-counting needed — the `referral_payment` `unique(tenant_id, job_id)` + `onConflictDoNothing` guarantees at-most-once per job (on the first paid invoice).
2. If `lead.source = 'referral'` and `source_detail.referral_fee_cents > 0`:
   - Read `parseReferralConfig`. If `fee <= threshold` (or threshold null → treat as auto) → insert `referral_payment{ status: "approved" }`.
   - Else → insert `referral_payment{ status: "pending" }` AND create the approval card `job_checklist_item{ key: "finance.referral_fee_approval" }` (idempotent on `(jobId,key)`, depreciation-style).
3. A one-tap approve action flips `pending → approved` (and clears the card).

Idempotency: `unique(tenant_id, job_id)` on `referral_payment` + `onConflictDoNothing` → **exactly once per job**.
**Red-paths:** repeat `invoice/paid` → still one row (idempotent); `fee > threshold` → card created, status `pending` (NOT auto-approved).

### 5. Attribution + CAC (query-only)

- `referredRevenueByPerson(tenantId)` (db query): join `lead` (source in referral/insurance_agent/realtor/partner) → its job → collected revenue; group by the person name pulled from `source_detail` (referrer_name / agent_name / realtor name / partner name). Returns `{ name, source, jobCount, revenueCents }[]`. No new table.
- `leadSourceSummary(tenantId)`: group leads by the new enum → `{ source, leadCount }[]` (+ optional value). For CAC/source reporting. Query-only.

### 6. Evidence binding

- New check `lead.source_taxonomy` in `checks.ts` `evidenceChecks`: a manually-created lead (non-machine source path) has `source ∈ LEAD_SOURCE_VALUES` and non-null; machine-sourced leads (`MACHINE_LEAD_SOURCES`) are exempt. Follow the existing `invariant(...)` helper shape used by the other `lead.*` checks.
- Bind in `CHECK_BINDINGS` (`master-task-list.ts`) to the "Referral tracking & source attribution" / "Lead source" registry task (confirm the id from the seed CSV — candidates 3 or 31) + add the matching assertion in `master-task-list.test.ts:64-70`.

### 7. Migration + branch base

- **One migration 0072**: `lead.source_detail` jsonb; `referral_payment` table (+ RLS `tenantIsolation()`); the legacy data-mapping UPDATE. `lead.source` stays `text`.
- **Branch base:** Slice 2 (#172) is green and about to merge. **Rebase this branch onto `main` after #172 merges**, then `pnpm db:generate` yields 0072 (journal will be at 0071). If implementation must start before #172 merges, stack on the Slice 2 branch instead — either way the number lands at 0072. Never generate against the stale 0069 base (would collide with #172's 0070).

## Testing

**Core unit (no DB):** `LEAD_SOURCE_VALUES`/`AD_PLATFORM_VALUES` membership; `leadSourceDetailSchema` discriminated-union validation (each source's required fields; `other` custom/note); `parseReferralConfig` (threshold/default); referral-fee decision helper (`fee <= threshold → approved` vs `→ pending`).

**DB / integration:** migration maps every legacy value + `NULL` → **red-path zero orphans**; `source` + `source_detail` round-trip; `referral_payment` insert + **unique(tenant,job) idempotency red-path** (second insert is a no-op); `referredRevenueByPerson` / `leadSourceSummary` aggregate correctly; manual `createLead` requires source + valid detail; machine-source insert bypasses the required rule.

**Agents:** `invoice/paid` first payment on a referral job → one `referral_payment{approved}` when under threshold; **over-threshold red-path** → `pending` + approval card; repeat `invoice/paid` → still one row.

**Evidence:** `lead.source_taxonomy` red-path — a manually-created lead with null/unknown source fails the invariant; a machine-sourced lead is exempt.

**e2e (Playwright):** `NewLeadForm` requires a source and shows the conditional fields per source; a referral with a fee persists into `source_detail`; a tenant custom source → `other` + `custom_label`.

## Deploy + prove it (post-merge, owner-gated)

1. Apply migration 0072 to prod Supabase from this worktree via MCP `apply_migration` + a manual `__drizzle_migrations` ledger row (pooler can't DDL — same pattern as 0068–0071). The legacy data UPDATE runs inside the migration.
2. Verify by query: zero `lead.source` outside `LEAD_SOURCE_VALUES`; spot-check a few remapped rows' `source_detail`.
3. Live-check as a signed-in Bloom user: create a manual referral lead with a fee; confirm the picker's conditional fields; (finance) simulate a first payment on a referred job and confirm the `referral_payment` row + approval card behavior at/over threshold.
4. PR description lists: migration 0072, invariant bound (`lead.source_taxonomy`), the legacy value→enum mapping table, and live-verify output.

## House rules (unchanged)

TDD; one PR for the slice; watch CI (`gh pr checks <n> --watch`). Per-tenant timezone. No literal secrets. Parsed/enriched values never overwrite owner-confirmed data. Update `first-20-cells.md` STATUS only if evidence states change; log as post-contract work in the PR description.
