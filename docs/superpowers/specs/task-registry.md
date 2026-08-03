# Spec: Task Registry, Evidence Bindings & Health Sweep ("The Scoreboard")

**For:** next Claude Code session on `savvy-crm` · place in `docs/superpowers/specs/task-registry.md`
**Depends on:** PRs #81/#82/#83 merged (merge order per 2026-06-30 handoff; watch the `0037` migration collision — check `drizzle/meta/_journal.json` for the actual next number before generating, likely `0039`).

---

## Why this exists (context for the agent building it)

The owner runs a $25M roofing company (VRZA) full-time. Savvy exists to run **other** roofing companies (Northwind/Denver first, Bloom/AZ, then acquisitions) in the background — take each to $3–5M, move to the next. The owner's attention is the strict limit. Therefore:

1. **Everything defaults to background.** A feature that requires the owner to check a screen is a defect.
2. **Trust comes from proof-of-execution, not from a screen you have to check.** Headless ops (invoices, billing, commissions auto-calculate with no CRUD frontend) are only safe if the system *proves* work happened AND was correct.
3. **The checker is never the doer.** Verification is deterministic SQL, external reconciliation, or a *different* model — never the agent grading its own work.
4. **Human attention arrives batched.** Exceptions collect into scheduled digest sessions; only break-glass severity interrupts the owner's day.

This spec builds the spine that makes all of that real: the 212-task Master Task List as a live, evidence-verified registry.

---

## Data model (one migration + one seed)

### `tenant` (alter)
```
timezone        text NOT NULL DEFAULT 'America/Phoenix'   -- preserves current behavior
digest_times    jsonb DEFAULT '["07:00","17:00"]'          -- local times for exception digests
break_glass     jsonb DEFAULT '{"min_dollars":10000,"deadline_hours":48}'
```
Set Northwind = `America/Denver`. **Every cron, customer-facing time string, and business-hours rule must read `tenant.timezone`** — remove all hardcoded `TZ=America/Phoenix` from Inngest functions as part of this work.

