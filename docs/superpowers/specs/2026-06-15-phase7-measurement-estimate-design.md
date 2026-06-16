# Phase 7 — Measurement & Retail Estimate (Design)

**Date:** 2026-06-15
**Roadmap goal:** Roofr ordering (cost pass-through +$3) → auto-generate a retail estimate from measured areas + a price book → rep edits → customer e-signs. **Done when:** a Roofr report auto-produces a retail estimate that's ~98% complete, the rep edits it, and the customer e-signs (which advances the job to *approved*).

**Scope decision:** Full chain in **one waved PR** (like Phase 5B). Roofr and DocuSeal are **fake-first gateways** (the QBO real+fake pattern) so the phase ships and is fully tested without live credentials.

**Branch:** `worktree-phase7-measurement-estimate`, off fresh `origin/main` (5B merged). Built in an isolated worktree because a concurrent session holds the main checkout on Phase 6.

---

## 1. Architecture overview

Five subsystems, built in waves:

1. **Price book** (data + lazy per-tenant seeding of built-in defaults, overridable).
2. **Estimate-generation engine** (pure `@savvy/core`): deterministic rules → core line items, with field-shingle waste and tiered steep-pitch labor surcharge.
3. **Roofr ordering** (integration gateway + Inngest workflow).
4. **AI upsell** (gateway capability — suggestions only, never touches dollar math).
5. **E-sign** (DocuSeal gateway + send workflow + webhook → job stage advance).

**Non-negotiables honored:** tenant RLS on every new table/query; all AI via the capability gateway (never a hard-coded model); every multi-step/async path is a durable, idempotent Inngest workflow; money in integer cents, rates in basis points; tests + typecheck + lint gate every commit; no secrets in repo (`.env.example` documents `ROOFR_API_KEY`, `DOCUSEAL_API_KEY`, `DOCUSEAL_BASE_URL` — already stubbed).

---

## 2. Data model

### New table: `price_book_item`
One row per item **per tenant**. Built-in defaults are seeded lazily; editing a row *is* the per-tenant override.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `tenantId` | uuid → tenant | `tenantIsolation()` |
| `key` | text | stable item key (e.g. `field-shingles`) |
| `name` | text | display name |
| `category` | enum `price_book_category` | `material \| labor \| accessory \| upgrade` |
| `unit` | enum `price_book_unit` | `square \| lf \| each \| flat` |
| `unitPriceCents` | integer | tenant-edited |
| `sourceField` | text nullable | measurement field driving qty (null = manual). **Overridable** |
| `wasteApplies` | boolean | **Overridable**. Default `true` only for field shingles |
| `active` | boolean default true | |
| `sortOrder` | integer | |
| `createdAt` | timestamptz | |

Indexes: `(tenantId)`; unique `(tenantId, key)`. RLS isolation policy.

### Extend `estimate` (exists)
Add: `measurementId` (uuid → measurement, nullable), `wastePctUsed` (integer bps), `pitchTierApplied` (text nullable), `sentAt`, `acceptedAt` (timestamptz nullable), `docusealSubmissionId` (text nullable), `upsellSuggestions` (jsonb default `[]`). Proposed AI upsells live in `upsellSuggestions` — **separate from `lineItems` and excluded from totals**; `acceptUpsellAction` moves a chosen suggestion into `lineItems` (then totals recompute).

### `measurement` (exists, unchanged columns)
`areas` jsonb is validated by a new core `measurementAreasSchema`. `costCents` records Roofr cost **plus the $3 markup** (Phase 8 meters this).

### Tenant `settings.estimate` (new config block)
```
{
  taxRateBps: number,              // applied to taxable subtotal
  defaultWastePct: number,         // bps, applied where wasteApplies
  steepPitchTiers: [               // contractor-defined, ordered
    { minRise: number, maxRise: number|null,
      laborSurchargePct: number,   // bps on labor-category items
      wasteBumpPct: number }       // bps added to field-shingle waste (0 = labor-only)
  ]
}
```
Seed defaults (tenant-editable): waste 12%, tax per tenant, tiers `0–6 → 0%/0`, `7–9 → +20%/0`, `10–12 → +35%/0`, `13+ → +50%/0`. **Contractors set their own** breakpoints, surcharges, and optional waste bumps.

