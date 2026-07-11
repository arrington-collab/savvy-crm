# Show the Machine Working — Design

**Date:** 2026-07-10
**Status:** Approved (brainstorm)
**Scope:** Run-queue items **#6 (Activity Feed)** + **#7 (Showcase / Motion, S1–S6)**, built as one program.
**Owner rule:** every indicator binds to real `agent_run` / verification data — **nothing animates that didn't happen.**

---

## 1. Problem & intent

Savvy runs a roofing company with AI agents, but the work is invisible. The owner should be
able to *see the machine working* — live, honest, evidence-backed. The hard constraint is
**zero theater**: every animated element declares a real data source, a real trigger, and an
honest fallback. If a source can't be named, the element doesn't ship.

The prompt that initiated this (run-queue **#7**) has a hard dependency on run-queue **#6**,
the `/activity` feed, which **does not exist yet**. So the real deliverable is a **seven-slice
program**: a foundation (Activity Feed + the event channel) plus six motion slices layered on
top. Each slice is `worktree → TDD → PR`, Activity Feed first.

Out of scope: SupplementIQ / supplement drafting (separate add-on). No new nav item — nav
stays at 5.

## 2. Foundation findings (why the design is shaped this way)

Verified against the codebase 2026-07-10:

- **`agent_run`** (`packages/db/src/schema/agents.ts`) already has: `status` (free-text,
  default `"running"`, canonical set `running|ok|error|skipped`), separate `startedAt` +
  **nullable** `finishedAt`, both `jobId` and `leadId` (customer attribution via
  `coalesce(job_customer.name, lead_customer.name)`), `inngestRunId`, `modelUsed`, `tokens`,
  `costCents`, `error`.
- **Runs are written once, at completion.** `recordAgentRun()`
  (`packages/db/src/lifecycle/agent-run.ts`) always stamps `finishedAt: new Date()` on insert;
  nothing ever writes a `running` row and later updates it (`grep 'update(agentRun)'` = 0
  hits). **In-flight state is therefore not representable today** — this is the one wall the
  program must build through.
- **`listAgentActivity(tenantId, n)`** (`agent-run.ts`) is a ready-made, tenant-scoped,
  customer-attributed feed query — the foundation for `/activity`.
- **Verification framework** (`packages/core/src/verification/*`): `EvidenceResult =
  {status, details, refs}`, `EvidenceRef{type:"agent_run", ref, url?}`, builders
  `executed()` / `invariant()` / `reconciled()` / `sampledAudit()`. New checks are added to
  `evidenceChecks` in `checks.ts` and bound to a registry task via `CHECK_BINDINGS` in
  `packages/db/seeds/master-task-list.ts`. **No `activity.attribution` check exists.**
- **Entry points exist:** the "While you were out" panel (`today/page.tsx`) and the Agents
  page "Telemetry" link (`agents/page.tsx`) — the two doorways to `/activity`.
- **`getTodayDigest().totalActions`** already aggregates the 24h `agent_run` window (odometer
  substrate). **`summarizeAgentCoverage`** gives per-agent counts (shift-report substrate).
- **No realtime infra** (no SSE/WebSocket/polling of data). Live is greenfield. Convention
  today is `dynamic = "force-dynamic"` server components + `router.refresh()`.
- **Reduced motion:** pure-CSS convention — `.anim-*` classes inside
  `@media (prefers-reduced-motion: no-preference)` in `globals.css`. No JS hook yet.
- **`SageCore`** orb (`components/cockpit/SageCore.tsx`) is decorative; no data binding.
- **No `updated_at`** on `job` or `lead` — last-touch (S3) must derive from `agent_run`.

### Key architecture decision (approved)

**In-flight fidelity: instrument everything.** Adopt a full two-phase run lifecycle across
all agent write paths — maximum fidelity. This makes a **reaper mandatory**: a function that
crashes mid-run must not leave a stuck `running` row / spinner.

**Realtime transport: 15s client polling**, not SSE. Vercel serverless makes long-lived SSE
fragile; the feed spec explicitly allows "poll or SSE." A lightweight JSON route polled every
~15s with a subtle "live" indicator.

## 3. Config values (single source, tunable)

All in one config module in `@savvy/core` (per-tenant overridable later; program defaults now):

| Key | Default | Meaning |
|-----|---------|---------|
| `RUN_STALE_MINUTES` | 10 | reaper marks `running` rows older than this `error/timed_out` |
| `SPINNER_MAX_SECONDS` | 90 | UI never shows a live spinner for a run older than this (falls back to last completed) |
| `COLD_DAYS` | 7 | card goes cold/stuck past this many days since last touch |
| `POLL_SECONDS` | 15 | feed / card poll cadence |
| `REPLAY_SECONDS` | 90 | target wall-clock length of a day replay |

### `MINUTES_SAVED` (S2 odometer methodology — conservative, under-claims by design)

A taskKey (or category) missing from this map contributes **0 minutes, never a guess**, so the
odometer can only under-claim. The tooltip renders these equivalents as the cited methodology.

| Action | min | Action | min |
|--------|-----|--------|-----|
| draft estimate | 20 | enrichment (per property) | 5 |
| parse insurance / measurement | 15 | dunning / collections step | 5 |
| compose daily digest | 10 | commission calc | 5 |
| speed-to-lead first response | 3 | send SMS / reminder (drip) | 2 |
| alert rep | 2 | health-sweep / internal | 0 (excluded) |

## 4. The honesty-binding contract

Every animated element: **source → trigger → fallback.**

| Indicator | Real source | Trigger | Honest fallback |
|-----------|-------------|---------|-----------------|
| **S1 typing dots** | `agent_run` `status='running'`, `finishedAt=null`, attributed to the card | `running` row exists and `startedAt` < `SPINNER_MAX_SECONDS` | past cap or reaper-killed → no dots; show last completed done+evidence |
| **S1 resolve** | `completeAgentRun` → terminal `ok/error/skipped` | poll sees row went terminal | `error` → red + reason; `skipped` → neutral "no action needed" (not failure) |
| **S2 actions** | `getTodayDigest().totalActions` (24h, tenant TZ) | count increases between polls | zero → literal "quiet night", no count-up |
| **S2 minutes** | `Σ(MINUTES_SAVED[taskKey] × count)` | same as actions | missing taskKey → 0; tooltip cites each equivalent |
| **S3 heartbeat chip** | `max(agent_run.startedAt)` + human actions | static (no motion) | never touched → "no activity yet" |
| **S3 cold badge** | `now − lastTouch > COLD_DAYS` (tenant TZ) | static, links to `?job=` activity | entity younger than `COLD_DAYS` → no badge |
| **S4 shift report** | `summarizeAgentCoverage` → cheap-model call | n/a (text) | model fails → template narrative from same numbers; hype-linter strips adjectives |
| **S5 enrichment fill-in** | enrichment `agent_run` completing + field value | field null→value on poll | no run → field renders value, no animation |
| **S5 coverage glow + toast** | verification check `fail/stale → pass` | status transition observed | already-green doesn't glow; re-fail doesn't celebrate |
| **S5 orb pulse** | runs/hour = `count(agent_run last 60m)` | CSS `--pulse-rate` from that number | 0/hr → slow idle breath; never faster than real |
| **S6 replay** | historical `agent_run` for `?replay=<date>`, by `startedAt` | client scrubber (`REPLAY_SECONDS`), pause/speed | no rows → "nothing to replay" |

**Cross-cutting rules:**
- **Reduced motion** — CSS animations live in the `@media (prefers-reduced-motion:
  no-preference)` block; JS-driven motion (orb rate, odometer count-up) uses a new
  `useReducedMotion()` hook that short-circuits to the static end-state. Reduced-motion users
  see the same facts, no movement.
- **`skipped` ≠ failure** — a legitimate no-op (Stripe unconfigured, quiet-hours) renders
  neutral, never red, never a fake success. ~⅓ of real runs are `skipped`.

## 5. Slice-by-slice implementation

### Slice 0 — Activity Feed + event channel *(migration: indexes only)*

Foundation; **merges first**. Five pieces:

1. **Two-phase run lifecycle** (`packages/db/src/lifecycle/agent-run.ts`):
   `beginAgentRun(...)` inserts `status:'running'`, `finishedAt:null`, returns id;
   `completeAgentRun(id, {status, tokens, costCents, error})` updates to terminal;
   `recordAgentRun(...)` re-implemented as `begin`+`complete` so **every existing one-shot
   caller keeps working untouched**. Durable Inngest agents call the two-phase form at step
   boundaries.
2. **Reaper** (`packages/agents/src/functions/run-reaper.ts`, Inngest cron ~every 5 min):
   `running` rows older than `RUN_STALE_MINUTES` → `status:'error'`, `error:'timed_out'`.
3. **Verb map** (`packages/core/src/agent-verbs.ts`): `taskKey → {verb, category}`
   (`lead.rep.alert` → "alerted the rep", `ops.digest` → "sent the daily digest"), humanized
   fallback for unmapped keys. Shared by feed, cards, shift report.
4. **`/activity` route** (`apps/web/src/app/(app)/activity/{page.tsx,ActivityFeed.tsx}` +
   `apps/web/src/app/api/activity/route.ts`): reuses `listAgentActivity`, adds cursor
   pagination + filters (agent · `?job=`/customer · outcome · day) + 15s poll + "live" dot.
   The job Timeline tab and this feed **share one query/component**. Read-only. Reached from
   the "While you were out" header link + Agents "Telemetry" link. Nav stays 5.
5. **`activity.attribution` invariant** (`checks.ts` + `CHECK_BINDINGS`): flags `agent_run`
   rows with null `jobId` AND null `leadId` whose `taskKey` isn't in a sweeps/digests
   allowlist. Backfill writers that *could* attribute but don't.

**Migration:** indexes on `agent_run(tenant_id, started_at desc)`, `(job_id)`, `(lead_id)`,
`(status)`. Check the drizzle journal from the worktree before generating.

**Red-path tests:** seeded unattributed run trips `activity.attribution`; reaper flips a
>`RUN_STALE_MINUTES` `running` row to `error/timed_out`; feed `?job=` shows only that job;
error filter works; feed query stays tenant-scoped (RLS).

### Slice 1 — WORKING-NOW *(no migration)*

Durable Inngest agents adopt `beginAgentRun`/`completeAgentRun` at step boundaries. Card
indicator component (job board, pipeline board, lead rows) reads `running` rows attributed to
the entity; resolves to done+evidence on completion.

**Playwright:** seed a slow `running` run → dots render; advance past `SPINNER_MAX_SECONDS` →
dots gone, last-completed shown (no stuck spinner); `error` completion → red state.

### Slice 2 — ODOMETER *(no migration)*

`MINUTES_SAVED` config + odometer component in the Today header; count-up from real
`totalActions` and derived minutes; methodology tooltip from the same config.

**Tests:** zero-state → "quiet night" (no count-up); taskKey absent from config → 0 (unit);
count-up short-circuits under reduced motion.

### Slice 3 — HEARTBEAT *(no migration)*

`lastTouch(entity)` = `max(agent_run.startedAt)` (+ human actions) via the indexed query;
chip on job/lead/pipeline cards; cold badge past `COLD_DAYS`, links to `?job=` activity.

**Tests:** no-runs entity → "no activity yet"; fake-clock past `COLD_DAYS` → badge appears;
badge absent for young entities.

### Slice 4 — SHIFT REPORT *(no migration)*

Narrative composer over `summarizeAgentCoverage`, **cheap-model capability via the gateway**
(never a hard-coded model — CLAUDE.md #2), prepended to the existing exception digest; **same**
delivery times / break-glass rules. Template fallback on model failure; a hype-adjective
linter (test-enforced word list) keeps it factual.

**Tests:** model failure → template path; linter rejects "amazing/blazing/incredible/…";
digest still suppresses when there's nothing to say.

### Slice 5 — POLISH *(no migration)*

Enrichment fill-in on live lead view (null→value on poll); coverage-cell glow + toast **only**
on `fail/stale→pass` transition; `SageCore` gains a `--pulse-rate` custom prop = real
runs/hour (`count(agent_run last 60m)`).

**Tests:** orb rate never exceeds real runs/hour; `skipped` run doesn't celebrate;
already-green cell doesn't glow; all motion respects reduced-motion.

### Slice 6 — REPLAY *(no migration)*

`/activity?replay=<date>` reads that date's runs, client scrubber (`REPLAY_SECONDS`),
pause/speed, names visible, **read-only** (still auth-gated).

**Tests:** empty day → "nothing to replay"; no mutation path reachable in replay mode;
auth still enforced.

## 6. Non-negotiables honored (CLAUDE.md)

- **Tenant isolation** — feed/heartbeat/odometer queries all go through `withTenant` (RLS);
  a cross-tenant feed test stays green.
- **AI via gateway by capability** — S4 narrative uses a `cheap-classify`/`reason` capability,
  never a model string.
- **Durable + idempotent** — reaper is an Inngest cron; the two-phase lifecycle is
  crash-safe (reaper closes orphans).
- **No secrets in repo**; **tests + typecheck + lint** per slice; **small PR per slice**.

## 7. Verification (live on Bloom, stated per PR)

- **S0:** feed shows real Bloom activity with names; `?job=` filter from a job card works;
  error filter works.
- **S1:** a real running agent shows dots and resolves to evidence; no stuck spinner.
- **S2:** odometer counts real actions + minutes; zero-state reads "quiet night".
- **S3:** a genuinely-stale card shows the cold badge and links to its activity.
- **S4:** a shift-report SMS/email reads as first-person narrative over real numbers.
- **S5:** the orb visibly tracks a real burst of runs; a coverage cell glows on a real earn.
- **S6:** a real past day replays in ~90s with names visible.

## 8. Open items for review

- Minute-equivalents in `MINUTES_SAVED` (owner is the ops expert — adjust freely).
- The three thresholds `RUN_STALE_MINUTES=10`, `SPINNER_MAX_SECONDS=90`, `COLD_DAYS=7`.
- Whether S4's narrative *prepends to* vs *replaces* the exception digest body (design assumes
  prepend, keeping the actionable exception lines).
