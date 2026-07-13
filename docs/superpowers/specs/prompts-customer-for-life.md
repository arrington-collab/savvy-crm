# Claude Code Prompt — Customer for Life (post-roof relationship program)

Written 2026-07-08. Owner thesis: a past customer should never feel like a transaction —
so that the post-storm inspection call feels natural, and so they call us from their
NEXT house. Budget reality: postcards ≈ $0.86; the whole decade costs less than a lunch
per customer. The machine's job is remembering to send postcard #7 in year four.

One worktree per slice → TDD → PR → watch CI. Read CLAUDE.md. Survey first: retail
close-out cadence (#110), review/referral drips, repair-credit check-ins (Roof Record
build), baseline storm checks (Roof Record slice 4), maintenance program spec (Phase 20
#305–#310, deferred — design compatible, don't build it), PostGrid prompt
(prompts-postgrid.md, on hold — print pieces depend on it; TEXT touches ship now on
existing comms rails), customer/property schema, tenant TZ + quiet hours + demo-mute.

## Slice 1 — The relationship calendar + touch governor (build first; everything routes through it)

1. `relationship_touch` (tenant, customer, program: holiday_card · roofiversary ·
   storm_check · credit_checkin · maintenance_offer · referral · move_play · custom,
   channel: text · postcard · letter · email, scheduled_for, sent_at, suppressed_reason,
   template_version).
2. GOVERNOR: all post-completion programs (this build + existing credit check-ins,
   baseline storm outreach, review/referral, future maintenance) schedule THROUGH this
   calendar. Hard cap per customer (tenant config, default 5 touches/yr outside active
   jobs/claims); PRIORITY on conflict: storm_check > credit_checkin > move_play >
   roofiversary > holiday_card > maintenance_offer. Displaced touches reschedule or
   drop with a logged reason. Refit the existing credit-checkin + baseline-outreach
   senders to route through the governor (do not leave parallel paths).
3. Opt-out is global per channel and instantly honored across programs.
4. Evidence: relationship.governor — zero customers exceeding the cap in any rolling
   year; zero touches sent outside the calendar (red-path test with a rogue-send
   fixture).

## Slice 2 — The standing cadence (warm, sparse, useful)

Enrollment: every completed job auto-enrolls the customer (demo tenants excluded).
Default program (all templates Library-versioned, owner-editable):
1. 30-day check-in text (reuse/absorb the existing close-out cadence step): "roof
   settling in fine? Anything we'd fix for a friend, we fix free."
2. ROOFIVERSARY (year 1, then every year): short text or card — "your roof turns 3
   today. Still watching the weather over it." Includes nothing salesy.
3. HOLIDAY POSTCARD (one/year, tenant-config which holiday; default Thanksgiving —
   gratitude framing, less December noise). PostGrid piece; until the PostGrid build
   lands, the calendar schedules them and holds in a "print pending" state — the
   program launches with texts day one, print unlocks later without rework.
4. STORM CHECKS + CREDIT CHECK-INS: already specced elsewhere; they route through the
   governor (slice 1) and count against the cap.
5. Content rule (rubric): every touch is either gratitude, useful info, or a free
   offer. Never a discount blast, never "just checking in."
Evidence: relationship.enrollment — every completed retail/insurance job enrolls or
logs why not; relationship.cadence — no enrolled customer goes >18mo with zero touches.

## Slice 3 — The move double-play

1. MOVE DETECTION: PostGrid address verification/NCOA + returned-mail signals (and a
   manual "customer moved" action) set customer.moved_at + new_address when confirmed.
   Behind a seam (dormant until PostGrid creds active); confidence threshold — never
   act on a single soft signal; below threshold ⇒ verification card.
2. PLAY A — the customer at the new address: warm text/letter ("Congrats on the new
   place — want us to give its roof the same eyes? Your Roof Record history rides with
   you."). Creates a lead (source: existing customer, new property) on response.
3. PLAY B — the new owner of the old address: letter introducing the transferable
   workmanship warranty + the home's Roof Record ("this roof was installed by us in
   <year>; its full documentation exists; register the warranty transfer here").
   Tokenized transfer page: new owner registers → becomes a customer, inherits the
   property's Roof Record + warranty (transfer terms per tenant config; fee optional).
4. WARRANTY TRANSFER machinery: transfer event links new customer to property history;
   old customer's record preserved; both enrolled in the cadence (governor applies).
5. Evidence: relationship.move_play — every confirmed move produced both plays (or
   logged suppression); warranty transfers always link the Roof Record.

## Economics + measurement
Per-customer program cost tracked (pieces × cost + text costs) and shown against
program-attributed revenue (storm jobs from baselined customers, referral jobs, move-
play leads, transfers) in a quarterly report artifact. Target visibility, not vanity:
the owner should be able to see "$1.40/customer/yr → $X pipeline" or kill the program.

## House rules
Tenant TZ + quiet hours + demo-mute on everything; PostGrid pieces respect the existing
spend-approval card rules when that build lands; no touches during an active claim
dispute (suppression flag); templates/rubrics/caps in Library; post-contract work.
Verify live: enroll a test customer, fast-forward fixtures through the cadence, trigger
a simulated move (both plays fire, transfer page works), prove the governor blocks a
6th touch. State verifications in the PR.

Start with the survey, then slice 1 (the governor is the foundation — nothing sends
without it). Restate the plan, confirm the migration number, list files you'll touch.
