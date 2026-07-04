> ## ⚠ BUILD-CONTRACT ALIGNMENT (added 2026-07-01 — read before running anything)
> The **First 20 Cells contract** (`docs/superpowers/specs/first-20-cells.md`) governs build order. Against it:
>
> - **Prompt 1 (Strike List, below): HOLD — wave 2.** Do not run until the contract's 20 cells are green.
> - **Prompt 2 (Phases 16–22): RUN PARTIALLY.** Execute slices **1, 2, 3, 4, 5, 7 only** (= seed/tiles + cells 6, 17, 15, 16, 18). **Skip slices 6, 8, 9, 10** (photo QC, rep layer, maintenance, continuity) — payout-gated to wave 2; their tasks stay seeded gray.
> - **Prompt 3 (Stalk List): HOLD — wave 2.**
> - The separate PostGrid prompt: **HOLD** — unlocks with Storm Sentinel at cell 21+.
>
> Any session reading this file: confirm which prompt + slices you were asked to run, and refuse wave-2 work while contract cells remain open.

# Claude Code Prompt: Strike List Machine (Golden Roofs · Roof Tagger · Turf Score)

Paste everything below this line into a fresh Claude Code session at `~/Sites/savvy-crm`.

---

Build the Strike List machine for Savvy: pre-storm roof targeting from three sources — assessor roof-material data ("golden roofs": shake, clay tile, asbestos-suspect), the Roof Tagger spotter app (bloomroofs.vercel.app), and Turf Score (neighborhood momentum). Output: one ranked, geocoded **Strike List** per tenant that the storm sentinel targets from exclusively. This is a background op — data flows in on crons and syncs, lists refresh themselves, and humans see only drive-route suggestions, threshold-crossing campaign approvals, and health exceptions.

## Before you write any code

1. Read `docs/superpowers/specs/task-registry.md` (task_registry / job_task / task_health / evidence-check framework) and `docs/superpowers/specs/phase0-demand-generation.md` — this build implements tasks **#257 (assessor ingestion), #260 (subdivision inference), #262 (golden lists), #265–#267 (Roof Tagger sync, spotter accuracy, tile-debris funnel), #268 (DIY CV pilot), #269–#271 (Turf Score, turf triggers, Strike List assembly)**. Task #258 (paid CV vendor) is explicitly deferred pending #268's decision gate; #263 (sentinel priority tier) lands with the sentinel build, but #271 must expose the query it will consume.
2. Verify merge state on `main` and check `packages/db/drizzle/meta/_journal.json` for the true next migration number — do NOT assume (prior `0037` collision).
3. Follow the established process: worktree per slice off `origin/main`, spec in `docs/superpowers/specs/`, TDD, PR per slice, watch CI. Prod migrations run manually from the worktree containing the new migration, then verify columns exist.
4. Reuse existing patterns exactly: vendor seams like `EmailFinder` (dormant defaults), the enricher registry from #81 (ordered, fail-soft, `enrichment_attempt` backoff), per-tenant Inngest fan-out with schedules from `tenant.timezone`, `integration_connection` + secret-box for any credentials.

## Data model (one migration)