### New enums (`@savvy/core` + `@savvy/db` pgEnum)
`ESTIMATE_SOURCE = [roofr, manual, carrier]`, `ESTIMATE_STATUS = [draft, sent, accepted]`, `PRICE_BOOK_CATEGORY`, `PRICE_BOOK_UNIT`, `MEASUREMENT_FIELD`.

---

## 3. Generation engine (`@savvy/core`, pure)

### `measurementAreasSchema` + helpers (`measurement.ts`)
Standard Roofr fields: `totalSquares, predominantPitch, ridgeLf, hipLf, valleyLf, eaveLf, rakeLf, stepFlashingLf, penetrationCount, facetCount`.
- `parsePitch("X/12") → rise:number`
- `pitchTier(rise, tiers) → { tier, laborSurchargePct, wasteBumpPct }`

### Built-in default rules (engine applies math by `unit` + `sourceField` + `wasteApplies`)

| Line item | Source field | Qty formula | Waste? | Unit |
|---|---|---|---|---|
| Field shingles | `squares` | squares × (1 + waste%) | ✅ | square |
| Starter strip | `eaveLf` | eave LF | ❌ | lf |
| Hip & ridge cap | `ridgeLf + hipLf` | ridge+hip LF | ❌ | lf |
| Drip edge | `eaveLf + rakeLf` | eave+rake LF (round to 10ft) | ❌ | lf |
| Underlayment | `squares` | squares | ❌ | square |
| Ice & water shield | `eaveLf + valleyLf` | eave+valley LF | ❌ | lf |
| Valley metal | `valleyLf` | valley LF | ❌ | lf |
| Step flashing | `stepFlashingLf` | LF | ❌ | lf |
| Pipe boots | `penetrationCount` | each | ❌ | each |
| Tear-off (labor) | `squares` | squares | ❌ | square |
| Install (labor) | `squares` | squares | ❌ | square |

**Invariants (heavily unit-tested):**
- Waste applies **only** where `wasteApplies = true` → field shingles. Never starter, ridge cap, or drip edge.
- Steep-pitch `laborSurchargePct` applies **only** to `category = labor` items.
- Optional `wasteBumpPct` for the matched tier is added to the field-shingle waste % (contractor opt-in; default 0).
- Money math is integer cents; quantities round per item rule (e.g. drip edge to 10ft sticks); half-up rounding to whole cents.

### `generateEstimateLineItems({ areas, pitch, priceBook, wastePct, pitchTiers })`
Pure. Returns core line items `{ key, name, category, unit, quantity, unitPriceCents, amountCents, wasteAppliedPct?, pitchSurchargePct? }` + the resolved `pitchTierApplied`.

### `computeEstimateTotals(lineItems, taxRateBps)`
Returns `{ subtotalCents, taxCents, totalCents }`.

---

## 4. Integrations (`@savvy/integrations`) — fake-first

| Gateway | Methods | Fake |
|---|---|---|
| `RoofrGateway` | `orderMeasurement({ address }) → { orderId }`; `getReport(orderId) → { ready, areas, pitch, reportUrl, costCents }` | deterministic sample areas + pitch, immediate-ready |
| `DocusealGateway` | `createSubmission({ estimate, signer }) → { submissionId, signUrl }`; `verifyWebhook(payload, sig) → boolean`; `parseEvent(payload) → { submissionId, status }` | deterministic submissionId / signUrl |

Real impls follow the QBO precedent (HTTP/Nango transport), validated against sandbox later; the **fakes** drive all tests so field-shape drift in the real impl doesn't block the phase. `index.ts` re-exports interfaces + `nango*`/`make*Fake`.

---

## 5. Events + workflows (`@savvy/agents`)

