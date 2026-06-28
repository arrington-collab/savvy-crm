# Jobs Pipeline — Stage Model, Events, Health & Tuning

> How a Savvy job moves through its lifecycle, which system events drive automatic
> stage advances, how at-risk and late signals are computed, and how operators can
> tune the thresholds per tenant.

---

## 1. The 9-stage model

Every job progresses through a linear set of stages. Terminal stages (`complete`
and `lost`) have no further transitions; `lead` is the entry point when a won lead
converts to a job.

| # | Stage        | Meaning                                                       |
|---|--------------|---------------------------------------------------------------|
| 1 | `lead`       | Job created; inspection not yet done                          |
| 2 | `inspected`  | Inspection appointment completed                              |
| 3 | `estimate`   | Estimate drafted / sent to homeowner or carrier               |
| 4 | `approved`   | Estimate accepted (insurance carrier or homeowner)            |
| 5 | `production` | Crew scheduled / materials ordered; active build              |
| 6 | `closeout`   | Build complete; punch-list, final photos, certificate of work |
| 7 | `billing`    | Final invoice sent to homeowner or carrier                    |
| 8 | `complete`   | Invoice fully paid — job closed                               |
| 9 | `lost`       | Job cancelled or unrecoverable                                |

Stage transitions are recorded in `job_stage_event` with timestamps, actor, and
the previous stage. The current stage and its entry timestamp live on `job.stage`
and `job.stageEnteredAt`.

---

## 2. Event → stage map

Stages can be advanced by **user action** (drag on the board, status update in the
detail view) or by **system events** emitted through Inngest.

### Currently wired (pieces A + B)

| Inngest event        | Target stage | Notes                                                                                        |
|----------------------|--------------|----------------------------------------------------------------------------------------------|
| `estimate/accepted`  | `approved`   | Fired when the homeowner or carrier approves the estimate                                    |
| `invoice/sent`       | `billing`    | Fired when an invoice is dispatched; forward-only — skips if the job is already at `billing` or beyond |
| `invoice/paid`       | `complete`   | Fired when full payment is confirmed; forward-only + **photo gate** (see §2a below)          |

All three use `syncInvoiceStage` (for the invoice events) or an equivalent
`recordStageChange` call. They are **forward-only**: a stage transition is skipped
if the job's current stage index is already equal to or ahead of the target.
Re-firing the same event is idempotent.

### Future (pieces C + D — not yet wired)

| Planned event               | Target stage | Piece |
|-----------------------------|--------------|-------|
| `material/delivered`        | `production` | C     |
| `crew/gps-arrived`          | `production` | C     |
| `completion-photo/uploaded` | `closeout`   | D     |

These signals are identified but not yet consumed. Stages they would drive can
still be advanced manually.

### 2a. Photo gate on `complete`

`recordStageChange` checks `tenant.settings.production.requiredPhotos[jobType]`
before allowing a move to `complete`. If any required label (e.g. `before`,
`after`, `permit`) is absent from the job's `document` rows, it throws
`IncompletePhotosError` and the job stays in `billing`. The Inngest function
handles this gracefully and returns `{ skipped: "photo_gate" }` — no retry, no
crash. The job must receive the missing photos before the stage can be advanced
(manually or via the next `invoice/paid` re-emit).

---

## 3. Health derivation

Health is **computed on read** in `@savvy/core` — there is no stored health column
and no backfill query. Every call to the board's `getBoard` or the detail view
calls `deriveJobHealth(signals, config, now)` inline.

### 3a. Inputs (`JobHealthSignals`)

| Field               | Description                                      |
|---------------------|--------------------------------------------------|
| `stage`             | Current job stage                                |
| `stageEnteredAt`    | Timestamp the job entered the current stage      |
| `type`              | Job type (`retail` / `insurance` / `repair` / `commercial`) |
| `approvedAt`        | When the job reached `approved` (null if not yet)|
| `hasPastDueInvoice` | True if any invoice's `dueAt` is in the past     |

### 3b. `stuck` signal

A job is **stuck** when `daysInStage > stageThresholds[stage]`.

