# First-20-Cells — Close-out Handoff (2026-07-06)

Session shipped **5 cells** (PRs #144–#148, all merged to main, CI green). This doc hands off the genuinely-remaining work so a fresh session finishes cleanly. Read `first-20-cells.md` STATUS first.

## Shipped this session (merged)

| Cell | PR | What proves it | Prod-green gate |
|---|---|---|---|
| 17b SB38 contract pack | #144 | resolver + fail-closed gate on both CO paths + `compliance.contract_template` sweep (task 44) + state-aware rescission email | owner attaches real CO DocuSeal template; sweep green |
| 20 Alta provisioning | #145 | idempotent dry-run-first `provisionTenant` + CLI + seam inventory | **owner executes** for Alta (real creds) |
| 8 QB + Stripe reconcile | #146 | `finance.qb_reconcile` (task 150) + `finance.stripe_match` (task 141), fail-soft to stale | tenant connects QBO/Stripe; 14 clean days |
| 18 auto-chargeback | #147 | `recordStageChange`→lost flips unpaid commissions to `charged_back` (migration 0056) | n/a (invariant live) |
| 11 financing seam | #148 | `FinancingProvider` + dormant default + `job.financing_status` (migration 0057) | **owner picks vendor** → adapter |

**Migrations added:** 0055 (contract_template), 0056 (commission_status +charged_back), 0057 (job.financing_*). All idempotent. **Run `pnpm --filter @savvy/db db:migrate` on prod** (0055→0057 pending).

## Remaining work

### Cell 16 — Mortgage endorsement chase (NOT BUILT) — expansion-phases.md #282
Reuse the claim money ledger from depreciation (#111/#112). Build:
- Lender **co-payee detection** on claim payments (parse payee names on insurance checks/payments).
- Per-lender **package templates** in Library (endorsement submission packet).
- **Multi-channel follow-up** on existing comms rails (mail via templates until PostGrid — note the seam).
- **5-business-day no-idle invariant** (evidence check: no endorsement sits idle > 5 business days) — bind to a registry task (candidate: 148 "Mechanics lien filing" is wrong; look for an endorsement/lender task, else the closest claims task).
- Cards only for **wet-signature / homeowner actions**.

### Cell 12 remainder — Cost sheets + landed-cost selector (NOT BUILT) — #335/#337
- **Versioned supplier cost sheets** in Library (per supplier, `sheet_freshness < 90d` invariant).
- **Rebase the #136 price-guard** onto these sheets as the agreed-price source of truth.
- **Landed-cost comparison** on every PO draft: units × price + delivery + surcharges + minimums; auto-pick above a confidence margin, card otherwise.
- Predicted-vs-actual fed by the existing invoice parse.

### Cell 18 remainder — commissions reporting surfaces (UI-heavy)
- **Versioned commission plans in Library** — exactly one active per rep (today plans live in `tenant.settings.finance.commission`; move to a table + migrate the accrual source in `recordCommission`).
- **Monthly statements** with job drill-down + **dispute cards**.
- **Payout export** with owner-approval card.

## Owner-action cards (assistant cannot do these)
1. **Alta launch (cell 20 execution):** provide Clerk org + owner, CO license numbers, Twilio subaccount/token + carrier 10DLC registration, QB/Stripe accounts. Then `pnpm --filter @savvy/db db:provision provisioning/alta.json --commit`.
2. **A2P 10DLC carrier registration (cell 6 green):** the break-glass card in the app has the exact brand/campaign steps.
3. **Financing vendor (cell 11 adapter):** pick a GreenSky-class provider; then implement `FinancingProvider` + estimate apply-link injection + webhook route.

## House gotchas re-confirmed this session
- **`@savvy/db` index barrel is in the Next app graph** (via @savvy/agents → inngest route). Do NOT re-export anything that imports the registry seed (`master-task-list.ts` uses `.js`-extension imports Turbopack can't resolve). Ops utilities import directly, not via the barrel. (Cost me a red e2e on #145.)
- **The build CI job runs the FULL vitest suite** — run `pnpm --filter <pkg> exec vitest run` (whole package) before pushing, not just your new test file. An enum-guard test (`enums.test.ts`) will break on any enum change. (Cost me a red build on #147.)
- **Shared local Postgres across worktrees** — DB-backed tests can hit orphaned rows from a crashed run in another worktree (e.g. `task_registry` 9401–9405). A failure in an untouched test file = pollution; trust CI's fresh DB. New enum values / columns must be applied to the local DB manually (ALTER … IF NOT EXISTS) since we don't run `db:migrate` locally.
- **Adding a `CHECK_BINDINGS` entry** requires updating the bound-set assertion in `master-task-list.test.ts` AND ensuring the check exists in `evidenceChecks`.
- **External-dependent checks** (QBO/Stripe/A2P) use the inject-in-`health-sweep.ts` pattern — core ships a placeholder that throws; health-sweep injects the real loader (core can't import db/integrations).
