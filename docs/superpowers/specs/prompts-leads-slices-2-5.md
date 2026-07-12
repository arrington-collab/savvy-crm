# Claude Code Prompt — Leads Overhaul Slices 2–5 (data model, source taxonomy, UX, scoring)

Written 2026-07-07 against repo state at #160. Slices 1 (lead-stage estimates, #155) and 6
(lead documents + parse, #156–#159) are DONE — do not touch their behavior except where
explicitly extended below. One worktree per slice → TDD → PR → watch CI. Read CLAUDE.md
and the non-negotiables first.

---

Work in ~/Sites/savvy-crm. Build slices 2–5 of the Leads overhaul.

## Step 0 — state check
1. Fresh worktree off clean, current origin/main. Dirty tree ⇒ stop and report.
2. Read packages/db/drizzle/meta/_journal.json from YOUR worktree for the next migration
   number (0067 was estimate.measurement_source; main moves fast — never assume).
3. Survey before coding: property schema + ROOF_TYPE_VALUES enum, lead scoring +
   rationale generation (ATLAS), the lead tile (LeadArtifactsSections + LeadDocsCard),
   leads list page state, existing lead.source values in prod data (query, don't guess),
   money-events path (used by depreciation/chargebacks), partner/coffee-list data shape
   if any (#242 not built — design the attribution to be consumable later).

## Slice 2 — property data model (one migration)

1. DUAL ROOF TYPES: `property.roof_type_secondary` (same enum, nullable). Reality: many
   roofs are shingle+mod-bit or tile+foam on different facets. Extend the existing
   RoofTypeEditor to "Primary / Secondary (optional)". Consumers must consider BOTH:
   scoring, estimate template selection, any material/golden-list tagging. The #82
   computed exception `roof_type_needed` keys on primary only (unchanged).
2. LAST KNOWN ROOF REPLACEMENT: `property.last_roof_replacement_at` (date, nullable) +
   `last_roof_replacement_source` (owner_reported · permit · assessor). EFFECTIVE ROOF
   AGE = years since replacement when present, else years since year_built. Precedence:
   owner_reported > permit > assessor; enrichment NEVER overwrites owner_reported.
   Editable inline on the lead tile roof section.
3. LEAD NOTES: append-only notes on the lead — author, timestamp, body; rendered in the
   lead timeline interleaved with comms + document events (slice 6a's timeline pattern).
   No edit/delete of others' notes; supersede by writing a new note. Quick-add input on
   the lead tile ("dog in backyard", "south facet soft decking").

Red-path tests: enrichment attempting to overwrite owner_reported replacement is
rejected; secondary roof type flows into estimate template selection.

## Slice 3 — lead source taxonomy + referral fees (one migration)

Replace free-text/loose source with structured `lead.source` (enum) +
`lead.source_detail` (jsonb):
  referral        → { referrer_name, referrer_contact?, referral_fee_cents? }
  insurance_agent → { agency, agent_name? }
  ads             → { platform: google_lsa | google_ads | meta | nextdoor | other }
  realtor         → { name, brokerage? }
  partner         → { name }   (other referral partner)
  other           → { note }
  (keep existing machine sources as first-class enum members: web, inbound_call,
   canvass, direct_mail, … — query prod for the actual set and migrate every existing
   value; zero orphans.)

Rules:
- Manual lead creation REQUIRES a source (picker with conditional follow-up fields —
  the picker asks the secondary question per source, per owner spec).
- REFERRAL FEE: when a lead with referral_fee_cents converts and its job's FIRST payment
  collects, emit a payable money event (reuses the money-events path; approval card if
  fee > tenant threshold; idempotent — once per job).
- ATTRIBUTION: referrer/agent/realtor/partner names roll up to per-person referred-
  revenue (a queryable view/summary is enough — the quarterly coffee list #242 consumes
  it later). CAC/source reporting reads the new enum.
- Evidence: bind `lead.source_taxonomy` — zero manually-created leads with missing/
  unknown source (machine sources exempt).

Red-path tests: migration maps every legacy source value; fee event exactly once; over-
threshold fee ⇒ card not auto-pay.

## Slice 4 — lead tile UX

1. "← Back to Leads" — prominent button at the top of the lead tile (breadcrumb is too
   subtle for field use). MUST preserve leads-list state on return (filters + scroll;
   URL params or session storage).
2. Reorganize the tile to working order: contact/address+map → score (with effective-age
   rationale) → roof (types ×2, effective age + replacement date, storm cert) →
   Measurement (slice 6b card, now with edit affordances) → Estimate → Documents (6a) →
   source + notes → comms timeline. Read-mostly; edits via existing inline editors.
   Playwright: back-button state preservation, tile section order.

## Slice 5 — scoring transparency + calibration

1. EFFECTIVE AGE IN SCORING: the score MUST use effective roof age (slice 2) and the
   rationale MUST cite it ("roof ~9 yrs — replaced 2017", never "~28 yrs from build
   year" when a replacement is known). Secondary roof type contributes (e.g. tile+foam
   in AZ scores like its service-driving component). Source intent from slice 3 feeds
   weights (referral > insurance_agent/realtor > web > ads baseline). ALL weights live
   in ONE config module — not scattered constants.
2. SCALE TOOLTIP: score chip documents the scale in-app — 0–100; bands <40 Cold /
   40–69 Warm / 70+ Hot; top contributing factors listed.
3. CALIBRATION HOOK (no ML): monthly report artifact comparing score bands vs actual
   outcomes (booked / won / lost) once ≥50 resolved leads exist; below that it reports
   "insufficient data — n=X". Registered as a per-tenant cron on tenant.timezone,
   surfaced in the digest when it flips to active.
4. Evidence: bind `lead.effective_age` — every scored lead whose property has a
   replacement date cites effective age in its rationale.

Red-path test: lead with replacement date scored via build-year age ⇒ invariant fails.

## House rules (unchanged)
TDD; PR per slice; watch CI. Per-tenant timezone everywhere. No literal secrets. Prod
migrations run manually from YOUR worktree, then verify with a query (stale-checkout
gotcha). Parsed/enriched values never overwrite owner-confirmed data. Update the
first-20-cells.md STATUS only if evidence states change — this is post-contract work;
log it as such in the PR descriptions.

## Deploy + prove it
After each slice merges: apply its migration to prod from the worktree, verify the
column/data with a direct query, and confirm the UI change live as a signed-in Bloom
user. The final PR description lists: migrations applied (numbers), invariants bound,
and the live-verification output.

Start with Step 0's survey, then slice 2. Restate the plan, confirm the migration
number, and list files you'll touch before coding.
