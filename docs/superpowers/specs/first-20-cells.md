# The First 20 Cells — Build Contract

**Signed intent:** nothing new enters the registry as buildable work until these 20 ship. A cell is DONE when its evidence check runs green in production — not when the PR merges. Order may change only by swapping cells, with the payout justification logged in this file. Every future Claude Code session reads this first.

**Gate 0 (before cell 1):** merge #82 → #81 → #83 per the 2026-06-30 handoff (0037 collision procedure), run prod migrations from the correct worktrees, fix the stale repo root. Not a cell — unfinished business.

## STATUS — updated 2026-07-06 (code-merged, not yet "green in prod"; verify before building)

**Reminder of the DONE bar:** a cell is DONE only when its evidence check runs **green in production** — merged ≠ done. Several cells below are code-complete but **amber pending owner action or real traffic** (10DLC registration, vendor selection, QBO/Stripe connection, Alta launch). This block reflects code state honestly — no fictional "20/20".

- **DONE (code on main, evidence path exists):** 1 timezone (#105/#107) · 2 registry (`schema/task-registry.ts`, `seeds/master-task-list.ts`) · 3 evidence framework + checks (`packages/core/src/verification/`) · 4 health sweep + Today + ops-digest + founder-minutes (#102–#106) · 5 Operator Console (#126–#132) · 6 A2P 10DLC + deliverability monitor (#141) · 7 comms hygiene (#125) · 9 Roofr auto-order · 10 estimate auto-draft · 13 supplier invoice price-guard (#133–#136) · 14 job costing actuals→GM (#135) · 15 depreciation G1+G2 (#111/#112) · **17 license matrix (17a #143) + SB38 contract pack (17b #144)** — cell 17 complete · 19 homeowner status page. Bonus beyond contract: photo QC (#121–#124), weather reschedule (#120), capacity (#118).
- **AMBER (code merged this session; goes green on owner action / real traffic):**
  - **8 — QB + Stripe reconciliation (#146):** `finance.qb_reconcile` + `finance.stripe_match` live (reconciled tier, fail-soft to stale), bound to registry tasks 150 + 141. **Skips until a tenant connects QuickBooks/Stripe**; green after 14 clean days once connected.
  - **11 — financing seam (#148):** `FinancingProvider` interface + `dormantFinancing` default + `shouldOfferFinancing`/`mapFinancingStatus` + `job.financing_status` (migration 0057). **Adapter waits on the owner picking a vendor.**
  - **20 — Alta provisioning (#145):** idempotent, dry-run-first `provisionTenant` runbook + CLI + dormant-seam inventory. **Execution (Alta live as tenant #2) is owner-run** — real Clerk org / CO licenses / Twilio+10DLC / QB+Stripe.
- **PARTIAL (real gaps remain):**
  - **18 — commissions (#147):** **auto-chargeback on job→lost** shipped (money-integrity gap closed; `commission_status='charged_back'`, migration 0056). **Remaining:** versioned plans in Library (one active per rep), monthly statements + dispute cards, payout export with owner approval.
  - **12 remainder — NOT BUILT:** procurement schema + material-order exist; **versioned supplier cost sheets + landed-cost selector (#335/#337) still missing.**
  - **16 — NOT BUILT:** mortgage endorsement chase (#282) — lender detection, package templates, 5-day no-idle invariant.
- **Remaining work (handoff `docs/superpowers/specs/2026-07-06-closeout-handoff.md`):** cell 16 (full), cell 12r (full), cell 18 reporting surfaces. Plus owner-action cards: Alta launch (cell 20 execution), 10DLC carrier registration (cell 6 green), financing vendor (cell 11 adapter).

---

## Wave A — Foundation (the spine everything binds to)

| # | Cell | Payout | Done when |
|---|---|---|---|
| 1 | **Per-tenant timezone** — `tenant.timezone`, all crons + customer-facing times read it; kill every hardcoded TZ | Alta (Denver) can't onboard without it; fixes GMT-in-SMS bug | No "GMT" or wrong-TZ string can reach a customer (invariant exists and passes) |
| 2 | **Task registry schema + seed** — task_registry, tenant_task_config, job_task, verification_run, task_health; seed 212 + approved Phase 0/16–23 tasks | The spine; scoreboard source | 212+ rows seeded; RLS tests green; per-tenant configs for Bloom + Alta |
| 3 | **Evidence framework + first ~15 invariants** — the four builders; bug-derived checks: lead dedupe, no-double-send, body quality (no GMT/no long URLs), drip guard, speed-to-lead, roof-type exception | Turns July 1's observed prod bugs into permanent tests | All 15 run nightly; the double-send and dedupe checks pass on prod data |
| 4 | **Health sweep + Today queue + digest** — nightly sweep, status rules (green earned at 14 days), exception cards with actions, digest at tenant times + break-glass only | Batched attention: protects the VRZA day job; the operating rhythm | Owner receives digest at configured times; zero non-break-glass pings outside them |
| 5 | **Operator Console v1** — the mockup UI for real (see `prompts-operator-console.md`): nav 13→5, Today as home with exception queue + Coverage Map + portfolio strip, Pipeline merge, Money proof panel, Agents roster, Library, Job Ledger on job detail; Sage cites ledger rows. Old routes 301-redirect. | The daily driver: without this, all 20 cells can go green while the app still looks like the old CRM | Deployed Today screen recognizably matches the mockup on real data; zero fictional numbers; Sage answers a done-question with cited evidence |

## Wave B — Stop the bleeding

| # | Cell | Payout | Done when |
|---|---|---|---|
| 6 | **A2P 10DLC audit + deliverability monitor** | SMS may be silently filtered today; every channel depends on delivery | Both tenants registered; delivery-rate check green 14 days |
| 7 | **Comms hygiene fixes** — short links (`/b/`) in all SMS bodies, human-readable local times everywhere, double-send root cause fixed | Customer-facing credibility; carrier spam scores | Body-quality + no-double-send invariants green 14 days |
| 8 | **Money reconciliation invariants** — Savvy AR ↔ QuickBooks, Stripe payouts ↔ ledger, invoice math vs price book | Headless money requires nightly proof; catches drift before it compounds | All three reconciliations green 14 days on Bloom prod |

## Wave C — The money loop (lead → estimate → order → cash, no manual links)

| # | Cell | Payout | Done when |
|---|---|---|---|
| 9 | **Roofr measurement auto-order + ingest** — order at booking (pre-order for Strike List golden targets later); squares/pitch/waste/facets onto property | Unblocks estimate automation — the manual link in the middle of the chain | Every booked inspection has measurement data before the appointment |
| 10 | **Estimate auto-draft** — measurement × price book → good/better/best draft; over-threshold ⇒ approval card (existing rule) | VERA prices without a human; speed-to-estimate becomes minutes | Estimate drafted < 1h after inspection completes, evidence-bound |
| 11 | **Financing seam** — apply link in every retail estimate (GreenSky-class vendor behind seam), status webhook → pipeline | Close-rate lift on $15–30k retail; adapter-sized effort | Every retail estimate carries financing option; applications tracked to decision |
| 12 | **Supplier cost sheets + landed-cost selector (#335, #337)** — versioned sheets per supplier; per-job landed cost (units × price + delivery + surcharges) picks the PO winner | Direct margin: the QXO-delivery-fee-vs-unit-price math on every order | Every material order carries the comparison artifact; predicted vs actual tracked |
| 13 | **Supplier invoice ingestion + price-guard (#336)** — AI-parse invoice emails → job costs; every line checked vs cost sheet; **overage ⇒ auto credit-request email with evidence; recovery tracked** | Recovered credits are found money; job costing becomes real | 100% of lines checked; first credit request sent + tracked; recovered $ appears in digest |
| 14 | **Job costing actuals → true GM** — material actuals (from 13) + labor/sub costs per job; estimate-vs-actual variance | Every money number (GM, commissions, pricing) becomes true instead of assumed | GM per job computed from actuals; variance report exists |
| 15 | **Recoverable depreciation machine (#283 + #299)** — walkthrough sign-off → COC → final invoice to carrier < 10 days, payment watch; RCV close blocked without it | Biggest single insurance-cash leak, structurally sealed | Blocking invariant live; first depreciation payment traced end-to-end |
| 16 | **Mortgage endorsement chase (#282)** — lender detection, package generation, multi-channel follow-up, 5-day no-idle invariant | Weeks of office-human time per claim → background sequence | An endorsement runs the full sequence with zero idle-day violations |

## Wave D — Protection + scale readiness

| # | Cell | Payout | Done when |
|---|---|---|---|
| 17 | **License + permit blocking invariants (#289, #294) + SB38 templates (#293)** | Colorado legal exposure; blocking beats reminding | Red-path tests prove scheduling/production physically blocked without license/permit; CO contracts on compliant templates |
| 18 | **Commission engine core (#318–#321)** — plans in Library, accrual on collected cash, chargebacks, monthly statements, dispute cards | Reps trust the math or they leave; owner stops doing spreadsheets | First monthly statements auto-generated; accrual invariant green |
| 19 | **Customer status page** — tokenized per-job link: schedule, crew, photos, payments, docs | Kills "where's my crew" inbound; feeds reviews; near-zero build risk | Live on every active job; link in booking + reminder messages |
| 20 | **Alta provisioning runbook — scripted, then executed** — numbers, templates, price book, licenses seed, timezone, registry config; Alta goes live on it | The acquisition thesis in miniature: if Alta onboarding isn't scripted, no acquisition ever will be | Alta live as tenant #2 via the script; provisioning time logged as the baseline to beat |

---

## Explicitly NOT in the first 20 (and why that's correct)

**Storm Sentinel + PostGrid mail, Strike/Stalk Lists, golden roofs** — wave 2 (cells 21+). Demand gen before the ops spine means leads the machine fumbles. Alta's launch leads come from what needs no build: LSA + GBP with existing 4-minute speed-to-lead, referrals, and your own network. The sentinel enters the moment cells 1–8 are green — likely before storm season peaks.
**Deferred by the payout gate:** programmatic SEO, ad-API bidding, second-model sampled audits (manual review at current volume), comms-failover code (runbook only), CV pilot (assessor + tagger first), rep recruiting automation, maintenance program, Stalk List build.

## Standing rules

1. **Payout gate:** a new task enters the registry only with estimated effort + estimated payout (founder-min/yr or $/yr) recorded; it displaces a cell only if its ratio clearly beats one — swap logged here.
2. A cell isn't done until its evidence is green in prod. Merged ≠ done.
3. One cell in progress per Claude Code session; finish or hand off before starting the next.
4. When all 20 are green: reassess against this file, write "The Next 20," and let demand gen off the leash.

---

## The Next 20 — PROPOSAL ONLY (do not start; owner approves)

**Gate:** per standing rule 4, demand gen comes off the leash only when the first 20 are **green in prod**. Today the code is largely merged but several cells are amber (10DLC registration, QBO/Stripe connection, financing vendor, Alta launch) — so this is a *ranked candidate list*, not authorized work. The moment the ops spine is green (cells 1–8 especially), the sentinel enters. Ranked by the founder-minutes / demand-gen roadmap:

1. **Storm Sentinel + PostGrid direct mail** (`prompts-postgrid.md`) — storm-triggered address lists → automated mail sequences. The demand-gen engine the ops spine was built to feed; enters "the moment cells 1–8 are green." Highest payout once the machine can absorb the leads it produces.
2. **Strike List** (`prompts-strike-stalk-expansion.md`, Prompt 1) — golden-target prioritization (pre-ordered measurements, high-intent roofs). Direct lift on close rate per rep-hour.
3. **Stalk List** — continuity/nurture of not-yet-ready targets; feeds the Strike List over time.
4. **Wave-2 Prompt 2 slices** (`prompts-strike-stalk-expansion.md`, Prompt 2) — rep layer (recruiting/onboarding automation), maintenance program, customer continuity. Retention + labor-supply leverage.
5. **Canvass ↔ Turf integration** — connect the door-knock canvass app to territory/Turf data so field reps and the demand engine share one map.

Also on deck from the deferred list (see "Explicitly NOT in the first 20"): programmatic SEO, ad-API bidding, second-model sampled audits, comms-failover code, CV pilot. Each needs an effort + payout estimate logged here (standing rule 1) before it displaces anything.