### `task_registry` — global, seeded from the Master Task List PDF (212 rows)
| column | type | notes |
|---|---|---|
| `id` | int PK | the master task number (1–212) — stable forever |
| `slug` | text unique | e.g. `lead.dedupe`, `claims.supplement.file` |
| `name`, `description` | text | from the PDF |
| `phase` | int | 1–15 per the PDF |
| `default_owner` | enum | `SAGE·ATLAS·NOVA·MILO·VERA·SCOUT·HUMAN` |
| `default_mode` | enum | `full_auto · assisted · manual` (seed from the PDF's automation column) |
| `scope` | enum | `per_job · per_lead · per_tenant_recurring · one_time` |
| `applies_to` | jsonb | job types + peril tags, e.g. `{"job_types":["insurance"],"perils":["hail","wind"]}` |
| `depends_on` | int[] | task-graph edges (drives `blocked_by` on job instances) |
| `check_key` | text nullable | key into the code-side evidence-check registry (below) |
| `check_params` | jsonb | per-task params for the check |
| `verification_tier` | enum nullable | `execution · invariant · reconciliation · sampled_audit` |
| `sla_hours` | int nullable | drives exception escalation |
| `est_founder_minutes` | numeric | used to rank which manual task to automate next |

No RLS (global read). Registry edits happen via seed migrations only — it's versioned source, like the price book.

### `tenant_task_config` — RLS by tenant
`(tenant_id, task_id)` unique · `mode` override · `enabled` bool · `params` jsonb (thresholds like approval limits). This is how Northwind and Bloom diverge (CO hail playbook vs AZ wind/monsoon) without forking the registry.

### `job_task` — per-job instantiation · RLS
| column | notes |
|---|---|
| `id` uuid, `tenant_id`, `job_id`, `task_id` | unique `(job_id, task_id)` |
| `status` | `pending · in_progress · done · verified · exception · failed · skipped · not_applicable` |
| `owner` | agent name or user id at execution time |
| `evidence` | jsonb `{type, ref, url?}` — e.g. `{"type":"sms","ref":"SM9f…"}`, `{"type":"qb_invoice","ref":"1042"}` |
| `agent_run_id` | fk nullable — links to the existing command-center feed |
| `completed_at`, `verified_at` | `done` is claimed by the doer; `verified` is granted by the sweep |

Instantiated at job creation from registry, filtered by `applies_to` + tenant config; `depends_on` unmet ⇒ `pending` with a computed `blocked_by`. **This table is the Job Ledger** and the ground truth Sage cites when asked "is X done?" — answers must cite `job_task` rows + evidence refs, never model memory.

### `verification_run` — history · RLS
`(tenant_id, task_id, check_key, status: pass·fail·stale·skip, details jsonb, refs jsonb, ran_at)`. Feeds streak computation and debugging. Prune > 180d via the existing cold-archive pattern.

### `task_health` — the scoreboard · RLS
`(tenant_id, task_id)` unique · `status: green·amber·red·gray` · `effective_mode` · `clean_streak_days` · `last_executed_at` · `last_verified_at` · `fail_count_7d` · `open_exception_count` · `founder_minutes_30d` · `updated_at`.

**Status rules (encode exactly):**
- **gray** — manual mode or no `check_key`
- **green** — earned, never declared: `clean_streak_days ≥ 14` AND no open exceptions AND last verification within its expected window
- **amber** — verification `stale` (didn't run when expected), single `fail`, or open exception past SLA
- **red** — verification `fail` on work claimed `done` (done-but-wrong), or 2+ consecutive fails
- Any green→amber/red transition emits an exception (see below)

---

## Evidence-check framework (code, not SQL-in-rows)

Checks live in code — versioned, typed, testable — mirroring the enricher registry pattern from #81. The DB stores only the `check_key` + params.

```ts
// packages/core/src/verification/checks.ts
type EvidenceStatus = 'pass' | 'fail' | 'stale' | 'skip'
interface EvidenceResult { status: EvidenceStatus; details: string; refs: EvidenceRef[] }
type EvidenceCheck = (ctx: { tenantId: string; db: Db; params: Json; window: DateRange }) => Promise<EvidenceResult>
export const evidenceChecks: Record<string, EvidenceCheck>
```

Four builder helpers, one per verification tier:

1. **`executed(action, within)`** — tier `execution`: an `agent_run` with this action exists in the window. Proves it *ran*.
2. **`invariant(name, queryFn)`** — tier `invariant`: deterministic SQL against prod state; the workhorse. Proves it's *right* (checker ≠ doer: math checks the agent).
3. **`reconciled(fetchExternal, compare)`** — tier `reconciliation`: third-party ground truth (QuickBooks AR, Stripe payouts, carrier portal). Fail-soft on vendor downtime → `stale`, not `fail`.
4. **`sampledAudit(sampler, judgePrompt, threshold)`** — tier `sampled_audit`: a *different, cheap* model re-does a random sample (re-price 5% of estimates from the price book; score call transcripts against the Library tone rubric). Runs **weekly** not nightly; hard cost cap per tenant per week in `tenant_task_config.params`; disagreement ⇒ `fail`.

### Seed bindings — start with ~18, and turn today's observed prod bugs into permanent invariants:

| task | check (tier) |
|---|---|
| `lead.dedupe` (#18) | invariant: zero active lead pairs sharing normalized phone or address |
| `lead.enrich.geocode` | invariant: % of leads > 24h old with lat/lng ≥ threshold; enrichment_attempt ledger consulted |
| `lead.enrich.stormproof` | same pattern, year/roof/county fill rate |
| `lead.score` | invariant: every lead > 1h old has score + rationale |
| `lead.speed_to_contact` | invariant: first outbound within 5m of lead creation (business hours, tenant TZ) |
| `comms.no_double_send` | invariant: **no two outbound messages, same template + same recipient, within 24h** (today's double-send bug, permanently caught) |
| `comms.body_quality` | invariant: **no outbound body containing "GMT" or a URL > 40 chars** (today's raw-JWT-link and GMT-timestamp bugs) |
| `comms.delivery` | invariant: sent SMS have delivery receipts; bounce rate < threshold |
| `drip.appended_guard` | invariant: zero EMAIL drip steps sent to `email_source='appended'` (from #83) |
| `email.policy` | invariant: no `self_reported` email ever overwritten by `appended` (audit the history) |
| `booking.reminders` | executed + invariant: every future appointment has reminder scheduled |
| `exceptions.roof_type` | invariant: no job in `inspected..billing` missing roof_type for > SLA without an open exception (from #82) |
| `finance.qb_reconcile` | reconciled: Savvy AR == QuickBooks AR nightly |
| `finance.stripe_match` | reconciled: payouts == payments ledger |
| `finance.invoice_math` | invariant: invoice totals == line items × current price book version |
| `finance.commissions` | invariant: accruals == plan % × collected GM |
| `estimate.audit` | sampledAudit weekly: independent re-price of 5% of sent estimates |
| `calls.audit` | sampledAudit weekly: transcript rubric scoring |

Everything else in the 212 seeds as `manual` / gray. The Coverage Map fills as bindings are added — that's the roadmap working as designed.

---

## Nightly health sweep

`task-health-sweep` — Inngest cron, per tenant (mirror `enrichment-sweep`/`cold-archive` fan-out), at **04:00 tenant-local** (compute from `tenant.timezone`; do not hardcode TZ).

Per tenant, in order:
1. **Run evidence checks** for every enabled task with a `check_key` (weekly-tier checks only on their day). Per-check timeout 10s, fail-soft to `stale`, whole sweep budget 5m. Write `verification_run` rows.
2. **Spot-verify claimed work:** for `job_task` rows marked `done` since last sweep, run the owning task's check scoped to that job; pass ⇒ `verified`, fail ⇒ `exception` (done-but-wrong is the highest-value catch).
3. **Update `task_health`:** streaks, counts, status transitions per the rules above.
4. **Emit exceptions** — computed vectors per the #82 pattern (state-derived, no marker columns): `task_regression` (green→amber/red, with the failing check's details + refs), `task_stale`, `verification_mismatch`. Rank by `est_founder_minutes`-weighted dollar impact where known.
5. **Rollups:** per-tenant coverage (`full_auto green / 212`), exceptions-per-job (30d), founder-minutes (30d) → a small `tenant_ops_rollup` row for the portfolio view.
6. **Record an `agent_run`** (`action='ops.health_sweep'`, summary counts) so the sweep itself appears in the feed — the scoreboard is also on the scoreboard (bind it to its own task id).

### Notification policy (protects the VRZA day job)
Exceptions **never page by default**. They queue into Today and go out in the digest at `tenant.digest_times` (SMS/email summary: count, top item, est. minutes). Immediate SMS only when a `break_glass` rule matches (≥ $10k impact or hard deadline < 48h, e.g. carrier supplement windows). This policy is itself a Library document and a registry task with an invariant (no non-break-glass SMS to owner outside digest times).

### Founder-minutes instrumentation
On exceptions: `opened_at`, `first_viewed_at`, `resolved_at`, `resolved_by`. Minutes = Σ(resolved − first_viewed), capped at 30m/item. Surfaces per-task in `task_health.founder_minutes_30d` → **the automation priority queue is: manual/assisted tasks sorted by founder-minutes, descending.** That ordering is the empire roadmap.

---

## Build slices (worktree per slice off `origin/main`, spec → TDD → PR → watch CI — per established process)

1. **Schema + seed** — migration (tenant.timezone etc. + 5 tables), seed script `packages/db/seeds/master-task-list.ts` from the PDF (owner supplies the PDF → structured JSON in-repo so the 212 are code-reviewed). Tests: RLS on all tenant tables, seed integrity (212 rows, phases sum, unique slugs).
2. **Evidence framework + first 18 bindings** — `packages/core/src/verification/`, the four builders, checks above. Tests: each check green-path + red-path with fixture data (esp. `no_double_send`, `body_quality`, `dedupe` — write the failing fixtures straight from the prod bugs observed 2026-07-01).
3. **job_task instantiation** — on job create + backfill for active jobs; agents write `done` + evidence at execution points (start with booking, drip, invoice paths). Tests: instantiation filtering by job type/tenant, dependency blocking, evidence writes.
4. **Health sweep + exceptions + rollups** — the cron, status rules, computed exception vectors, digest sender honoring `digest_times`/`break_glass`. Tests: streak math, green-earning (14 days), regression emission, done-but-wrong flip, TZ correctness for both tenants.
5. **UI (read-only)** — Coverage Map on Today/Agents, Job Ledger section on job detail, Sage tool `get_job_ledger(job_id)` + `get_task_health(task_id)` so "is X done?" answers cite rows. No CRUD anywhere in this slice.

## Definition of done — for this build and every future feature

Add to the PR template: **"Which task IDs does this feature execute, and what proves it ran and ran correctly?"** A feature that can't answer that is frontend, and frontend is a defect unless it's an exception card or a proof surface. That one rule keeps every future session pointed at background ops.
