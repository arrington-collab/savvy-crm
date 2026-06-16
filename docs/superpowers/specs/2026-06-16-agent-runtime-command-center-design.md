# Design — Agent Runtime, Command Center & Finance Slice 1

**Date:** 2026-06-16
**Status:** Approved (autonomous session — Brett's kickoff directive pre-approved the direction)
**Branch family:** `feat/agent-runtime-finance`, `feat/command-center`

## 1. Why (the correction)

Everything shipped through Phase 6C is the **transactional money spine** (estimates, e-sign, change orders, billing, reporting) — CRUD + integrations, explicitly *not* the moat. SAVVY's moat is **"orchestration + UI + data."** The five AI agents that are supposed to *be* the product are still just seams: an `agents` package of Inngest functions, `agent_run` rows nothing surfaces, a `claims` enum stub, and a LiteLLM capability gateway that only three workflows route through.

This initiative makes the agent layer **real** (capability-tier routing, every agent action logged) and **visible** (a Command Center screen), and proves the agent-does-real-work loop with one certain money slice.

The bones already fit: **LiteLLM = cost-aware model router, Inngest = agent runtime, `agent_run` = activity log.** We are not adding infrastructure — we are formalizing what exists.

## 2. Scope & non-goals

**In scope**
1. **Capability tiers** in `@savvy/ai`: agents request `reflex` (cheap), `workhorse` (mid), `reasoning` (flagship) — never a model string. Recast the three existing call sites onto tiers.
2. **`agent_run` conventions**: a single `recordAgentRun` helper so every agent action logs consistently (agent, taskKey, status, model, cost, timing). No schema change — the table is already rich.
3. **Command Center screen** (`/command-center`): live agent-activity feed + automation-coverage summary, rendered from real `agent_run` data. Read-only.
4. **Finance Agent Slice 1**: on change-order approval, auto-**send** the supplemental invoice (number + `draft→sent`, Stripe checkout link, dunning enrollment), guarded + idempotent like the existing `applied` flag.

**Non-goals (this initiative)**
- No new money-path or CRUD features; no Phase 6D (CompanyCam / crew check-in).
- **Claims/insurance stays deferred** — keep the `claims` enum + `job.type='insurance'` seams intact; do not duplicate SupplementIQ.
- No restyle of the existing app; reuse current shadcn / Tailwind v4 primitives.
- Command Center is **read-only** — no agent control/pause/replay UI yet.
- Slice 2 (AI scope-drafting) is specced lightly in §9 but only built if time remains.

## 3. Architecture

```
Event (e.g. change_order/accepted)
  └─> Inngest function (the "agent action")            packages/agents
        ├─ domain work via lifecycle fns               packages/db/src/lifecycle
        ├─ optional model call by capability tier       @savvy/ai (LiteLLM gateway)
        └─ recordAgentRun(...)  ──────────────────────> agent_run table
                                                              │
Command Center  </command-center>  <──── reads ───────────────┘
   agent-activity feed + coverage      apps/web/src/lib/command-center-queries.ts
```

Each Inngest function **is** an agent action. The five agents are a *classification* of those functions by domain (the `agent` enum already on every `agent_run` row), not five separate processes.

## 4. Capability tiers (`@savvy/ai`)

`packages/ai/src/capabilities.ts` becomes tier-based. Logical model names stay (LiteLLM maps them to providers); only the *capability keys* change to tiers:

```ts
export const CAPABILITY_MODEL = {
  reflex:    "gemini-flash",   // cheap/volume: classify, score, route
  workhorse: "gemini-flash",   // mid: summarize, personalize copy
  reasoning: "claude-sonnet",  // flagship: scope drafting, judgment
} as const;
export type Capability = keyof typeof CAPABILITY_MODEL;
```

Call-site recast (the only behavioral change — same models, new names):
| Call site | old capability | new tier |
|---|---|---|
| `lead-intake.qualifyLead` | `cheap-classify` | `reflex` |
| `drip` copy personalization | `summarize` | `workhorse` |
| `estimate-generate` upsells | `reason` | `reasoning` |

`client.ts` is unchanged except it already returns `{ ..., model }`; we additionally surface `usage` (tokens) when the SDK provides it so `recordAgentRun` can store `tokens`/`costCents`. (Cost = tokens × a per-model rate table in `@savvy/ai`; best-effort, 0 when unknown — same spirit as other best-effort integrations.)

## 5. `agent_run` conventions — `recordAgentRun`

New helper in `@savvy/db` (`lifecycle/agent-run.ts`):

```ts
recordAgentRun(tx, {
  tenantId, agent: "finance", taskKey: "change-order.auto-send-invoice",
  jobId?, status: "ok" | "error" | "skipped", modelUsed?, tokens?, costCents?, error?,
})
```

- Writes inside the caller's `withTenant` tx (consistent isolation).
- `status` stays free text (existing pattern) — we add the convention value `"skipped"` for legitimate no-ops (e.g. Stripe not connected), distinct from `"error"`.
- `taskKey` is the human-meaningful action id the Command Center labels rows by.
- Existing ad-hoc `tx.insert(agentRun)` sites (lead-intake, change-order) are migrated to this helper so the feed is uniform.

## 6. Command Center screen

Route `apps/web/src/app/(app)/command-center/page.tsx` (`force-dynamic`), linked in the sidebar after "Dashboard".

**Data (`command-center-queries.ts`, all `withTenant`):**
- `recentAgentActivity(limit=30)` — `agent_run` joined to `job`/`customer` for a readable line, newest first: agent badge, action (`taskKey`), target ("Job — Jane Homeowner"), model, status, relative time.
- `agentCoverage()` — per-agent rollup over a trailing window: runs count, ok/error/skipped split, last-run time. Drives the "which agents are active" cards. The five agents are always shown (including `claims` → rendered as "Deferred").
- `automationStats()` — headline counts: actions in last 24h, AI vs deterministic split, total model spend (sum `costCents`), error rate.

**UI (existing primitives only):**
- Top row: stat cards (24h actions, AI spend, error rate, active agents).
- Left/main: **Agent Activity** feed — one row per `agent_run` with a colored agent badge, action, target, status pill, model, timestamp.
- Right/aside: **Agent Coverage** — five agent cards (Orchestrator/Comms/Scheduling/Finance/Claims-deferred) with run counts + last-active + status dot.
- Empty state: a clear "No agent activity yet — agents run on events" message (so a fresh tenant doesn't look broken).

No polling/websockets v1 — `force-dynamic` + a manual refresh; revalidated on navigation.

## 7. Finance Agent — Slice 1 (the must-land loop)

**Goal:** the 6C flow creates a *draft* supplemental invoice on change-order approval; the Finance agent now **sends** it.

**Where:** extend `changeOrderAccepted` (`packages/agents/src/functions/change-order.ts`) with a second durable step after the existing apply step.

**Flow:**
1. `apply` step (existing) → `approveChangeOrder` bumps `job.valueFinal` + inserts the **draft** invoice. Extend its return to include `invoiceId` (currently only `{invoiceCreated}`).
2. `auto-send` step (new) → `autoSendSupplementalInvoice({ tenantId, invoiceId })` (new lifecycle fn):
   - Load invoice + tenant. **Idempotency guard:** if `invoice.status !== "draft"` → no-op (a redelivery already sent it). Returns `{ sent: false, reason: "already-sent" }`.
   - **Stripe guard:** if `tenant.stripeAccountId` is null → `recordAgentRun(status:"skipped", taskKey:"change-order.auto-send-invoice")` and return `{ sent:false, reason:"stripe-not-connected" }`. **Do not throw** (no infinite Inngest retry); mirrors the manual `sendInvoiceAction` which also can't send without Stripe.
   - Else: `sendInvoice` (assigns number, `draft→sent`, sets `dueAt`). Create the Stripe **checkout session** (outbound I/O, its own step, OUTSIDE the tx) and store `stripeCheckoutSessionId` on the invoice — reuse the exact logic in `createCheckoutForInvoice`, extracted into a `createInvoiceCheckout` lifecycle helper so action + agent share one implementation.
   - `recordAgentRun(agent:"finance", taskKey:"change-order.auto-send-invoice", status:"ok", jobId)`.
3. `dunning` enrollment → emit `invoice/sent` (the event `dunningRun` already consumes). Wrapped so a send failure of the *event* doesn't undo the send (best-effort, logged), matching `sendInvoiceAction`.

**Idempotency summary** (reuses the established pattern):
- Money mutation: guarded by `change_order.applied` (unchanged).
- Send: guarded by `invoice.status = 'draft'` (atomic `UPDATE ... WHERE status='draft'`), so a redelivered `change_order/accepted` cannot double-send, double-number, or double-enroll dunning.

**No schema change.** `invoice.status`, `stripeCheckoutSessionId`, `change_order.invoiceId` all already exist.

## 8. Testing

- **`@savvy/ai`**: tier map type test (capability keys are exactly the three tiers); cost-estimate helper unit test.
- **`recordAgentRun`**: db integration test — row shape, `skipped` status, RLS-scoped.
- **Finance slice 1** (db + agents):
  - connected tenant → draft invoice becomes `sent` with a number, checkout session id stored, `invoice/sent` emitted, one `finance/ok` agent_run.
  - redelivery (call twice) → second call is a no-op, no second number/run (idempotency).
  - no-Stripe tenant → invoice stays draft, one `finance/skipped` agent_run, no throw.
- **Command Center**: queries integration test (activity rows shape, coverage rollup, RLS isolation — cross-tenant returns nothing); a Playwright e2e that loads `/command-center` and asserts the feed renders a seeded `agent_run` and the five agent cards. (e2e runs on CI; don't block locally.)
- Existing isolation suite already covers `agent_run` (table unchanged) — no new `tenantIsolation()` needed.

## 9. Slice 2 (only if time) — AI scope-drafting

Rep types a natural-language change ("add 2 squares of ridge + replace 3 pipe boots") → Finance agent calls the **`reasoning`** capability with the tenant price book in context → returns structured `lineItems` → **human reviews** in the existing ChangeOrderEditor before send. Pure suggestion, never auto-applied. Logged as `finance` / `reasoning` agent_run with token cost. Full spec deferred to its own design doc if reached.

## 10. PR / sequencing plan (autonomous)

The must-land deliverable is **Slice 1** (small, certain, no LLM). De-risk by shipping it first.

| PR | Contents | Risk | Status target |
|---|---|---|---|
| **PR 1** | Finance Slice 1 (auto-send) + `autoSendSupplementalInvoice`/`createInvoiceCheckout` helpers + `recordAgentRun` helper (used by slice 1) | low (no LLM, no migration) | **merged, CI green — must land** |
| **PR 2** | Capability tiers recast + Command Center screen + migrate remaining `agent_run` sites to `recordAgentRun` | low-med (touches 3 AI call sites + new screen) | merged if time |
| **PR 3** | Slice 2 AI scope-drafting | med | only if time; else spec+plan on disk |

Rationale: `recordAgentRun` lands in PR1 because slice 1 needs it; the tier recast and Command Center don't block slice 1 (slice 1 makes no model call), so they move to PR2 to keep the must-land PR tiny. The Command Center reads `agent_run` regardless of order, and slice 1 immediately gives it a real `finance` row to show.

## 11. Repo rules honored
`gh pr create --base main`; `git fetch origin main` + merge-base check before every push; on migration collision regenerate at next number (N/A — no migration here); gate `pnpm typecheck && pnpm lint && pnpm test`; single-instance imports (`@savvy/db`/`@savvy/core`); no `.js` on source relative imports; outbound I/O (Stripe/LiteLLM) outside `withTenant`; re-hydrate Inngest `Date` with `new Date(x)`; `noUncheckedIndexedAccess` on.