Only the six active stages have thresholds (see §5). The entry stage (`lead`) and
terminal stages (`complete`, `lost`) intentionally have no threshold — a job in
`lead` is just queued; closed jobs are done.

### 3c. `late` signal

A job is **late** under either condition:

1. **Past expected completion** — `approvedAt` is set and
   `now > approvedAt + buildSlaDays[type]` (expressed in days from the
   `buildSlaDays` config).
2. **Past-due invoice** — `hasPastDueInvoice === true`.

Both conditions accumulate into a `reasons[]` array on the returned `JobHealth`
object. A job can be both stuck *and* late at the same time.

### 3d. Board surface

The jobs board shows:

- **At-risk** badge on any card where `stuck || late`
- **Late** badge (distinct colour) on cards where `late`
- **"Needs attention (N)"** count and filter in the column header — counts all
  jobs in that stage where `stuck || late`

---

## 4. `leadToJobType` heuristic

When a won lead converts to a job (`convertLeadToJob`), there is no explicit
insurance/retail flag on the lead. The heuristic maps the lead's **lane** to a
job type:

```ts
leadToJobType(lane: string | null): JobType
// lane === "storm"  →  "insurance"
// anything else     →  "retail"
```

**Limitation:** This is best-effort. A storm-lane lead is *usually* an insurance
claim, but not always (e.g. homeowner waives insurance and pays out-of-pocket). A
non-storm lead could still be an insurance job. The type is editable in the job
detail view — operators should correct it if the heuristic misclassifies. A proper
insurance/retail flag on the lead is deferred to piece G.

The job type affects the `buildSlaDays` SLA window (§3c) and the photo-gate
requirements (§2a).

---

## 5. How to tune — `tenant.settings.jobs`

Store a JSON object at `tenant.settings.jobs` to override any default. Omitted
keys fall back to the compiled defaults — partial overrides are safe.

```json
{
  "stageThresholds": {
    "inspected":  3,
    "estimate":   7,
    "approved":   5,
    "production": 14,
    "closeout":   5,
    "billing":    10
  },
  "buildSlaDays": {
    "retail":     21,
    "insurance":  45,
    "repair":     10,
    "commercial": 60
  }
}
```

### `stageThresholds` (days before "stuck")

Days a job may sit in a given active stage before it is flagged as stuck. Raise a
threshold to reduce noise for a slow market; lower it to tighten follow-up cadence.

| Stage        | Default | When to change                                                         |
|--------------|---------|------------------------------------------------------------------------|
| `inspected`  | 3 d     | Lower to 1–2 for high-velocity canvass teams                          |
| `estimate`   | 7 d     | Raise to 10–14 if carrier supplement rounds are common                 |
| `approved`   | 5 d     | Raise slightly if material lead times are long in the market           |
| `production` | 14 d    | Raise for commercial tenants with longer build schedules               |
| `closeout`   | 5 d     | Rarely needs changing; punch-lists should resolve quickly              |
| `billing`    | 10 d    | Raise for insurance tenants where carrier payment takes time           |

### `buildSlaDays` (days from approval to expected completion)

Clocks start when the estimate is accepted (the `approvedAt` timestamp). The job
is flagged **late** if it has not reached `complete` by this deadline, regardless
of current stage.

| Type          | Default | Notes                                                      |
|---------------|---------|------------------------------------------------------------|
| `retail`      | 21 d    | Typical residential retail; lower to 14 for repair-focused teams |
| `insurance`   | 45 d    | Carrier supplement rounds inflate cycle times              |
| `repair`      | 10 d    | Emergency/small jobs — tighten as appropriate              |
| `commercial`  | 60 d    | Multi-section builds; adjust to actual project schedules   |

Changes take effect immediately for new health reads — no backfill is needed
because health is computed on read.

---

## 6. Notes and edge cases

- **Forward-only transitions:** Invoice events can only advance the stage. A
  `invoice/sent` event on a job already in `billing` (or `complete`) is silently
  skipped (`not_forward`). This prevents accidental regression.
