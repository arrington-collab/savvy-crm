# Claude Code Prompt — The Roof Record (full build spec)

Written 2026-07-08 from owner process extraction. Paste into a fresh session at
~/Sites/savvy-crm, or tell a session: "Read docs/superpowers/specs/prompts-roof-record.md
and execute it, slice 1 first."

---

Work in ~/Sites/savvy-crm. Build the Roof Record: Savvy's inspection system — zone-first
capture ingested live from BloomCam, honest graded findings, a permanent homeowner-facing
page, the friend-free/repair-credit machinery, and the baseline that makes "we own the
roof for life" real. One worktree per slice → TDD → PR → watch CI. Read CLAUDE.md.

## Why this must not look like anything else
86% of homeowners distrust roofers. Every competitor's "inspection report" is a bland PDF
photo dump that always concludes buy-a-roof. The Roof Record is the opposite: an honest,
permanent, zone-mapped asset the homeowner keeps. Two structural commitments enforce the
honesty: (1) an ACTION grade is impossible without a linked finding + photo, and (2)
"your roof is fine" is a designed, first-class outcome. Design must not resemble any
contractor report — reference feel: home-inspection-meets-Apple-Health. Light, warm,
generous whitespace, the roof diagram is the hero. This is homeowner-facing (estimate-
page design family), NOT the operator console aesthetic.

## Owner decisions (locked — do not relitigate)
- Zone-first capture: the inspector SELECTS the zone before shooting; the capture flow
  does the mapping. Phone GPS is 3–5m accuracy and CANNOT place photos per-facet — GPS
  is a sanity check only; never claim or imply photo-level roof positioning from GPS.
- Process order: ground walk first, then roof section-by-section.
- Report AND estimate build live during the inspection; both ready when the inspector
  climbs down (feeds present-mode step ①: roof shape → suggestions → estimate → colors
  → close).
- Grades per zone: GOOD / MONITOR / ACTION. Roof age always a RANGE, never a point.
- Repair-vs-replace is the INSPECTOR'S call on site. The app suggests, human decides.
- NO rep-recorded narration videos. AI drafts the narrative; the inspector approves
  before anything renders to the homeowner.
- Friend rule: "anything I'd do for a friend or neighbor is free" — small findings are
  fixed free on the spot and shown as such, phrase rendered verbatim on the record.
- Paid repairs create a 36-month replacement credit, auto-applied to future replacement
  estimates, with a check-in cadence (12mo, 24mo, ~33mo) if no replacement happens.
- Baseline: every completed Record baselines the property; verified storms over
  baselined addresses trigger post-storm re-inspection outreach (service framing).

## Step 0 — survey (do not skip)
1. Fresh worktree off clean, current origin/main. Dirty tree ⇒ stop and report. Read
   packages/db/drizzle/meta/_journal.json from YOUR worktree for the next migration
   number.
