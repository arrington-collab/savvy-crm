# Claude Code Prompt — Production Pulse (crew-driven stages, HO photo updates, exception-only office)

Written 2026-07-08. Owner architecture: **crews document through BloomCam · AI narrates
stage progress to the homeowner WITH photos · the office hears only exceptions, lags,
and delays.** Routine production noise never reaches a human at the office — that is
the design, not a limitation.

One worktree per slice → TDD → PR → watch CI. Read CLAUDE.md. Survey first: derived-
status triggers (#108 — GPS check-in, material delivered, completion photos), homeowner
journey messages (#109/#115/#116 — evening-before, day-of, mid-day touch), SiteSnap
photo pipe + QC + customer-safe flag (#121–#124), punch lists, weather auto-reschedule
(#120), material ordering/delivery exceptions, status page, crew schema + language
preference (if the Spanish slice landed), Roof Record build if landed (this build reuses
its phase-first capture pattern — production phases are to jobs what zones are to
inspections). Check the drizzle journal from YOUR worktree.

## Data model (extend, don't duplicate)

`production_phase` (per job, instantiated at production start from a Library-versioned
phase template per job type):
- id, job_id, tenant_id, phase_key: staged_materials · tear_off · deck_repair · dry_in ·
  install · penetrations_flashing · cleanup · final_photos (template-driven; retail vs
  insurance vs repair templates differ), sort_order, status: pending · in_progress ·
  done · verified, expected_duration_hours (template default, overridable per job),
  started_at, completed_at, evidence_photo_ids[].
- Phase transitions are EVIDENCE transitions: a phase completes when its required
  evidence lands (photos with that phase's capture context; extends the #108 trigger
  pattern). Crews advance phases by capturing, not by tapping status buttons.

Crew day events: crew_checkin (GPS arrive — exists via #108; extend with crew_id),
crew_eod (end-of-day report — see slice 2), silence tracking derived, no new table.

## Slice 1 — Phase-first capture (BloomCam) + live phase engine

1. BloomCam production mode: crew selects the job (their day's schedule), sees the
   phase checklist; every photo carries { job_id, phase_key, captured_at, crew_member }.
   Extend the existing SiteSnap pipe exactly as the Roof Record build does for zones —
   ONE pipe, richer context. Spanish UI strings if crew language=es.
2. Phase engine: photos landing for a phase set it in_progress; each phase's template
   defines completion evidence (e.g. tear_off: ≥N photos including deck shots; dry_in:
   underlayment coverage shots; cleanup: ground-level + magnet-sweep shot — the
   checklist items ARE the evidence definition, Library-versioned). Completion flips
   status and stamps job progress. Photo QC runs as today; QC failures on completion
   evidence reopen the phase with a punch exception.
3. The job card + status page show live phase progress ("Install — 60%, on pace").
4. Idempotent ingestion, replay-safe; RLS; red-path: photo with unknown phase context ⇒
   held for triage card, never silently dropped.

## Slice 2 — Homeowner updates with photos (the good kind of noise)

0. DELIVERY COMMS (owner decision): material delivery gets TWO homeowner texts — 3 days
   out and the night before — and BOTH must say clearly that **delivery day is not
   build day**: "Your materials arrive Thursday — that's just the delivery; your crew
   starts <build date>. The pallet may sit on/near your driveway — let us know if we
   should place it somewhere specific." (Library template; merge build date from the
   schedule; extends the existing #116 evening-before-delivery message rather than
   duplicating it — the 3-day-out send is new.) Evidence: production.delivery_notice —
   every scheduled delivery has both sends (or logged suppression) with the
   delivery≠build language present.

1. PHASE-TRANSITION UPDATES: when a customer-visible phase completes (template flag per
   phase), NOVA sends the homeowner a short plain-language update WITH 1–3 photos —
   ONLY photos that are BOTH QC-passed AND customer-safe flagged. AI-drafted from the
   phase + checklist context (rubric in Library: warm, concrete, zero jargon, zero
   hype: "Tear-off's done — your decking is in great shape. Underlayment goes on after
   lunch."). Auto-send (no per-message approval — the QC + customer-safe double gate is
   the approval); quiet hours; throttle: max N customer updates/day (template config),
   demo-mute.
2. END-OF-DAY WRAP: one photo + tomorrow's plan ("Crew's done for today — here's where
   we left it. Tomorrow: ridge caps and cleanup."). Sourced from the crew EOD report:
   a 60-second voice memo or 3-tap form in BloomCam (what got done, any blockers,
   tomorrow's plan) — parsed via the existing memo pipeline. EOD memo is REQUIRED to
   close the crew day; missing memo by cutoff ⇒ office exception, not silence.
3. STATUS PAGE: live phase timeline + curated gallery (same double-gated photos);
   updates link to it. Multi-day jobs show the day-by-day story.
4. Language: homeowner updates in the customer's language preference if set; crew
   comms per crew preference (reuse the Spanish machinery).

## Slice 3 — Exception-only office (lags, silence, and nothing else)

The office/owner hears NOTHING about normal production. Build these detectors, all
emitting standard exception cards (batched to digests; break-glass per tenant rules):
1. PACE LAG: phase running > expected_duration × threshold (config, default 1.5×) ⇒
   "Tear-off at 6h vs 4h expected — crew notes: <latest EOD/memo context>."
2. SILENCE: crew checked in but no evidence (photos/memos) for N business hours
   (default 3) mid-job ⇒ silence card. No check-in by start window ⇒ late-crew card.
3. QC/PUNCH: completion-evidence QC failure (already exceptions — route consistently).
4. BLOCKER REPORTS: crew flags a blocker in BloomCam (material short, weather call,
   homeowner issue, hidden damage/deck rot) ⇒ immediate card; hidden-damage blockers
   auto-draft a change-order stub (reuse the 6c change-order machinery) with the photos
   attached.
5. WEATHER HOLD: existing auto-reschedule integrates — homeowner gets the reschedule
   note (existing), office only sees it as a card if it cascades (capacity conflict).
6. MUNICIPAL INSPECTION GAP (new, real): phase templates can require a city inspection
   between phases (jurisdiction-config, e.g. dry-in inspection before install in some
   CO cities). The gate blocks the next phase until inspection passed is recorded;
   scheduling/result capture is a card-driven office task for now (full automation
   later). Invariant: no gated phase starts without its passed inspection record.
7. Evidence checks bound into the sweep: production.phase_evidence (every done phase
   has its required evidence), production.ho_updates (every customer-visible phase
   completion produced a homeowner update or logged suppression reason),
   production.eod (every active crew day closed with an EOD report or raised its
   exception), production.silence_detection heartbeat (the detector itself ran).

## What this explicitly does NOT do
No crew status-button theater (evidence advances phases). No office notifications for
normal progress (the digest's daily summary line is the only routine mention). No
homeowner photos that haven't passed BOTH gates. No new photo pipe.

## House rules
Per-tenant TZ; quiet hours on all homeowner sends; demo-mute; customer-safe flag is
sacred; templates/rubrics/thresholds in Library; agent_run rows on every automated
action (activity-feed compatible); post-contract work. BloomCam changes needed get
specced precisely as follow-ups for that repo.

## Verification (live)
Run a simulated production day on a test job: phase-first captures advance phases; a
customer-visible completion sends the photo update (to YOUR phone as the homeowner);
skip evidence for 3 hours ⇒ silence card appears; file a blocker with photos ⇒ card +
change-order stub; close with an EOD memo ⇒ homeowner wrap sends. State every
verification in the PR.

Start with the survey, then slice 1. Restate the plan, confirm the migration number,
list files you'll touch.