- **Skipped stages:** Because advances are forward-only, a `invoice/paid` event
  can move a job from `production` directly to `complete`, skipping `closeout` and
  `billing`, if no invoice was sent first. The photo gate still fires on any move
  to `complete` regardless of how far the jump spans.
- **Health on terminal stages:** `complete` and `lost` jobs DO appear on the board
  (in their own columns — `getBoard` does not filter them out). However,
  `deriveJobHealth` returns `{ stuck: false, late: false, reasons: [] }` immediately
  for any terminal stage, so they carry NO health flags, show no "At-risk" or "Late"
  badge, and are excluded from every column's "Needs attention" count.
- **No stored health column:** Do not add a `health` column to the `job` table.
  Derived-on-read keeps the schema simple and ensures health responds to config
  changes immediately without a migration or a backfill job.

---

## 7. Weighted pipeline (Command Center)

The Command Center's Pipeline panel shows **probability-weighted pipeline value**
alongside gross pipeline, at-risk dollars, average cycle time, and a week-over-week
trend. All math is computed on read in `@savvy/core` — no new columns or tables.

### 7a. Win-probability config

Win probabilities live in `tenant.settings.pipeline.stageWinProbability`. Each open
stage maps to the percentage chance of reaching `complete`. Terminal stages
(`complete`, `lost`) are not configured — closed deals are real.

```json
{
  "pipeline": {
    "stageWinProbability": {
      "lead":       5,
      "inspected":  15,
      "estimate":   30,
      "approved":   70,
      "production": 90,
      "closeout":   95,
      "billing":    98
    }
  }
}
```

Parsed by `parsePipelineConfig` in `@savvy/core`. Omitted stages fall back to the
compiled defaults above — partial overrides are safe.

**Tuning guidance:**

| Stage        | Default | When to adjust                                                          |
|--------------|---------|-------------------------------------------------------------------------|
| `lead`       | 5 %     | Raise for high-intent inbound leads; lower for cold-canvass markets     |
| `inspected`  | 15 %    | Raise if inspection → estimate conversion is strong                     |
| `estimate`   | 30 %    | Raise if carriers routinely approve; lower for competitive retail bids  |
| `approved`   | 70 %    | Rarely needs changing — approval is a strong buy signal                 |
| `production` | 90 %    | Lower slightly if your market has frequent mid-production cancellations |
| `closeout`   | 95 %    | Almost never needs changing                                             |
| `billing`    | 98 %    | Almost never needs changing                                             |

### 7b. Expected value

For each open stage, `weightedPipeline` computes:

```
expected = grossValue × stageWinProbability / 100
```

The **shrinkage** shown in the Command Center panel is `gross − expected` — the
expected revenue that will not close. Totals are sums across all open stages.

### 7c. At-risk dollars

At-risk dollar total = sum of `valueEstimate` for all jobs where
`stuck === true || late === true` (derived by `deriveJobHealth` — see §3). This
surfaces how much gross pipeline is currently unhealthy, regardless of stage.

### 7d. Average cycle time

`computeVelocity(stageEvents)` walks each job's `job_stage_event` log and returns
`cycleTimeDays` — the **mean** days between a job's **first and last recorded stage
transition**, averaged across all jobs that have at least two transitions. It is an
arithmetic mean (not a median), and it counts any job with movement — including
in-flight or stalled jobs — not only those that reached `complete`. So it reflects
how long jobs have been moving through stages, not completed-deal throughput alone.

### 7e. Week-over-week trend

`pipelineGrossAsOf(date)` reconstructs the open pipeline gross as of any past date
without storing snapshots. For each job it finds the latest `job_stage_event` row
whose `enteredAt ≤ date`; if no event exists the job is treated as still in `lead`.
Jobs in terminal stages (`complete` / `lost`) as of that date are excluded.

The WoW percentage shown in the UI is:

```
wowPct = (currentGross − grossSevenDaysAgo) / grossSevenDaysAgo × 100
```

`wowPct` is `null` when there is no prior basis (e.g. the tenant has no stage
events older than seven days).