2. BloomCam (bloomcam-theta.vercel.app, app name "BLCK Line Cam") is a separate app:
   inspect its repo/data layer to choose the sync mechanism (webhook push preferred;
   poll fallback — same decision pattern as the Roof Tagger). Photos already reach
   Savvy via the SiteSnap ingestion pipe (#121–#124) — EXTEND that pipe; do not build a
   second photo path. If BloomCam needs a small export/webhook endpoint, spec it
   precisely and flag as a follow-up in that repo.
3. Survey in Savvy: appointment lifecycle (inspections are lead-scoped since #155),
   measurement geometry (sketch facets / Roofr parse — the zone source), photo QC +
   customer-safe flagging, estimate auto-draft trigger (draft-once on inspection
   completion + measurement), voice-memo parse pipeline, tokenized page rail
   (/status pattern), drips/quiet-hours/demo-mute, price book (repair items), the
   storm-sentinel/strike specs (baseline hook is wave-2-facing but the hook ships now).

## Data model (one migration; RLS on everything tenant-scoped)

`inspection`
- id, tenant_id, lead_id (nullable job_id for post-sale/warranty inspections),
  property_id, inspector_user_id, kind: initial · post_storm · re_inspection ·
  warranty, status: in_progress · pending_approval · approved · published,
  baseline_inspection_id (nullable — links re-inspections to their baseline),
  started_at, completed_at, approved_at, published_at.

`inspection_zone`
- id, inspection_id, zone_key (stable: facet id from measurement geometry when
  available, else named zone), zone_label ("North slope", "Ground — front elevation"),
  zone_kind: ground · facet · valley · ridge · penetrations · gutters · attic · other,
  sort_order, grade: good · monitor · action (nullable until set), grade_set_by
  (inspector user — the on-site call), checklist_version_ref.

`inspection_finding`
- id, inspection_zone_id, checklist_item_key (nullable for free-form), severity_suggested
  (from checklist mapping), what_it_is TEXT, if_ignored TEXT, timeframe TEXT (plain
  English, rubric-constrained), photo_ids[] (≥1 REQUIRED when the zone grade is ACTION —
  enforced), disposition: noted · fixed_free_today · repair_quoted · replacement_factor,
  repair_estimate_cents (nullable), created_by: inspector · ai_suggested (ai_suggested
  requires inspector confirmation before publish).

`inspection_checklist` (Library-versioned documents, per zone_kind)
- key, version, items[]: { key, prompt ("Lift 3 shingles at random — sealant bond?"),
  input: pass_fail · count · measure · photo_required · note, maps_to_finding
  (template: what_it_is / if_ignored / timeframe / severity), friend_rule_eligible bool }.
- Seed v1 from BloomCam's current checklists; owner has flagged them for improvement —
  build the Library editor so revisions are config, not code. Checklist version is
  stamped on every zone (audit trail).

`repair_credit`
- id, tenant_id, customer_id, source_inspection_id / source_invoice_ref, amount_cents,
  issued_at, expires_at (+36mo), status: active · applied · expired · opted_out,
  applied_estimate_id (nullable), checkin_log jsonb.

Property additions: baseline_inspection_id, baseline_at (set on first published Record).

## Slice 1 — Inspection entity + zone-first live ingestion

1. Create the schema above. Instantiate an inspection when the inspector starts capture
   in BloomCam (event → Savvy) or manually from the lead tile.
2. EXTEND the SiteSnap pipe: incoming media carries { inspection_id, zone_key,
   checklist_item_key?, captured_at, gps (sanity only) }. Zone comes from the capture
   flow's selected section — BloomCam's checklist UI is the source of zone truth.
3. Progressive ingestion: zones and findings appear in Savvy within seconds of capture
   (webhook preferred). The lead tile shows a live "Inspection in progress — 4/9 zones"
   card with per-zone status.
4. LIVE BUILD both artifacts: (a) draft Roof Record page assembles as zones land
   (progressive, "capturing…" placeholders fine); (b) estimate pre-draft refreshes when
   condition inputs change (reuse the existing draft-once trigger, but allow refresh
   while inspection is in_progress; final draft locks on completion per existing rules).
   Acceptance: in a timed test, record + estimate draft are ready < 2 minutes after the
   final zone uploads.
5. Ground-walk zones are first-class (front/rear/side elevations, gutters, landscape
   pre-condition). Label the ground section internally as pre-work condition
   documentation — it doubles as liability armor; ensure those photos are retained
   regardless of sale outcome.
6. Voice notes per zone go through the existing memo parse into inspector notes.

Tests: zone-tagged ingestion (media lands on the right zone), progressive assembly,
estimate refresh gating, RLS, replay/idempotency on the webhook (duplicate media event ⇒
one photo).

## Slice 2 — Findings, grades, honesty machinery

1. Checklist results auto-suggest findings (maps_to_finding templates) with
   severity_suggested; the INSPECTOR confirms/edits/overrides grades per zone on site
   (BloomCam UI or Savvy mobile view — pick the lower-friction host given the survey).
   ai_suggested findings never publish unconfirmed.
2. AI NARRATIVE: on completion, draft (a) a 2–3 sentence per-zone summary and (b) a
   whole-roof narrative — cheap-model, rubric in Library: plain English, no fear
   language, no hype adjectives, no "recommend full replacement" unless
   replacement_factor findings exist. INSPECTOR APPROVAL GATE: status pending_approval →
   approved only by the inspector (or org admin); nothing renders to the homeowner
   before approval. Edits to the narrative are the inspector's, tracked.
3. AGE AS RANGE: render effective-age machinery output as a range with source cited
   ("roof ~8–11 years — replaced 2016 per owner"). Never a point estimate.
4. ANTI-SCARE INVARIANT (bind into the sweep): roof_record.no_unsupported_action —
   zero zones graded ACTION without ≥1 finding carrying ≥1 photo. Red-path test.
5. FRIEND RULE: findings whose checklist item is friend_rule_eligible AND estimated
   under the tenant threshold (config, e.g. $150/15min) get disposition
   fixed_free_today — rendered on the Record under the verbatim phrase "anything we'd
   do for a friend or neighbor is free," with the after-photo when captured.
6. REPAIR CREDIT: paid repair invoices sourced from an inspection write a
   repair_credit (36mo). AUTO-APPLY: any replacement estimate for that customer while
   a credit is active includes it as a visible credit line. CHECK-IN CADENCE if no
   replacement: 12mo + 24mo light service touches ("your $X credit is still good —
   want a free condition check against your baseline?"), ~33mo before-it-expires note
   with re-inspection offer. Service framing, never pressure; quiet hours, throttle,
   demo-mute; touches logged in checkin_log. Evidence: repair.credit_applied (no
   replacement estimate omits an active credit) and repair.credit_checkin (no credit
   expires without the cadence having run or explicit opt-out).

Tests: suggestion→confirmation flow, approval gate (unapproved never renders),
anti-scare red path, friend-rule threshold, credit auto-apply + expiry math + cadence
scheduling in tenant TZ.

## Slice 3 — The Roof Record page (homeowner-facing)

Permanent tokenized route (the customer's asset — token does not expire; media via
short-lived signed URLs; no PII in URLs). Sections, in order:
1. HERO: their roof diagram (sketch/Roofr geometry render; aerial fallback) with zone
   pins colored by grade; address, inspection date, inspector first name, company brand.
2. ZONE EXPLORER: tap/click a zone → its grade, findings in plain English (what it is /
   if ignored / timeframe), photos AT that zone. Never a flat photo dump. Ground-walk
   zones included.
3. THE HEALTHY-ROOF RENDERING: when all zones are GOOD, the page celebrates it —
   "Healthy roof. Next check: after the next major storm, or ~<year>." First-class
   design target with its own layout, not an empty state.
4. FREE REPAIRS DONE TODAY: the friend-rule section with the verbatim phrase, items,
   and after-photos.
5. SUGGESTIONS: monitor/action items with honest timeframes; paid repair offers priced
   from the price book; replacement discussion ONLY when replacement_factor findings
   exist. Repair credit terms shown when a repair is quoted ("applied toward a
   replacement within 3 years").
6. AGE + BASELINE panel: age range with source; baseline statement — "This record
   documents your roof's condition as of <date>. If a storm ever hits, this baseline
   protects your claim." (This sentence is the moat; render it well.)
7. Footer: owner line (routes owner-priority like the estimate build), license strip,
   quiet why-us link. NO tier pricing, NO sales CTAs beyond the honest suggestions —
   the Record is not the estimate; it links to the estimate when one exists.
8. PDF export preserving the zone-mapped layout (server-rendered; email attachment).
Design brief: light/warm homeowner family (shared tokens with the estimate page);
mobile-first; diagram-as-hero; nothing that pattern-matches a contractor report.
Playwright: zone tap flow, healthy rendering, action-grade rendering, PDF parity.

## Slice 4 — Baseline + own-the-roof-for-life

1. On first published Record: set property.baseline_inspection_id/baseline_at.
2. Expose getBaselinedProperties(tenantId, polygon?) in @savvy/core — the storm
   sentinel (wave 2) will consume it; ship the interface now.
3. LIGHTWEIGHT STORM HOOK (now, not wave 2): when a verified storm event intersects
   baselined addresses (reuse the StormProof/storm-cert machinery), raise ONE exception
   card per event listing affected baselined roofs with a proposed re-inspection
   outreach (Library template: "checking your roof against its <month> baseline" —
   service framing, not sales). Owner approves the batch; NOVA sends; bookings create
   kind=post_storm inspections linked to their baseline.
4. RE-INSPECTION COMPARISON: post-storm/re-inspection Records render per-zone
   before/after against the baseline (side-by-side photos + grade delta). This view is
   also the claim-evidence artifact — exportable for carriers.
5. Evidence: baseline.coverage (every published initial Record baselines its property);
   inspection.linked_reinspection (every post_storm inspection links a baseline).

## Registry + evidence wiring
Bind into the sweep: roof_record.no_unsupported_action · roof_record.approval_gate
(zero published Records without inspector approval) · repair.credit_applied ·
repair.credit_checkin · baseline.coverage · inspection.ingest_latency (p95 capture→
visible in Savvy < 60s during business hours). Instantiate the relevant per-job/lead
ledger tasks so inspections show in the Job Ledger with evidence links. agent_run rows
for every ingestion/narrative/cadence action (activity feed compatibility).

## House rules
Per-tenant TZ everywhere; no literal secrets; demo-mute + quiet hours on all outreach;
customer-safe photo flag respected on every homeowner-facing render; AI/parsed values
never overwrite inspector-confirmed entries; checklists/templates/rubrics/thresholds are
Library config, not code constants; post-contract work — update first-20-cells STATUS
only if evidence states change.

## Verification (live, before each PR closes)
Slice 1: run a real self-inspection on a test lead via BloomCam — zone-first capture,
watch zones appear live in Savvy, record + estimate draft ready when you come down.
Slice 2: approve the narrative as the inspector; attempt to publish unapproved (must
fail); trigger the anti-scare red path. Slice 3: open the Record on a phone as the
homeowner; walk zones; export PDF. Slice 4: simulate a storm event over the test
property; confirm the batch card, the outreach template, and a linked post_storm
inspection with before/after view. State every verification in the PR.

Start with Step 0 (especially BloomCam's data layer), then slice 1. Restate the plan,
confirm the migration number, and list files you'll touch before coding.