- Extend `property`: `roof_material` (enum: asphalt_shingle · wood_shake · clay_tile · concrete_tile · metal · flat_builtup · asbestos_suspect · other — reconcile with the existing `ROOF_TYPE_VALUES` enum rather than duplicating it), `roof_material_source` (assessor · spotter · inference · cv_pilot · inspection), `roof_material_confidence` numeric, `subdivision` text, `parcel_id` text. **Precedence rule: `inspection` is authoritative and is never overwritten; other sources upgrade only lower-precedence values** (mirror the email `self_reported`-vs-`appended` policy from #83).
- `spotter_pin`: id, tenant_id, external_id (tagger pin id), lat/lng, material_tag, has_debris bool, spotter_name, tagged_at, synced_at, matched_property_id nullable, precision_score nullable. RLS.
- `neighborhood`: id, tenant_id, name (subdivision/plat), parcel_count, our_completed_jobs, turf_score numeric, last_scored_at. RLS.
- `strike_list_entry`: id, tenant_id, property_id, reasons jsonb (array: golden_shake · golden_clay · turf · claim_window · debris_funnel), rank numeric, refreshed_at. RLS. Unique (tenant_id, property_id).

## Behavior

1. **Assessor ingestion (#257):** bulk importer for county parcel data behind an `AssessorFeed` seam — first adapter: Maricopa County (roof cover field: Wood Shake / Clay Tile / Concrete Tile / Comp Shingle; plus year built, subdivision, parcel id). Idempotent re-runs (annual refresh). Match to `property` by normalized address; unmatched parcels stored as prospect properties. Subtract re-roofed parcels using permit history where available.
2. **Roof Tagger sync (#265):** the tagger is a separate Vercel app with its own DB. Build a pull sync (cron, ≤ 1h lag) via an API endpoint or direct DB read — inspect the tagger repo/DB to decide; if it needs an export endpoint, spec the minimal one and note it as a follow-up in that repo. Pins match to properties by point-in-parcel or nearest-address; unmatched pins create prospect properties. Write `roof_material` per the precedence rule. **Push direction:** expose a `drive_routes` endpoint/JSON the tagger can render — uncertain clusters from inference (#260) grouped into street-level routes, refreshed weekly.
3. **Subdivision inference (#260):** cluster by (subdivision, year_built ±2). If ≥ 8 confirmed samples (inspection/spotter/assessor agreement ≥ 80%) → propagate material to unconfirmed parcels in the cluster with `source='inference'` and confidence = f(sample count, agreement). Never overwrite higher-precedence sources. Permit-recorded re-roofs are excluded from propagation.
4. **Tile-debris funnel (#267):** pin with `has_debris` + property roof age ≥ 17 yrs → generate valley-cleaning quote priced from the price book → deliver by PostGrid mailer (or SMS only with existing opt-in) → booking link routes to the standard `/book/` flow tagged as cleaning-visit-doubles-as-inspection. Quotes above tenant threshold become approval exception cards.
5. **Turf Score (#269–#270):** monthly per-neighborhood: `our_completed_jobs / parcel_count`, recency-weighted (jobs in last 24mo count full, older decay), bonus terms for review/referral density if cheaply available. Threshold crossing (default 5%, per-tenant param) emits a campaign trigger: "neighbors chose us" mailer variant + canvass priority — spend follows the existing approval-card rules from the PostGrid build.
6. **Strike List assembly (#271):** weekly cron composes golden roofs + turf neighborhoods + open claim-window addresses into `strike_list_entry` with reasons and rank (rank inputs: material value tier, turf score, claim-window days remaining, confidence). Expose `getStrikeList(tenantId, polygon?)` in `@savvy/core` — the storm sentinel will call it with a swath polygon.
7. **DIY CV pilot (#268):** batch job — NAIP imagery tiles (public domain) for golden-candidate parcels lacking assessor/spotter data → VLM classification (use the existing AI-call plumbing; log spend to the AI-spend meter) → precision measured against inspection + spotter ground truth → produce a buy/skip decision card for the paid vendor layer (#258). This is a bounded experiment: hard cap on parcels and spend, config in `tenant_task_config.params`.

## Registry wiring

Bind evidence checks per the framework: `assessor.freshness` (annual refresh executed; coverage % ≥ threshold), `tagger.sync` (no pin older than 1h unsynced; attribution present), `tagger.precision` (monthly per-spotter report artifact), `inference.integrity` (invariant: no inference row overwriting inspection/spotter data; every inferred value carries confidence + sample refs), `debris.funnel` (every qualifying pin actioned < 72h or exclusion logged), `turf.freshness` (monthly scoring executed; every neighborhood with ≥ 1 job scored), `strike.freshness` (< 7d), and `strike.exclusivity` (**invariant: 100% of sentinel/mail campaigns trace to strike_list_entry reasons — no untraced targeting**). Write `agent_run` records for every cron so it all shows in the command-center feed.

## Slices (one PR each)

1. **Schema + assessor importer** — migration, `AssessorFeed` seam, Maricopa adapter, address matching, precedence rule. Tests: precedence (inspection never overwritten — red-path test), idempotent re-import, re-roof subtraction.
2. **Tagger sync (pull) + spotter accuracy** — pin ingestion, property matching, prospect creation, per-spotter precision scoring. Tests: point-in-parcel matching, unmatched-pin handling, precedence again from spotter source.
3. **Inference + drive routes (push)** — clustering, propagation rules, route generation endpoint. Tests: 8-sample/80% thresholds, permit exclusion, no-overwrite invariant, route grouping.
4. **Turf Score + triggers** — scoring cron, threshold campaign triggers into the existing mail-campaign engine. Tests: recency weighting, threshold crossing emits exactly one trigger, spend approval path.
5. **Strike List assembly + debris funnel** — composition cron, rank function, `getStrikeList`, valley-cleaning quote flow. Tests: reasons correctness, polygon filtering, funnel 72h SLA, quote pricing from price book, e2e in a test tenant: assessor shake + tagger pin + 2 jobs in subdivision → entry appears with all three reasons.
6. **CV pilot** — bounded batch, precision report, decision card. Tests: spend cap enforcement, report artifact generation.

## Guardrails

- Precedence: inspection > spotter > assessor > cv_pilot > inference. Enforced in one write path (`setPropertyRoofMaterial`), not scattered.
- No marketing send to `asbestos_suspect` without inspection verification (invariant from #261 — wire it here since this build creates those flags).
- All schedules per `tenant.timezone`; no hardcoded TZ.
- Tagger data is per-tenant (Bloom's pins belong to Bloom's tenant).
- Definition of done per PR: "which task IDs does this execute, and what proves it ran and ran correctly?"

Start with slice 1. Before coding, restate the plan, confirm the migration number from the journal, inspect the Roof Tagger app's data layer to pick the sync mechanism, and list which existing files you'll touch.

---
---

# Claude Code Prompt 2: Expansion Phases 16–22 (Rep Layer · Insurance Money · Compliance · QC · Maintenance · Continuity · Commissions)

Paste everything below this line into a fresh Claude Code session at `~/Sites/savvy-crm`. Run this AFTER the task-registry build exists (it seeds into and depends on it). It can run before/parallel to the Strike List build above — no shared tables beyond the registry.

---

Implement the expansion phases of Savvy's master task list: seed tasks **#272–#323** from `docs/superpowers/specs/expansion-phases.md` into the task registry, add the deferred-area placeholder tiles, and build the highest-priority machines in the slice order below. Everything follows the house rules: background by default, checker ≠ doer, evidence-bound tasks, exceptions batched to digests, no new CRUD frontends — read-only proof surfaces and one-tap cards only.

## Before you write any code

1. Read `docs/superpowers/specs/task-registry.md`, `docs/superpowers/specs/phase0-demand-generation.md`, and `docs/superpowers/specs/expansion-phases.md` (Phases 16–22 task tables — they are the spec; this prompt is the build order).
2. Check `packages/db/drizzle/meta/_journal.json` for the true next migration number. Never assume.
3. Worktree per slice off `origin/main`, TDD, PR per slice, watch CI. Prod migrations manually from the owning worktree, verify columns after.
4. Reuse: secret-box + `integration_connection` for any new creds; vendor seams with dormant defaults; per-tenant Inngest fan-out on `tenant.timezone`; computed exception vectors (state-derived, no marker columns).

## Slice order (one PR each; each slice = seed its tasks with evidence bindings + build the machine)

1. **Seed + placeholders.** Seed #272–#323 into `task_registry` (approved phases with real bindings where the checks are cheap; everything else `manual`/gray so the Coverage Map shows the frontier). Add the two locked tiles: **M&A Machine** (Portfolio view) and **Labor Supply** (Agents view) — static blurred mock, "Phase 23/24 — locked" label, click reveals a one-paragraph thesis. No data, no routes behind them.
2. **10DLC + comms health (#291, #311) — do this first, it may be bleeding right now.** Audit current Twilio A2P registration state per tenant; surface an exception card with exact remediation steps if unregistered. Build delivery-rate/spam-score monitoring with auto-throttle on degradation. Tests: unregistered tenant ⇒ card; delivery below threshold ⇒ throttle + card.
3. **Compliance blockers (#289, #293, #294).** License matrix per jurisdiction with renewal clocks; **scheduling structurally blocked** without an active license in the job's jurisdiction; same blocking for required permits before production start; CO SB38 template-version invariant on every CO contract. Tests are the red paths: try to schedule unlicensed ⇒ blocked with reason; contract from stale template ⇒ invariant fails.
4. **Insurance money ledger + depreciation (#281, #283, #299).** Claim money ledger (ACV/RCV/deductible/supplement/depreciation events); final-walkthrough sign-off generating the COC; auto-submission of COC + final invoice within 10 days of completion with payment watch. Invariant: no RCV job closes without submitted final invoice. Tests: ledger reconciliation, the 10-day clock, close-blocked-without-submission.
5. **Endorsement chase + deductible compliance (#282, #284).** Lender co-payee detection, per-lender package generation (templates in Library), multi-channel follow-up sequence via existing comms + PostGrid rails, 5-business-day no-idle invariant, wet-signature cards. SB38-compliant deductible invoicing + collection evidence. Tests: idle detection, sequence progression, card emission.
6. **Photo-audit QC (#297–#299, #302).** CompanyCam set scoring against the install-spec checklist (Library doc, per roof type); punch-list exceptions; **invoice blocked with open punch items**; callback tracking wired to crew scorecards. Vision calls use existing AI plumbing + spend meter; weekly sampled human re-audit ≥ 95% agreement is the audit tier. Tests: audit gating, punch closure verification, blocked-invoice red path.
7. **Commission engine (#318–#323).** Plans as versioned Library docs; accrual on collection events only; auto-chargebacks; monthly statements with job-level drill; dispute cards; payout export with approval card. Extends the existing `finance.commissions` invariant. Tests: plan math property tests, chargeback triggers, accrual-only-on-cash red path.
8. **Rep layer core (#274, #275, #277, #279).** Pre-appointment packet compilation + 2h-before delivery; appointment confirmations/no-show rescue on existing booking rails; **voice-memo intake** (rep texts/records → transcribe → parse outcome/objections/next steps into structured fields → chase if missing < 12h); rep exception vectors with rep-first escalation. Recruiting (#272) and scorecards (#278) follow in a later pass. Tests: packet completeness invariant, memo parse fixtures, chase emission.
9. **Maintenance program (#305–#309).** Price-book subscription item on Stripe recurring, enrollment offers in existing drips, annual route-batched scheduling, visit report artifact, members pinned to Strike List top tier (integration point with `getStrikeList` rank inputs). Tests: Stripe reconcile, 12-month visit invariant, member-priority ranking.
10. **Continuity drills (#312–#315, #317).** Comms failover pool + documented cutover; quarterly restore drill as an *executed-evidence* task (restore to scratch env, row-count proof); vendor outage detection with action queuing + replay; "system down" runbook doc surfaced from Today; monthly tenant data export with integrity check. Tests: queue-don't-drop during simulated outage, replay reconciliation, export round-trip.

## Guardrails

- Blocking invariants (#289 license, #294 permit, #298 invoice-with-punch-items, #283 RCV close) are enforced in the write path, not as advisory warnings. The red-path test is the deliverable.
- Money math (commissions, ledger, chargebacks) verified by deterministic invariants in the nightly sweep; statements and payouts reconciled against QB/Stripe.
- Nothing pages the owner outside digest times except break-glass rules already configured on the tenant.
- Every slice's PR answers: "which task IDs does this execute, and what proves it ran and ran correctly?"

Start with slice 1. Before coding, restate the plan, confirm the migration number, and list which existing files you'll touch. If the task-registry build from the earlier session isn't on `main` yet, stop and say so instead of building against assumptions.

---
---

# Claude Code Prompt 3: Stalk List Machine (Multifamily & HOA Account Targeting)

Paste everything below this line into a fresh Claude Code session at `~/Sites/savvy-crm`. Depends on the task-registry build; benefits from (but does not require) the Strike List build — if `getStrikeList` doesn't exist yet, stub the integration point and note it.

---

Build the Stalk List: account-based targeting of apartment complexes and HOAs, implementing tasks **#324–#334** from `docs/superpowers/specs/phase0-demand-generation.md` §0.12. Design principle: **humans build relationships, AI builds the map.** AI does desk research — who owns it, who manages it, who decides, when they decide — with every fact cited to a source. Humans confirm on visits via voice memo and work the relationship. Reference UI: `savvy-stalk-list-mockup.html` (account list + org map + decision timeline + activity feed + portfolio panel).

## Before you write any code

1. Read `docs/superpowers/specs/task-registry.md` and Phase 0 §0.12. Check `packages/db/drizzle/meta/_journal.json` for the true next migration number.
2. House rules: worktree per slice, TDD, PR per slice, watch CI; per-tenant crons on `tenant.timezone`; vendor seams with dormant defaults; secret-box for creds; computed exception vectors.
3. Reuse the voice-memo parse pipeline from the rep layer (#277) if built; otherwise build it here in `@savvy/agents` as a shared capability (transcribe → structured extraction → entity writes), since both consume it.

## Data model (one migration)

- `account`: id, tenant_id, name, kind (hoa · apartment · condo · mgmt_company), parcel_ids text[], unit_count, buildings, roof_summary jsonb (material/year/est_value from property layers), stage (identified · mapped · contacted · relationship · bid_list · won · lost), parent_account_id nullable (**mgmt-company parent → property children = portfolio leverage**), created_at. RLS.
- `account_role`: id, tenant_id, account_id, role (hoa_president · board · cam · property_manager · maintenance_mgr · regional_mgr · other), person_name, contact jsonb, status (**unknown · suspected · confirmed**), confidence numeric, sources jsonb (array of {url/citation, note, found_at} — **required, no sourceless candidates**), confirmed_by nullable, confirmed_at nullable. RLS.
- `account_event`: id, tenant_id, account_id, kind (ai_sweep · field_visit · outreach · inbound · stage_change), actor (agent name or user), summary, detail jsonb, occurred_at. RLS. This is the activity feed and the account ledger.
- `account_timeline`: account_id, tenant_id, milestone (annual_meeting · budget_season · reserve_funded_year · bid_window · custom), date_or_window, source, workback jsonb (scheduled nurture steps). RLS.

## Behavior

1. **Inventory (#324):** from existing parcel/property data, classify multifamily/HOA parcels (land-use codes, unit counts). Score by unit_count × roof value tier (golden-roof layers apply). Promote top N per tenant to `account` stage `identified`; keep the rest queryable.
2. **Entity resolution (#325–#326):** research sweep per account — county parcel owner → Secretary of State registry (AZ/CO) for statutory agent + principals; recorded CC&Rs for association + management references; **CO: ingest DORA HOA registration (designated agent + management contact) as a bulk source**. Behind a `RegistrySource` seam per state, fail-soft, cached; each fact written with citation.
3. **People finder (#327):** per-account AI web-research sweep (existing AI plumbing + spend meter; respect robots/ToS — use search + fetch of public pages, no login-walled scraping): management-company staff pages, listing pages, public meeting minutes, Google reviews, permit records, LinkedIn public profiles. Output: `account_role` candidates with confidence + sources, status `suspected`. **Hard rule: no candidate row without ≥ 1 citation.** Weekly re-sweep for accounts in active stages; `enrichment_attempt`-style backoff.
4. **Field capture (#329):** voice memo endpoint per account (record/text from phone) → parse → propose org-map updates (confirm/deny/suspected-new) + event row. Proposals touching `confirmed` status require the human's one-tap confirm (the visit is the verification tier for people data).
5. **Timeline + work-back (#330):** extract meeting dates/budget cycles/reserve studies from sweeps (county filings, association sites); every account ≥ `mapped` must have a timeline or an explicit "next fact to find" — computed exception otherwise. Work-back schedules nurture steps (#331) via existing drip + PostGrid rails with role-appropriate content; suppression + no_double_send apply.
6. **Portfolio leverage (#332):** mgmt-company parent accounts auto-derived when ≥ 2 properties share a manager; confirming a parent-level relationship elevates all child accounts one rank tier.
7. **Strike List integration (#333):** commercial entries in `strike_list_entry` with reason `commercial_swath`; swath ∩ account with a `confirmed` decision-maker ⇒ same-day call task card; without one ⇒ "find the person" card carrying AI's best candidates + suggested visit. Invariant: 100% of commercial swath intersects actioned < 24h.
8. **Account economics (#334):** touches + trips per won account, revenue, human minutes — weekly digest line.

## UI (read-mostly, per the mockup)

Route under Pipeline → Stalk List: account list with stage chips and filters (in swath, bid window < 90d, needs trip); account detail with org map (role rows: candidate, sources as links, confidence chip, confirm/deny), decision timeline, next-action card (the only imperative element — one action + why now), activity feed, portfolio panel, voice-memo input. All writes flow through field capture + sweeps; the page edits nothing directly except role confirm/deny and manual person add.

## Registry wiring

Bind per §0.12: `stalk.inventory` (classification coverage), `stalk.sources` (**invariant: zero role candidates without citations**), `stalk.people_accuracy` (sampled: field confirmations vs AI candidates ≥ threshold — this scores the researcher), `stalk.timeline` (every mapped account has timeline or named missing fact), `stalk.visit_parse` (memos parsed < 12h), `stalk.swath_response` (< 24h invariant), `stalk.portfolio` (parent links derived), plus no_double_send/suppression on all outreach. `agent_run` rows for every sweep.

## Slices (one PR each)

1. **Schema + inventory** — migration, multifamily classification, account promotion, list UI shell. Tests: classification fixtures, RLS, promotion scoring.
2. **Entity resolution + DORA/CC&R ingestion** — `RegistrySource` seam, AZ/CO adapters, citation-required writes. Tests: citation invariant red path, idempotent re-sweeps, fail-soft on source downtime.
3. **People finder + org map UI** — research sweep, candidate writes, confirm/deny flow. Tests: no-citation rejection, confidence math, confirm transitions, backoff.
4. **Field capture** — voice memo → parse → proposals → event feed (shared pipeline with #277 if present). Tests: parse fixtures (incl. "met Frank at building 6, he confirmed"), 12h chase, confirm-required gating.
5. **Timeline + nurture work-back** — extraction, exception vector for missing timelines, role-based nurture scheduling. Tests: work-back scheduling, suppression.
6. **Strike List + portfolio + economics** — commercial entries, swath cards, parent derivation + rank elevation, digest metrics. Tests: 24h invariant, portfolio elevation, e2e: seeded account + fake swath ⇒ correct card with candidates attached.

## Guardrails

- **Citations or it didn't happen:** every AI-sourced fact about a person carries its source. The org map is a research artifact, not a guess board.
- Desk research on public pages only; no login-walled scraping; respect ToS (the earlier Zillow/Redfin decision applies as precedent).
- Found contacts are for compliant channels: mail, email with opt-out, in-person. **No cold SMS/robocalls to discovered numbers** — TCPA invariant extends here.
- People data is per-tenant, never cross-tenant pooled.
- All schedules per `tenant.timezone`. PR answers the standard question: which task IDs, and what proves it ran correctly?

Start with slice 1. Before coding, restate the plan, confirm the migration number, check whether the rep-layer voice pipeline (#277) exists to share, and list which existing files you'll touch.
