# Claude Code Prompt — Phase 26: Margin & Market (blitz, returns, price intel, fill loop, office role)

Written 2026-07-11. Executes tasks #342–#354 from `expansion-phases.md` Phase 26 (that
table is the spec of record; this prompt is the build order). Owner decisions locked:
3-wave postcard blitz to closest 25–50 homes (~$129/job, graded against a
1-roof-per-7-jobs target) · delivery targeted as arrive-windows, never promised exact
days (USPS reality) · canvass territory auto-created day-before/day-of · Facebook
boosts are MANUAL-TRIGGER cards with auto-generated creative (no ad-API build —
payout-gated out) · Spanish homeowner experience explicitly deferred.

Dependencies: 26a triggers off production scheduling (Production Pulse build
preferred but not required — the scheduling event exists today); 26b's crew leftover
photo rides the Production Pulse EOD flow (if Pulse hasn't landed, build 347 against
completion photos + a manual leftover entry card, and note the upgrade path); 26c/26d
have no dependencies. PostGrid build (prompts-postgrid.md) must be landed or built
first for postcard sends — if it is still on hold, build 26a complete-but-dormant
behind the print seam (blitz schedules pieces into "print pending", exactly like the
Customer for Life holiday cards).

One worktree per slice → TDD → PR → watch CI. Read CLAUDE.md. Survey first: production
scheduling events, geocoded property data (audience radius), suppression/do-not-mail
lists, PostGrid seam state, canvass app territory API (knock/territory sync exists —
extend, don't duplicate), photo/media consent flags, supplier cost sheets + price-guard
credit machinery (#136), capacity look-ahead (#118), drip/offer rails + touch governor,
lost-reason flow (leads overhaul), exception card ownership model. Check
packages/db/drizzle/meta/_journal.json from YOUR worktree.

## Slice 1 — Mobilization Blitz (#342, #343, #346)
1. Trigger: production scheduled ⇒ blitz plan: closest N homes (tenant config 25–50)
   by geocode distance, deduped against existing customers, active leads, suppression
   and do-not-mail lists.
2. Three PostGrid waves with arrive-WINDOW targeting: mail-by dates computed for
   (a) arrive before build start, (b) arrive during build, (c) arrive 2–4 days after.
   Copy templates in Library ("your neighbor on <STREET> is getting a new roof — crew's
   there this week, mobilization pricing while equipment's on-site"; street name only,
   NEVER a house number).
3. Spend: pieces × cost book as job-attributed marketing spend; auto-approve under the
   per-job blitz cap (config, default $150); over-cap ⇒ card. Audience > config max ⇒
   card, never silent send.
4. Attribution: `mobilization` lead source tag (taxonomy addition), blitz_id on
   resulting leads; weekly digest line: blitzes run, spend, leads, rolling
   roofs-per-jobs ratio vs the 1-in-7 target; quarterly report artifact.
Red-path tests: suppressed address never mailed; over-cap card; dedupe against the
customer being roofed (do not mail the job's own address).

## Slice 2 — Canvass + Facebook tie-ins (#344, #345)
1. Canvass: blitz creation auto-pushes a territory + route around the job to the
   canvass app (extend the existing territory sync), active day-before through
   build-end, with job context on the route ("roofing #14 through Friday"). Knocks/
   sales from it attribute to the blitz.
2. Facebook: day-before and day-of BOOST CARDS — auto-generated creative (street-level
   copy + job photo ONLY when the customer's marketing-consent flag is set; house
   numbers never appear) + one-tap link to post/boost manually. Card records
   boosted/skipped. NO Meta API automation.
3. Consent invariant: zero creatives referencing an unconsented customer's job
   (red-path test with an unconsented fixture).

## Slice 3 — Material reconciliation + returns (#347, #348)
1. Reconciliation: ordered (PO) vs invoiced (parse #135) vs used — leftover count from
   the crew EOD leftover-stock photo (parse; manual entry card fallback). Variance
   beyond threshold (config, default 10%) flags the job and feeds the waste-factor
   review.
2. Returns: returnable leftovers (cost-sheet flags returnable SKUs + restocking terms)
   ⇒ return/pickup task, credit expected, chased to resolution via the price-guard
   credit machinery; recovered $ in the digest. Invariant: no return unresolved > 14d.
Red-path: non-returnable SKU never generates a return; unresolved return escalates.

## Slice 4 — Win/loss price intel (#349, #350)
1. Lost flow gains OPTIONAL fields when reason = price: competitor bid ~$, competitor
   name (typeahead, create-once — same hygiene as partners). 10-second entry, never
   required, never blocks closing the lead.
2. Quarterly market-pricing artifact once n≥10 captures: our bid vs captured bids by
   area/product/tier, delivered beside the price-drift review. Capture-rate % tracked
   as a target, not a gate.

## Slice 5 — Slow-week fill loop (#351, #352)
1. Detector: capacity look-ahead emits crew-gap signal when a hole opens inside N days
   (config, default 10). Every gap ⇒ fill plan or logged pass (invariant).
2. Fill plays, through existing rails + touch governor: aging unaccepted estimates get
   a this-week incentive (config discount; MARGIN FLOOR STILL RESPECTED — the floor
   check runs on discounted totals; over-threshold discounts ⇒ card); open repair
   backlog offered scheduling; maintenance visits pulled forward. Conversion per play
   + idle crew-days recovered tracked in the digest.

## Slice 6 — Office role (#353, #354)
1. AUDIT FIRST (its own PR, no code): document current access reality for
   admin/office/rep/crew across routes, actions, and data; propose the office-role
   permission matrix; owner approves via card/PR review before implementation.
2. Implement: office-role tier + scoped Today (their cards: scheduling, document
   chasing, collections calls, endorsement wet-signatures; owner-only cards — money
   approvals over threshold, break-glass, M&A — excluded). Exception cards gain an
   owner_role field. Invariant: owner-tier cards never render for office role
   (red-path test).

## House rules
Per-tenant TZ; demo-mute + suppression lists on every send; spend caps + margin floors
enforced in the write path; thresholds/templates/caps in Library; street names never
house numbers in any marketing copy; post-contract work — log as such in PRs. Verify
each slice live per its red-paths (seed a scheduled build ⇒ blitz plan renders with
correct audience + windows; seed a crew gap ⇒ fill plan; office login sees scoped
Today) and state verifications in the PRs.

Start with the survey, then slice 1. Restate the plan, confirm the migration number,
list files you'll touch.
