# D2b — Material-delivery misalignment → Exception Queue — Design

**Date:** 2026-06-27
**Slice:** Jobs build, slice D2b. Surfaces an existing D2a signal into slice J's Exception Queue.

## Problem

D2a built a stored `material_order` (from an accepted estimate) with a snapshotted `neededByAt`
(= install date − 2 days) and a pure core helper `materialDeliveryFlag` that derives delivery
health (`none | no_install | misaligned`). But that flag is only shown passively in the cockpit
Materials panel — nothing **routes a misaligned delivery to the people who must act on it.** If a
crew install is moved earlier after materials were ordered, the materials now arrive *after* the
crew shows up, and no one is told.

## Goal

Surface material-delivery risk as a first-class **Exception Queue** item (slice J's `/exceptions`
worklist), so an at-risk delivery shows up in the same tenant-wide "needs you" list as overdue
invoices, missed appointments, and stuck jobs.

## Approach

Add a **fifth exception vector** to the existing pure `buildExceptionQueue` (slice J), reusing
D2a's `materialDeliveryFlag` as the single source of truth for what "misaligned" means. The web
data-gathering layer (`exception-queries.ts`) fetches draft/ordered material orders + each job's
current earliest crew-install date as a 5th inline query, exactly like the existing four vectors.
**No new table, no new db lifecycle function, no new config.**

### What counts (decided with Brett)

For each `material_order` whose `status ∈ {draft, ordered}` (delivered/canceled can't be "at risk"),
compute `materialDeliveryFlag({ neededByAt: order.neededByAt, installAt })` where `installAt` =
the job's **current** earliest `appointment` of `type='crew'`, `status='scheduled'` (min `startsAt`):

| flag | meaning | exception? | severity |
|---|---|---|---|
| `misaligned` | snapshotted `neededByAt` is now **after** the install date — materials arrive after the crew | **yes** | **high** (crew-blocking) |
| `no_install` | order has materials but no scheduled crew install (or no `neededByAt`) — a planning gap on an already-accepted estimate | **yes** | **medium** |
| `none` | delivery target is on/before install | no | — |

Severity rationale: `misaligned` blocks production imminently → `high`, alongside overdue invoices.
`no_install` is a real gap (a `material_order` only exists once an estimate is **accepted**, so the
job is far enough along that an unscheduled crew install is notable) but not imminent → `medium`.
[ASSUMED — Brett answered "high" for *misalignment* specifically; `no_install`=medium is the
controller's call to keep planning-gap items from outranking crew-blocking ones. One-line change to
bump.]

### Exception item shape (mirrors the existing four)

- **kind:** new `"material_delivery"` (one kind covering both sub-cases; the cockpit cares about a
  single "Materials" bucket). Added to `ExceptionKind`, `KINDS`, and the page's `KIND_LABEL`
  (`material_delivery → "Materials"`).
- **title:** `customerName ?? "—"`.
- **detail:** `misaligned → "Materials arrive after install"`; `no_install → "No install scheduled for materials"`.
- **href:** `/jobs/${jobId}`.
- **occurredAt** (sort key within severity tier): `misaligned → installAt` (soonest install first);
  `no_install → order.createdAt` (oldest unscheduled order first).

### Core change (`packages/core/src/exception-queue.ts`)

- `ExceptionKind` gains `"material_delivery"`; `KINDS` array gains it (so `counts` includes it).
- New input type `MaterialDeliveryInput = { materialOrderId: string; jobId: string; customerName: string | null; neededByAt: Date | null; installAt: Date | null; createdAt: Date }`.
- `ExceptionQueueInput` gains a **required** `materialDeliveries: MaterialDeliveryInput[]` (required,
  consistent with the other four; typecheck then forces every caller to supply it — self-enforcing).
- A new loop computes `materialDeliveryFlag(...)` (imported from `./material-order`), skips `none`,
  and pushes a high (`misaligned`) / medium (`no_install`) item. Pure; sorting/counts unchanged.

### Web change (`apps/web/src/lib/exception-queries.ts` + `exceptions/page.tsx`)

- A 5th inline query: select `material_order` rows where `status in ('draft','ordered')`, left-join
  `job`→`customer` for the name, with a correlated subquery for the current install date:
  `(select min(starts_at) from appointment where job_id = mo.job_id and type='crew' and status='scheduled')`.
  Map to `MaterialDeliveryInput[]` and pass as `materialDeliveries` to `buildExceptionQueue`.
- `page.tsx`: add `material_delivery: "Materials"` to `KIND_LABEL`.

## Testing

- **Core unit** (`exception-queue.test.ts`): new cases — `misaligned`→high item, `no_install`→medium
  item, `none`→omitted; plus the new field added to existing test inputs.
- **e2e** (`apps/web/tests/e2e/material-exceptions.spec.ts`, new — mirror `materials.spec.ts`
  seeding + `doc-gating.spec.ts` adminDb style): seed (a) a misaligned order (crew appt at T;
  `material_order` with `neededByAt = T + 1d`, status `ordered`) and (b) a no-install order
  (`material_order`, no crew appt), then GET `/exceptions` and assert a `Materials` exception row
  appears for each seeded (stamped) customer with the right detail + severity. Assertions are scoped
  to the stamped customer names (the page aggregates ALL tenant rows — never assert on `total`).
- **Docs**: extend the Exception Queue section of `docs/jobs-pipeline.md` with the material vector.

## Assumptions / decisions

- **[VERIFIED]** Reuse `materialDeliveryFlag` (D2a) verbatim — no new detection logic.
- **[VERIFIED]** `installAt` = min `startsAt` of `type='crew'`,`status='scheduled'` appointments
  (same definition D2a's `earliestCrewInstallAt`/`getJobInstallDate` use).
- **[Brett]** Scope = misaligned **and** no_install; statuses = draft+ordered; misalignment severity = high.
- **[ASSUMED, controller]** `no_install` severity = medium (see rationale above).
- **[DECISION]** One `material_delivery` kind (not two), severity differentiates the sub-cases.

## What's missing / out of scope

- **No tenant config knob** (no misalignment threshold) — the flag's rule (`neededByAt > installAt`)
  is the definition; adding a threshold is YAGNI for this slice.
- **No write/auto-fix** — D2b only *surfaces* the risk; rescheduling delivery or install is manual
  (or a future slice). No Inngest workflow.
- **No de-dup with `job_at_risk`** — like the existing invoice/job dual-path (documented in
  `exception-queries.ts`), a job can legitimately appear both as `job_at_risk` and `material_delivery`.
- **No LIMIT/pagination** — same all-rows pattern + `TODO(scale)` as the existing four vectors.