| Event | Workflow | Behavior |
|---|---|---|
| `roofr/order.requested {tenantId, jobId, propertyId}` | `roofrOrderMeasurement` | order → poll `getReport` (step.sleep + retry until `ready`) → persist `measurement` (areas, pitch, `costCents` = Roofr + $3) → emit `measurement/ready` |
| `measurement/ready {tenantId, jobId, measurementId}` | `generateEstimateOnMeasurement` | load price book + `settings.estimate` → pure engine → draft `estimate` (status `draft`, source `roofr`, `measurementId`); then AI-upsell suggestions via **gateway capability** stored as proposed (not in totals until accepted) |
| `estimate/send.requested {tenantId, estimateId}` | `sendEstimateForSignature` | DocuSeal `createSubmission` → set `status = sent`, `sentAt`, `docusealSubmissionId` |
| `estimate/accepted {tenantId, estimateId}` | `estimateAcceptedAdvanceJob` | set `status = accepted`, `acceptedAt`; advance job stage → **approved** via Phase 2 `moveJobToStage`; write `job.valueEstimate = total` |

All workflows: `concurrency` limits, `retries`, idempotency (no-op if estimate already in target state / measurement already generated). AI upsell uses `@savvy/ai` capability routing (e.g. `reason`/`suggest`) — never a hard-coded model.

---

## 6. Web (`apps/web`)

- `POST /api/docuseal/webhook` — verify signature → on `completed`, emit `estimate/accepted`. Static route before dynamic; tenant resolved + written via `adminDb` (Stripe-webhook precedent).
- `estimate-actions.ts` server actions: `orderMeasurementAction` (emit `roofr/order.requested`), `generateEstimateAction` (manual regen), `updateEstimateLineItemsAction`, `acceptUpsellAction`, `sendEstimateAction` (emit `estimate/send.requested`).
- `price-book-queries.ts` / `estimate-queries.ts` (server-only, `withTenant` + `getTenantId`).
- **Pages:**
  - `/settings/price-book` — editable price-book table (price, waste flag, source-field override, active) + estimate settings (tax rate, default waste %, pitch tiers). Lazy-seeds defaults via `ensurePriceBook(tenantId)` on first open.
  - Job detail `/jobs/[id]` — **Estimates** section: "Order measurement" → measurement summary → "Generate estimate" → estimate list with status badges.
  - `/jobs/[id]/estimates/[estimateId]` — estimate editor: editable line-item table (qty / unit price / amount), add/remove rows, accept/drop AI upsell suggestions, live totals, "Send for signature", status badge + sign link.

---

## 7. Testing

- **Unit (`@savvy/core`):** engine rules; waste-only-on-field-shingles invariant; pitch parse + tier selection; labor-only surcharge; optional waste bump; drip-edge rounding; totals (subtotal/tax/total); measurement schema validation.
- **DB integration (`@savvy/db`):** `ensurePriceBook` seed + idempotency; per-tenant override persists; estimate generation persistence; **RLS cross-tenant isolation** test extended to `price_book_item`.
- **Agents:** each workflow with injected fakes — order→ready, generation (rules + stubbed upsell), send (fake DocuSeal), accepted→stage advance + idempotency.
- **E2E (Playwright, reuse 5B harness):** order measurement (fake) → generate → edit a line item → send → simulate DocuSeal webhook (`completed`) → estimate `accepted` → job stage `approved`. Mirror `finance.spec.ts` / `comms.spec.ts` (`inngest.send` + DB poll).

---

## 8. Definition of done

- [ ] `price_book_item` + estimate/measurement extensions migrated; RLS verified by test.
- [ ] Pure engine produces a ~98%-complete estimate from a Roofr report; invariants tested.
- [ ] Roofr order + estimate generation + DocuSeal send + accept→approved all durable, idempotent Inngest workflows.
- [ ] AI upsell via gateway capability (no hard-coded model); suggestions excluded from totals until accepted.
- [ ] Price-book + estimate-settings UI; estimate editor; e-sign flow wired.
- [ ] `.env.example` already covers Roofr/DocuSeal; document any new vars.
- [ ] Unit + integration + agents + e2e tests pass; typecheck + lint clean. One reviewed PR.

## 9. Known follow-ups (out of scope, logged)
- Real Roofr/DocuSeal API field shapes validated against sandboxes.
- Roofr async ordering can take minutes/hours in production — the poll workflow models this; real timeout/backoff tuning later.
- Usage metering of the +$3 markup is **Phase 8**.
- Taxable-vs-nontaxable per line item (labor often non-taxable) — v1 applies one tenant tax rate to the subtotal; per-line taxability is a fast-follow.
- Auto-creating an invoice from an accepted estimate (line items transfer cleanly to Phase 5) — deferred.
