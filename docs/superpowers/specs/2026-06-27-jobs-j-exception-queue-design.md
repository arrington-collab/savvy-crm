# Jobs J — Exception Queue ("needs you" worklist) (design)

**Date:** 2026-06-27
**Slice:** Jobs build-order item **J** (exception queue; capacity = **K**, deferred).
Branches off clean `main`.

## Goal

Give the operator a single **Exceptions** worklist that aggregates everything
that needs a human across the whole tenant — at-risk jobs, overdue invoices,
missed appointments, overdue tasks — sorted by urgency, each linking to where
it's resolved.

## Why now

The product thesis is "agents run ops; humans handle exceptions." Slice I made
the per-job autonomy legible; **J is the tenant-wide exception surface** — the
human's worklist. Today the signals exist but are scattered across four pages
(Jobs board health filter, Invoices, Schedule, and nothing for tasks), so an
operator has no one place to see "what needs me right now."

## What counts as an exception (4 vectors)

| Kind | Source signal | Severity |
|---|---|---|
| `job_at_risk` | `deriveJobHealth` → `stuck` or `late` | `late` → high, else medium |
| `invoice_overdue` | invoice `status='overdue'` OR (`status='sent'` AND `due_at < now` AND unpaid) | high |
| `appointment_missed` | appointment `status='no_show'` OR (`status='scheduled'` AND `starts_at < now`) | `no_show` → high, else medium |
| `task_overdue` | `job_task.due_at < now` AND `status NOT IN (done, skipped)` | medium |

**Explicitly out:** agent-run errors. Those are **automation health** and
already live on the Command Center (per-agent coverage + activity feed). Keeping
them there preserves a clean boundary: **Exceptions = business/ops items needing
a person; Command Center = agent/automation health.**

## Design decisions (locked; labels per Brett's response-quality rule)

- **[INFERRED] Reuse, don't re-derive job health.** The exceptions query mirrors
  `getBoard` (`pipeline-queries.ts`): the same `pastDue` subquery +
  `parseJobsConfig` + `deriveJobHealth`, then keeps only `stuck || late` jobs.
- **[ASSUMED] Unified item shape.** Every vector normalizes to one
  `ExceptionItem { kind, severity, title, detail, href, occurredAt }`. The pure
  normalization + sort lives in `@savvy/core` (`buildExceptionQueue`), so it's
  unit-tested; the web layer only gathers rows and renders.
- **[ASSUMED] Sort = severity then age.** `high` before `medium`, then
  `occurredAt` ascending (oldest/most-overdue first); null `occurredAt` sorts
  last within its group.
- **[ASSUMED] Links:** job/task → `/jobs/{jobId}`, invoice → `/invoices`,
  appointment → `/schedule`. (Deep-linking to a specific row is a follow-up.)
- **[INFERRED] New top-level page** `/exceptions` + a Sidebar nav entry
  ("Exceptions"), placed right after Command Center.
- **[INFERRED] No schema change.** All four vectors read existing tables via
  `withTenant`.

## Surfaces

- **Core (`@savvy/core`):** `ExceptionItem`/`ExceptionKind` types +
  `buildExceptionQueue(input, now)` → `{ items, counts, total, highCount }`.
  Unit-tested.
- **Web (`apps/web`):** `exception-queries.ts` (gathers the 4 vectors, reuses
  `deriveJobHealth`), an `/exceptions` page rendering the worklist (severity
  badge, kind, title, detail, link), and a Sidebar nav entry. Playwright e2e.

## Out of scope (later)

- **Capacity (K):** crew/rep load vs. scheduled work — a separate slice.
- Agent-run errors in the queue (stay on Command Center).
- Dismiss/snooze/assign actions on an exception (this slice is read + navigate).
- Deep links to a specific invoice/appointment row.

## Non-negotiables touched

- Tenant isolation: every vector query goes through `withTenant`; no new raw
  cross-tenant path.
- No hard-coded model strings (no AI here).
