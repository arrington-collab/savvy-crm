# Claude Code Prompt: Final Cells — Close the Contract

Written 2026-07-05 against repo state at #143 + canvass beta hardening. Supersedes `prompts-alta-launch.md` (cells 6 and 17a are now DONE — do not rebuild).

---

Close out the First-20-Cells contract (`docs/superpowers/specs/first-20-cells.md`). **14 of 20 done** — verify with greps, don't trust or rebuild: 1–5, 6 (10DLC monitor #141), 7, 9, 10, 13, 14, 15, 17a (license matrix + scheduling block #143, migration 0054), 19. Canvass field app, DIY sketch tool, photo QC, weather reschedule all exist beyond the contract.

## Step 0 — state check
1. Fresh worktree off clean, current `origin/main`. If the tree is dirty or a canvass session is mid-flight, stop and report.
2. Confirm next migration number from `packages/db/drizzle/meta/_journal.json` (0054 was license matrix; canvass added others — never assume).
3. House rules: TDD, PR per cell, watch CI, per-tenant TZ, dormant seams, secret-box creds, zero literal keys in tracked files.

## Build order

### 1 · Cell 17b — SB38 contract pack (finish it; small)
Rescission notice already exists in the canvass signed-copy email (f3e82fe) — extend to ALL CO contract paths, not just door-knock intake. Add: deductible no-waiver language (C.R.S. 6-22-105), 10-day/rescission provisions, and the **template-version invariant**: every signed CO contract records the template version used, and a compliant-version check runs in the sweep. Red-path test: a contract from a stale template fails the invariant. AZ door-to-door rescission stays as-is in canvass.

### 2 · Cell 20 — Northwind provisioning script + execution
`ensureTenantForOrg`/`ensureUser` primitives exist in `packages/db/src/lifecycle/provisioning.ts` — build the full runbook on top: one idempotent script (dry-run mode first) that creates/configures the tenant end-to-end — name + `America/Denver`, Twilio subaccount + number wiring + 10DLC campaign pointers (monitor from #141 will surface registration state), golden-set template clone, price book import, license matrix seed (cell 17a table), registry seed + `tenant_task_config`, digest times + break-glass rules, dormant-seam inventory (financing, PostGrid, etc. — what activating each requires). Secrets via env/secret-box only. Then EXECUTE for Northwind with the owner; log wall-clock time; produce a `provisioning.complete` artifact. **This cell ends with Northwind live as tenant #2.**

### 3 · Cell 8 — QB + Stripe reconciliation checks
`finance.qb_reconcile` (Savvy AR == QuickBooks AR nightly) and `finance.stripe_match` (payouts == payments ledger) are still absent from `packages/core/src/verification/checks.ts`. Build both on the existing builders; failures emit an exception with the diff attached. Fail-soft to `stale` on vendor API downtime.

### 4 · Cell 18 — commissions completion
Audit existing (commissions page, `finance.commissions` check, `packages/core/src/finance.ts`) vs spec (`expansion-phases.md` #318–#323). Build only gaps: versioned plans in Library (exactly one active per rep), accrual on COLLECTION events only, auto-chargebacks on callbacks/cancellations, monthly statements with job drill-down + dispute cards, payout export with owner approval card. Now that GM comes from actuals (#135), wire accruals to collected GM from real job costs.

### 5 · Cell 16 — mortgage endorsement chase
Per `expansion-phases.md` #282: lender co-payee detection on claim payments, per-lender package templates in Library, multi-channel follow-up on existing comms rails (mail via templates until PostGrid lands — note the seam), **5-business-day no-idle invariant**, cards only for wet-signature/homeowner actions. Reuse the claim money ledger from depreciation (#111/#112).

### 6 · Cell 11 — financing seam
`FinancingProvider` interface + dormant default only. **Stop and ask the owner for the vendor before writing any adapter.** Apply link on retail estimates ≥ configurable floor; webhook → status enums on the job (no credit data ever). If the owner hasn't chosen, ship the seam + estimate-template slot and mark the cell amber-with-reason.

### 7 · Cell 12 remainder — cost sheets + landed-cost selector
Versioned supplier cost sheets in Library (`expansion-phases.md` #335); **rebase the #136 price-guard onto them as the agreed-price source of truth**; landed-cost comparison (units × price + delivery + surcharges + minimums) attached to every PO draft (#337), auto-pick above confidence margin, card otherwise; predicted-vs-actual fed by the existing invoice parse. `supplier.sheet_freshness` invariant (< 90d).

## Close-out (after cell 12r)
Update `first-20-cells.md` STATUS to 20/20 with PR/evidence links. Write "The Next 20" as a PROPOSAL ONLY — candidates ranked by the founder-minutes roadmap: Storm Sentinel + PostGrid (`prompts-postgrid.md`), Strike List (`prompts-strike-stalk-expansion.md` Prompt 1), Stalk List, wave-2 Prompt 2 slices (rep layer, maintenance, continuity), canvass↔Turf integration. Owner approves before anything starts.

## Owner actions this prompt cannot do (surface as cards, then move on)
- File A2P 10DLC brand/campaign registration (monitor #141 shows state + steps).
- Choose the financing vendor (cell 11 waits on it).
- Provide Northwind's real-world inputs at cell 20 execution: licenses for the matrix, price book, Twilio/QB/Stripe accounts.

One cell at a time, in this order. Blocked ⇒ say why and stop. Every PR: which cell + what proves it ran correctly. Start with Step 0, then 17b.
