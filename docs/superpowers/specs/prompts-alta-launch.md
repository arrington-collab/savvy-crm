# Claude Code Prompt: Finish the Contract — Northwind Launch Path

Paste everything below this line into a fresh Claude Code session at `~/Sites/savvy-crm`. Supersedes the run-order in older prompt files for the remaining cells. Written 2026-07-04 against repo state at #136 + canvass slices.

---

Finish the First-20-Cells contract (`docs/superpowers/specs/first-20-cells.md`) on the Northwind-critical path. **12 of 20 cells are DONE** — verify, don't rebuild: 1 (timezone) · 2 (registry) · 3 (evidence framework) · 4 (health sweep/Today/digest/founder-minutes) · 5 (Operator Console #126–#132) · 7 (comms hygiene #125) · 9 (Roofr auto-order) · 10 (estimate auto-draft) · 13 (supplier invoice ingestion + price-guard + auto-credit #133–#136) · 14 (job costing actuals → GM·MTD #135) · 15 (depreciation G1/G2 #111–#112) · 19 (homeowner status page).

## Step 0 — state check (do not skip)

1. `git status` + `git log origin/main -5`. If there is uncommitted work or an unresolved conflict (a canvass merge was in flight around #137–#138 and local was behind origin), STOP and report — do not build on a dirty tree. Start from a fresh worktree off a clean, current `origin/main`.
2. Re-verify the done-list above with quick greps before trusting it — this repo moves fast.
3. Check `packages/db/drizzle/meta/_journal.json` for the true next migration number.
4. House rules: worktree per cell, TDD, PR per cell, watch CI; per-tenant crons on `tenant.timezone`; seams dormant by default; secret-box for creds; computed exception vectors; **no real tenant keys in any tracked file** (a canvass script nearly leaked keys — treat this as a live risk, audit anything you touch).

## Build order (Northwind-critical first)

### Cell 6 — A2P 10DLC + deliverability (DO FIRST — external clock)
Audit both tenants' Twilio setup via API: brand + campaign registration state, number→campaign attachment. Output a **break-glass exception card per unregistered tenant** with the exact registration steps (brand EIN info, campaign type, sample messages) — the owner performs the carrier registration; code can't. Build the ongoing monitor: delivery-rate per number per tenant from Twilio delivery receipts, spam/error-code watch (30007 etc.), auto-throttle outbound below threshold + card. Bind `comms.deliverability` evidence. Done when: registration state visible on the Agents page, monitor green 14 days (or amber with the card explaining exactly what the owner must do).

### Cell 17 remainder — license matrix + SB38 (Northwind/CO legal gate)
`license` table: per-tenant, per-jurisdiction (Denver-metro city registrations; AZ ROC), number, expiry, status. **Blocking invariant in the scheduling write path: no job scheduled in a jurisdiction without an active license** — red-path test is the deliverable. Renewal clocks (60d card). SB38 contract pack: right-to-rescind, deductible no-waiver, 10-day language in CO contract templates; template-version invariant — every signed CO contract used a compliant version. Permit gates already exist in `packages/core/src/production.ts` — extend, don't duplicate.

### Cell 20 — Northwind provisioning (the launch itself)
One idempotent script + runbook: create tenant (name, `America/Denver`), Twilio subaccount/number wiring (+ 10DLC pointers from cell 6), golden-set template clone, price book import, license matrix seed (from cell 17), registry seed + `tenant_task_config`, digest times, break-glass rules, dormant-seam inventory (what activating each requires). Dry-run mode first. **Secrets via env/secret-box only — the script must contain zero literal keys.** Then execute with the owner and log wall-clock time as the baseline. Done when Northwind exists as tenant #2 with a `provisioning.complete` artifact.

### Cell 8 remainder — verify/complete money reconciliation
Confirm `finance.qb_reconcile` and `finance.stripe_match` checks exist and run in the sweep (invoice_math + commissions confirmed already). Build whichever is missing: Savvy AR == QuickBooks AR nightly; Stripe payouts == payments ledger. Fail ⇒ exception with the diff attached.

### Cell 18 remainder — commissions completion
Audit what exists (commissions page, `finance.commissions` check, `packages/core/src/finance.ts`) against the spec (expansion-phases #318–#323): plan versions in Library, accrual on COLLECTION events only, auto-chargebacks, monthly statements with job drill-down, dispute cards, payout export with approval card. Build only the gaps.

### Cell 16 — mortgage endorsement chase
Per expansion-phases #282: lender co-payee detection on claim payments, per-lender package generation (templates in Library), multi-channel follow-up sequence on existing comms rails, **5-business-day no-idle invariant**, wet-signature/homeowner-action cards. Reuses the claim money ledger from the depreciation work.

### Cell 11 — financing seam
`FinancingProvider` interface, dormant default. **Ask the owner which vendor before wiring an adapter** (card/note — do not pick one). Apply link on retail estimates ≥ floor; webhook → application status on job; status enums only, no credit data. 

### Cell 12 remainder — cost sheets + landed-cost selector
Per expansion-phases #335/#337: versioned supplier cost sheets in Library (the price-guard from #136 currently checks against what it has — rebase it onto these sheets as the agreed-price source of truth); landed-cost comparison (units × price + delivery + surcharges) attached to every PO draft, auto-pick above confidence margin. Predicted-vs-actual fed by the existing invoice parse.

## After all cells: close the contract
Update the STATUS block in `first-20-cells.md` to 20/20 with evidence links, then write "The Next 20" proposal (do NOT start it): candidates from the payout-ranked automation roadmap — Storm Sentinel + PostGrid (prompts exist: `prompts-postgrid.md`), Strike List (`prompts-strike-stalk-expansion.md` Prompt 1), wave-2 slices of Prompt 2, Stalk List. Owner approves before any of it begins.

## Standing rules
One cell at a time, in this order. Blocked ⇒ say why and stop. Every PR: which cell/task IDs + what proves it ran correctly. No fictional numbers anywhere — "—" with a tooltip beats a fake metric.

Start with Step 0, then cell 6. Restate the plan, confirm the migration number, and list files you'll touch.
