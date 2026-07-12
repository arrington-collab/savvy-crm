# Savvy — Prompt Run Queue · 2026-07-07

Every pending prompt, in run order, full text. Paste each into its own fresh Claude Code
session at `~/Sites/savvy-crm`. One at a time unless marked parallel-safe.

Already landed (do not re-run): lead-won fix (#163) · sketch slices 1–3 + lead-stage
drawing (#161/#162/#164/#165/#166) · leads slice 1 + 6 (#155–#159) · everything in the
first-20-cells STATUS block.

---

## 1 · STAGE GATES (run next — its re-derive script also cleans up jobs created before it)

```
Work in ~/Sites/savvy-crm. Pipeline stages must be EVIDENCE-DERIVED, not declared. One
worktree → TDD → PR. Read CLAUDE.md. Survey first: JOB_STAGE enum (packages/core/src/
enums.ts), convertLeadToJob (creates jobs at stage 'lead'), job_stage_event, the #108
derived-status triggers (GPS check-in, material delivered, completion photos), pipeline-
queries.ts, and how Josh Williamson's prod job reached stage 'inspected' with no
inspection record (trace it — the fix must close whatever path did it).

1. STAGE GATES (forward transitions require evidence, in one module):
   inspected  ⇐ completed inspection appointment OR inspection photo set
   estimate   ⇐ an estimate exists for the job/lead
   approved   ⇐ accepted estimate OR signed contract document
   production ⇐ crew scheduled or materials ordered
   invoiced   ⇐ invoice exists          (billing/complete per existing rules)
   Transitions without evidence are REJECTED at the write path (red-path tests per
   gate). Backward transitions allowed with reason. Keep the #108 triggers as the
   evidence writers — this makes stage a consequence, not an input.
2. MANUAL JOBS (escape hatch, guarded): convertLeadToJob({manualJob:true}) now requires
   either a contract document on the lead OR an explicit reason string; the job lands at
   the earliest stage its evidence supports (usually 'lead'), and its card shows the
   missing-evidence list ("no inspection · no amount · no contract") as the waiting-on
   line. Canvass signed-contract conversions satisfy the contract requirement natively.
3. RE-DERIVE EXISTING JOBS: idempotent script recomputing stage from evidence for all
   jobs (Josh drops back to where his evidence puts him). Run against prod from YOUR
   worktree, verify with a query + live board check.
4. EXCEPTION VECTOR: job.stage_evidence — any job whose stage lacks its required
   evidence goes amber in the sweep (catches future bypasses instead of trusting the
   gates alone; checker ≠ doer applies to our own write path).
5. Bind evidence check, update pipeline card "waiting on" to name the SPECIFIC missing
   artifact for the next stage (that line already exists — point it at the gate list).

Check the drizzle journal from your worktree before any migration. Verify live on prod
(Josh's card in the correct column, gates rejecting an evidence-less advance) and state
the verification in the PR.
```

## 2 · CANVASS CONTRACT → JOB (possibly already running — if so, skip; run stage gates after it regardless)

```
Work in ~/Sites/savvy-crm. Canvass signed contract → lead → contract saved → JOB,
end-to-end. One worktree → TDD → PR. Read CLAUDE.md. Survey first:
apps/web/src/app/api/canvass/contract/route.ts (intake: already creates
customer+property+lead and emits canvass/contract.signed),
packages/agents/src/functions/canvass-contract.ts (already stores signed PDF in R2 +
document row, idempotent via integrityHash), packages/db/src/lifecycle/appointments.ts
convertLeadToJob (manualJob escape hatch), and the lead-won fix (#163 — landed).

1. LEAD-SCOPE THE CONTRACT DOC: the stored document row must carry lead_id (slice 6a
   added lead scope + parse status to documents) with doc_type/kind 'contract', so it
   renders in LeadDocsCard, is click-viewable (presigned URL work), and carries onto the
   job at conversion. Keep the customer link too.
2. AUTO-CONVERT ON SIGNED CONTRACT: in the durable canvass/contract.signed workflow,
   after the document stores successfully: convertLeadToJob({ manualJob: true }) — a
   signed contract IS the authorization; no accepted estimate exists on a door sale.
   Same idempotency discipline: signing twice / event replay must not create two jobs
   (key on the existing integrityHash/dedupe). Lead → 'won'. Job carries docs, claim
   (if contract captured claim info — the schema has claim fields), photos, and the
   canvass rep as owner/salesperson for commission attribution (canvass_rep exists;
   managers sell like reps).
3. ORDERING + FAIL-SOFT: license/jurisdiction gate stays exactly as implemented (the
   scheduling block is the enforcement point — conversion itself is not blocked, jobs
   just can't SCHEDULE in ungated jurisdictions). If conversion fails, the contract
   document must still be stored and a break-glass-worthy exception card raised (a
   signed contract that silently fails to become a job is lost revenue).
4. RESCISSION GUARD: door-to-door sales carry a statutory right-to-cancel (AZ 3 days;
   CO SB38 10 days — per-tenant config, reuse the SB38/17b machinery). Job is created
   immediately, but production scheduling + material ordering are HELD until the
   rescission window passes (computed from signedAt in tenant.timezone) — surface the
   hold on the job card with the release date; auto-release, exception card only if
   the customer cancels (which reverses per the chargeback path).
5. EVIDENCE: bind canvass.contract_to_job — every stored canvass contract document has
   a linked job with lead status 'won', within 15 minutes of signing. Red-path tests:
   replayed contract event ⇒ one job; conversion failure ⇒ stored doc + exception;
   material order during rescission window ⇒ blocked.

Verify live: sign a TEST contract via the canvass app against a test lead (never a real
customer number), confirm lead → won, job exists with the contract viewable on it, and
the rescission hold shows. State the verification in the PR. Check the drizzle journal
from YOUR worktree before any migration.
```

## 3 · JOB LEDGER FIX (scope filter, evidence statuses, phase collapse) — parallel-safe

```
Work in ~/Sites/savvy-crm. Fix the per-job task ledger (job detail → Tasks tab). One
worktree → TDD → PR. Read CLAUDE.md. Survey: task_registry scope/applies_to fields,
instantiateLeadTasks / job-task instantiation, the Tasks tab renderer.

BUG (observed on prod job 019f3e4d…): the job's task list includes tenant-level
recurring tasks (SEO publishing, GBP management, website form capture, ad lead capture).
A job ledger must contain ONLY tasks applicable to that job.

1. SCOPE FILTER: instantiation includes only scope='per_job' (and per_lead carried
   through conversion) tasks, further filtered by applies_to (job type retail vs
   insurance; peril tags). Tenant-recurring tasks never instantiate per job — they
   live on the Coverage Map only. Idempotent cleanup script: remove out-of-scope task
   rows from existing jobs/leads (run against prod from YOUR worktree, verify by query).
2. EVIDENCE-DRIVEN STATUS: task rows render status from evidence (pending/blocked →
   done+evidence link → verified), not "upcoming" defaults. Checkboxes ONLY on
   manual-mode tasks (human tick = completion, logged with user+time); auto/assisted
   tasks show their status glyph + owning agent + evidence link instead of a checkbox.
3. ORDER + SECTIONS: group by lifecycle phase in execution order; blocked tasks show
   what they're blocked by (depends_on). The "waiting on" line on pipeline cards should
   point at the first unblocked incomplete task — same data.
4. Bind/extend evidence: job_task.scope_integrity — zero per-tenant-scope tasks
   instantiated on any job (red-path test with a seeded bad row).
5. PHASE LIFECYCLE ON CONVERSION: lead-phase tasks stay on the ledger as history —
   completed phases collapse to a summary row ("Lead phase · 12/12 ✓", expandable);
   the Tasks tab opens at the current phase. At lead→job conversion, any still-open
   lead-phase task must be resolved explicitly: completed, or marked not_applicable
   with a reason (logged) — never silently dropped. Red-path test: conversion with an
   open lead task and no resolution is rejected; collapsed history remains queryable
   by Sage.

Verify live on Josh's job: ledger shows only job-lifecycle tasks, statuses reflect
reality, marketing tasks gone. State verification in the PR.
```

## 4 · DOCUMENTS VIEWABLE + PARSE PANEL — parallel-safe

```
Work in ~/Sites/savvy-crm. Lead documents: make them viewable + show what parsing
extracted. One worktree → TDD → PR. Read CLAUDE.md. Builds on slice 6 (#156–#159).

1. CLICK-TO-VIEW: every document in LeadDocsCard and the lead timeline opens on click —
   short-lived presigned R2 GET URL (never a public/permanent URL, no customer PII in
   the URL). PDFs: inline viewer (new tab or embedded iframe lightbox); images:
   lightbox; other types: download. Works for docs carried onto the job too. Filename +
   uploader + date visible in the viewer header.
2. PARSE RESULT PANEL: on any parsed insurance_estimate / measurement_report, show WHAT
   was extracted next to the doc: carrier, claim #, ACV/RCV/deductible, line-item count
   (insurance) or squares/pitch/waste (measurement), parse confidence, and a link to the
   claim / measurement it populated. Un-parsed or low-confidence docs show their status
   ("stored, unparsed — card open") instead. This is the trust surface: the owner can
   click the source PDF and eyeball it against the extracted values in one view.
3. RE-PARSE ACTION: a "re-run parse" button per doc (idempotent, respects
   confirmed-field guard — parses never overwrite verified/inspection data).

Evidence: extend lead.doc_parse — every parsed doc has a resolvable view URL path (no
orphaned R2 keys). Red-path tests: expired presigned URL rejected; parse panel renders
low-confidence state; re-parse cannot clobber confirmed claim fields.
Verify live on prod as a signed-in Bloom user (open the test insurance estimate, view the
PDF, see extracted values beside it) and state the verification in the PR.
```

## 5 · LEADS SLICES 2–5 (the big one) — full spec also at docs/superpowers/specs/prompts-leads-slices-2-5.md

```
Work in ~/Sites/savvy-crm. Build slices 2–5 of the Leads overhaul. Slices 1 (#155) and 6
(#156–#159) are DONE — do not touch their behavior except where explicitly extended.
Read CLAUDE.md and docs/superpowers/specs/prompts-leads-slices-2-5.md — that file is the
full spec for this work; follow it exactly. Summary:

STEP 0: fresh worktree off clean origin/main; read drizzle journal from YOUR worktree;
survey property schema, scoring, lead tile, existing prod source values (query, don't
guess) before coding.

SLICE 2 (migration): property.roof_type_secondary (many roofs are shingle+mod-bit or
tile+foam) — RoofTypeEditor gets Primary/Secondary, scoring + estimate templates consider
both. property.last_roof_replacement_at + source (owner_reported > permit > assessor;
enrichment never overwrites owner_reported) → EFFECTIVE roof age. Append-only lead notes
(author/timestamp, no edit/delete, timeline-interleaved, quick-add on tile).

SLICE 3 (migration): structured lead.source enum + source_detail jsonb —
referral{from whom + fee $} · insurance_agent{which} · ads{platform} · realtor{which} ·
partner{which} · other{note} · keep machine sources (web, inbound_call, canvass, …);
migrate every legacy value, zero orphans. Manual leads REQUIRE a source via picker with
conditional follow-up questions. Referral fee → payable money event when the converted
job's FIRST payment collects (idempotent, once per job; approval card over threshold).
Per-person referred-revenue rollup for future partner/coffee-list use. Bind evidence:
lead.source_taxonomy (zero manual leads without source).

SLICE 4 (UX): prominent "← Back to Leads" button that preserves list state (filters +
scroll). Reorganize tile: contact/map → score → roof (types ×2, effective age,
replacement, storm cert) → Measurement → Estimate → Documents → source + notes → comms.
Playwright covers back-state and section order.

SLICE 5 (scoring): score uses EFFECTIVE age and the rationale must cite it ("roof ~9 yrs
— replaced 2017"); secondary roof type + source intent feed weights; ALL weights in one
config module. Score chip tooltip documents the scale (0–100; <40 Cold / 40–69 Warm /
70+ Hot; top factors). Monthly calibration report (bands vs booked/won/lost) activating
at ≥50 resolved leads, per-tenant cron on tenant.timezone, digest-surfaced. Bind
evidence: lead.effective_age (red-path: replacement-dated lead scored by build-year age
fails).

HOUSE RULES: TDD, PR per slice, watch CI; per-tenant TZ; no literal secrets; prod
migrations applied manually FROM YOUR WORKTREE then verified by query; parsed/enriched
values never overwrite owner-confirmed data; post-contract work — update first-20-cells
STATUS only if evidence states change.

DEPLOY + PROVE: after each slice — migration applied to prod (state the number),
invariant bound, live verification as a signed-in Bloom user described in the PR.

Start with Step 0, then slice 2.
```

## 6 · ACTIVITY FEED ("watch the work happen") — before #7

```
Work in ~/Sites/savvy-crm. Build the Activity feed ("watch the work happen") — one live,
tenant-wide stream of agent + human actions, every row naming its customer/job. One
worktree → TDD → PR. Read CLAUDE.md. Survey first: agent_run schema (lead_id linkage
from #80; check job linkage — if runs aren't reliably attributable to a job/customer,
fix the writers first, that's the real work), the old command-center feed component,
Today's "While you were out" panel, the per-job Timeline tab.

1. ROUTE + PLACEMENT: /activity, read-only. NOT a sixth nav item — reachable from (a)
   the "While you were out" panel header ("view live feed →") and (b) the Agents page.
   Nav stays at 5.
2. THE FEED: reverse-chron stream of agent_run + human actions (exception resolutions,
   manual task ticks, uploads). Each row: time (tenant TZ), actor chip (agent avatar or
   user), action in plain words ("drafted estimate", "sent reminder", "parsed insurance
   estimate", not lead.qualify), CUSTOMER/JOB NAME as a link to the card, outcome badge
   (ok/skipped/error), and an evidence link. Rows without an attributable customer show
   the tenant-level context ("nightly enrichment sweep · 12 properties").
3. LIVE: poll or SSE every ~15s with a subtle "live" indicator; no page reload. Filters:
   by agent, by job/customer (deep-linkable ?job= — the job Timeline tab and this feed
   share one query/component, one source of truth), by outcome (errors only), by day.
4. ATTRIBUTION BACKFILL: wherever agent functions write runs without lead/job linkage
   and one is derivable, fix the writer (this feed is only as good as attribution;
   "Unknown" rows are the old lead-list disease). Evidence check: activity.attribution
   — % of runs with customer/job linkage ≥ threshold; unattributable categories
   explicitly allowlisted (sweeps, digests).
5. Perf: paginated, indexed query, no N+1 on names; Playwright: feed renders, filter by
   job shows only that job's rows, error filter works.

Verify live on prod: feed shows real Bloom activity with names, filtered view from a job
card works. State verification in the PR.
```

## 7 · SHOWCASE / MOTION (requires #6's event channel)

```
Work in ~/Sites/savvy-crm. "Show the machine working" — evidence-backed motion, zero
theater. Rule: every indicator binds to real agent_run/verification data; nothing
animates that didn't happen. One worktree per slice → TDD → PR. Read CLAUDE.md. Requires
the /activity feed (build it first if not landed — its SSE/poll channel powers this).

S1 WORKING-NOW: in-flight agent runs surface on their job/lead cards (agent avatar +
   typing dots + plain-words verb), resolving to done+evidence on completion. Powered by
   run start/finish events; falls back gracefully (no stuck spinners — timeout ⇒ show
   last completed state). Playwright with a seeded slow run.
S2 ODOMETER: Today header count-up — actions today + human-minutes replaced (honest
   per-action-type equivalents in ONE config; cite methodology in a tooltip). No
   invented numbers; zero state reads "quiet night".
S3 HEARTBEAT: last-touch chip on every card (actor + relative time, tenant TZ); cold
   badge past N days (config) — doubles as a stuck signal, links to card's activity.
S4 SHIFT REPORT: digest becomes first-person narrative (cheap-model call over the run
   aggregate; template fallback if the call fails). Same delivery times/break-glass
   rules; plain facts, no hype adjectives.
S5 POLISH: enrichment field fill-in on live lead view; coverage-cell green-earn glow +
   toast; Sage orb pulse ∝ real runs/hour (idle = slow breath, never fake).
S6 REPLAY: /activity?replay=<date> — day compressed to ~90s, names visible, pause/
   speed. Read-only, shareable internally (auth still required).
Respect prefers-reduced-motion throughout. Verify live on Bloom and state what was seen.
```

## 8 · WOW FEATURES (Sage-by-text · ballpark · Spanish) — full spec at docs/superpowers/specs/prompts-wow-features.md; parallel-safe

```
Work in ~/Sites/savvy-crm. Read docs/superpowers/specs/prompts-wow-features.md — it is
the complete spec; execute it exactly: slice 1 Sage by text & voice (actionable digest,
verified-number security model, confirm round-trips for money, free-text → cited Sage
answers, voice queue readout), slice 2 the 30-second ballpark (pure function, confidence
floor, range-only with subject-to-inspection framing, NEVER on insurance-claim intents,
calibration report), slice 3 Spanish-first crew comms (language preference + ESPAÑOL
self-serve flip, template pairs in Library + gateway translation for dynamic fragments,
inbound Spanish memos through the existing pipeline). Supplementing is OUT of scope for
this version — do not build any of it. One worktree per slice → TDD → PR. Start with the
survey, then slice 1. Verify each slice live per the spec's verification requirements.
```

## 9 · DEMO TENANT SEEDER (LAST — requires stage gates so it seeds through them)

```
Work in ~/Sites/savvy-crm. Build the DEMO TENANT + full-pipeline seeder — one realistic
job at every stage so the owner can walk the board end-to-end and audit each stage. One
worktree → TDD → PR. Read CLAUDE.md. Survey first: provisionTenant runbook (#145/#153),
lifecycle functions (intake/createLeadForTenant, appointments + convertLeadToJob,
estimate accept, invoice/payment, job_stage_event, instantiate*Tasks), comms sending
paths, and the stage-gate/evidence work (seed THROUGH the gates, never around them).

## Non-negotiable guardrails
1. NEW TENANT "Demo Roofing (Savvy)" via the real provisioning runbook — never seed into
   Bloom or any real tenant. Tenant flag demo=true.
2. COMMS HARD-MUTED for demo tenants: every outbound SMS/email/voice path checks the
   flag and writes a mock-delivery record instead of sending. Tenant-level kill switch
   with an invariant: comms.demo_mute — zero real provider calls for demo=true tenants
   (red-path test). Build this FIRST; nothing seeds until it exists.
3. Seeder is idempotent (re-run = same state, no dupes) with --reset teardown. All data
   through lifecycle functions so stage events, job_task ledgers, agent_run rows, and
   evidence links are REAL.

## The dataset (obvious demo names, Phoenix-area addresses, tenant TZ America/Phoenix)
Leads: 1 new (web, unenriched) · 1 contacted (drip active) · 1 qualified (scored) ·
1 booked (inspection Thu, reminder scheduled) · 1 lost (with reason).
Jobs, one per stage, each with the evidence its stage requires:
- INSPECTED: completed inspection appt + measurement (one via DIY sketch so the report
  renders) + roof type confirmed.
- ESTIMATE: auto-drafted good/better/best from the price book, sent, awaiting customer.
- APPROVED: accepted estimate → job via the real conversion (lead → won), deposit
  invoice out, materials pending → landed-cost comparison attached if that work exists.
- PRODUCTION: crew scheduled, materials delivered event, mid-job photos, one OPEN punch
  item, homeowner status page live.
- INVOICED: completed job, final invoice, partial payment, one 50-day-old receivable
  (collections ladder visibly mid-sequence).
- COMPLETE/PAID: fully paid, warranty registered, review-request event logged.
Flavor cases:
- 1 INSURANCE job: parsed insurance-estimate fixture PDF through the real parse
  pipeline, claim ledger populated (ACV/RCV/deductible), depreciation invoice pending —
  NO supplement content (out of scope this version).
- 1 CANVASS job: signed-contract intake fixture → contract doc on the job (+ rescission
  hold if landed).
- 1 STUCK job: estimate sent 12d ago, no response → stuck exception visible in Today.
- 1 manual-hatch job WITH reason + contract doc.
Demo users: 1 office admin, 2 reps (one owns the stuck job), 1 crew contact
(language=es if the Spanish slice landed).

## Output
- pnpm script: seed-demo-tenant (create/refresh) + --reset. Runnable against prod per
  the documented process (creds from .env.prod.secrets.local, run from YOUR worktree).
- After seeding: run the health sweep for the demo tenant once so Today, Coverage, and
  the activity feed populate.
- PR lists what was created per stage + the org name to switch to.

Playwright: demo tenant renders a card in every pipeline column; demo-mute red-path
(attempt a send, assert mock record, zero provider calls).
Verify live: switch to the demo org on prod, walk LEAD → PAID, every column occupied,
every card's ledger/timeline/docs populated. State verification in the PR.
```

---

**Order logic:** 1→2 is the only hard chain (gates before/around canvass jobs — if canvass
is already running, fine: gate re-derivation cleans up after). 3, 4, 5, 8 are
parallel-safe any time. 6 must precede 7. 9 runs last so it seeds through the gates.
After the queue: re-run the full smoke test, then Alta launch (checklist + provisioning),
then decide on "The Next 20."