**Current-value caveat:** each job's `valueEstimate` used for the historical
reconstruction is its *current* value, not the value it held seven days ago. The
WoW figure is therefore **directional** — it reliably shows whether the pipeline
is growing or shrinking, but it is not penny-accurate for jobs whose estimate value
changed during the window.

## Materials (D2a — material ordering)

When an estimate is **accepted**, a `material_order` (bill of materials) is
generated from its `category:"material"` line items — automatically via the
`create-material-order-on-accepted` Inngest function, or manually with the
**Generate from estimate** button on the job cockpit's Materials card.

- **One order per estimate** (`estimate_id` is unique; re-generating returns the
  existing order).
- The order subtotal is a **list-price BOM** (price-book unit price, what the
  homeowner is charged) — it is deliberately **not** written to `job.costCents`,
  so the cockpit margin stays honest. True supplier cost is D2c.
- **`neededByAt`** = the crew install date − `DELIVERY_BUFFER_DAYS` (2). The
  install date is the earliest `appointment` with `type='crew'` and
  `status='scheduled'`. The cockpit shows a delivery flag: *no install
  scheduled* or *delivery after install*.
- Status lifecycle: `draft → ordered → delivered` (or `canceled`), advanced
  from the cockpit.

### Supplier cost → margin (D2c)

Each price-book item carries a **supplier cost** (`unit_cost_cents`) alongside
its list price (`unit_price_cents`), editable in **Settings → Price book**. When
a material order is generated, each material line is matched to the price book by
`key` and stamped with `unitCostCents` + `lineCostCents`; the order stores a
`cost_subtotal_cents`.

When a material order is marked **ordered** (or **delivered**), the job's
`cost_cents` is recomputed as the **sum** of `cost_subtotal_cents` across that
job's orders in `{ordered, delivered}` — so the cockpit **Money & margin** card
shows a real margin (`revenue − supplier cost`) and the commission basis
(`amount_paid − cost_cents`) becomes accurate. Canceling an order drops it from
the sum automatically (recompute, never increment). Material is currently the
only contributor to `job.cost_cents`.

## Automation module (cockpit — Jobs I)

The job cockpit's **Automation** card summarizes the job's *configured* autonomy
from its `job_task` rows:

- **Autonomy %** — weighted across tasks (`full = 1`, `partial = 0.5`,
  `manual = 0`), i.e. how much of the job is set to run without a human.
- **Needs you** — count of tasks not yet `done` whose level is not `full`
  (manual/partial work still awaiting a person).
- **Per-agent breakdown** — for each of the five agents that owns a task, a
  `full / partial / manual` count with its persona avatar.

This is a read-only insight surface. `automationLevel` is not yet honored at
runtime by the agents — making it editable and enforced is the orchestration
(C) work. Logic: `summarizeJobAutomation` in `@savvy/core`.

## Exception Queue (Jobs J)

`/exceptions` is the tenant-wide "needs you" worklist. It unifies four signals
that need a human, sorted by severity (high → medium) then oldest first:

- **Job at risk** — `deriveJobHealth` reports `stuck` (past the stage threshold)
  or `late` (past the build SLA or a past-due invoice). `late` is high.
- **Invoice overdue** — `status='overdue'`, or `sent` with a past `due_at` and a
  remaining balance. High.
- **Appointment missed** — `no_show` (high) or a `scheduled` appointment whose
  `starts_at` has passed (medium).
- **Task overdue** — a `job_task` past its `due_at` that isn't `done`/`skipped`.
  Medium.

Agent-run errors are intentionally NOT here — those are automation health and
live on the Command Center. Logic: `buildExceptionQueue` in `@savvy/core`;
the page reuses `deriveJobHealth` exactly as the Jobs board does.

**Notes (intentional):** A past-due invoice may appear twice — once as a *job at
risk* (its job is `late`) and once as an *invoice overdue* row — giving the PM
and the finance person each a resolution path. The `invoice_overdue` vector
trusts the `overdue` status as authoritative, so it is deliberately broader than
the Jobs board's `pastDue` check (which also requires `due_at < now` + a
balance). The page has no pagination yet — fine at current tenant sizes; cap it
before a large customer onboards (same all-rows pattern as the Jobs board).
