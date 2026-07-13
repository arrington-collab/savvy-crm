# Expansion Phases 16–22 — Master Task List Extension

**Tasks #272–#323** · registry format (owner, mode, evidence binding). Seed alongside the 212 + Phase 0.
Decisions recorded 2026-07-01: labor supply deferred; M&A machine deferred but gets a **blurred placeholder in the CRM** (see end); everything below is approved for development.

Modes: FA = full_auto · AS = assisted (exception card) · M = manual/gray

---

## Phase 16 — Sales Rep Layer (the kitchen-table seam)

AI runs everything up to and after the in-person moment; this phase designs the handoff. Principle: **reps sell, never type** — voice-first capture, zero data entry.

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 272 | Always-on rep recruiting pipeline: postings, AI screening call, interview auto-booked with owner/manager | ATLAS | FA | invariant: open rep seat ⇒ active pipeline with ≥ N screened candidates |
| 273 | Rep onboarding playbook in Library: comp plan, app walkthrough, shadow schedule, 30-day ramp checklist instantiated per hire | SAGE | FA | job_task-style checklist per hire; completion tracked |
| 274 | Pre-appointment packet: lead score + rationale, StormProof cert, roof data, neighborhood comps (Turf!), financing options — delivered to rep 2h before | SCOUT | FA | invariant: every appointment has packet ≥ 2h prior |
| 275 | AI-set appointments synced to rep calendars; confirmation + reminder to homeowner; no-show rescue sequence | MILO | FA | invariant: every appointment confirmed; no-shows re-engaged < 24h |
| 276 | Adjuster-meeting coordination: date capture from carrier comms, rep assignment, homeowner notice, packet variant | MILO | FA | invariant: every claim with scheduled adjuster meeting has assigned rep + packet |
| 277 | Post-appointment voice memo → AI parses outcome, objections, next steps, quoted price into CRM; missing memo chases the rep | NOVA | FA | invariant: every completed appointment has parsed outcome < 12h or open chase |
| 278 | Rep scorecard: close rate by lead grade, appointment speed, memo compliance, slippage — feeds the assignment engine | VERA | FA | monthly artifact; assignment weights read from it |
| 279 | Rep exception vectors: unworked assigned leads, stale follow-ups, expiring estimates → cards to rep first, owner on SLA breach | SAGE | FA | computed vectors; escalation SLA honored |
| 280 | Territory/lead-mix fairness rules (self-gen vs company-lead splits defined in Library, enforced by assignment) | SAGE | FA | invariant: assignments match configured rules |

## Phase 17 — Insurance Money Mechanics

The cash is won after the scope: endorsements, depreciation, deductibles. All three are chase sequences — ideal background ops.

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 281 | Claim money ledger per job: ACV / RCV / deductible / supplements / recoverable depreciation as first-class money events | VERA | FA | invariant: every insurance job has complete ledger; totals reconcile to carrier docs |
| 282 | Mortgage endorsement chase: detect lender co-payee → generate lender-specific endorsement package → automated follow-up sequence (mail/fax/portal/call) → card only when wet signature or homeowner action needed | VERA | FA | invariant: no endorsement item idle > 5 business days without a next action logged |
| 283 | Recoverable depreciation recovery: **invariant — every completed RCV job has COC + final invoice submitted to carrier within 10 days of completion**; automated generation + submission + payment watch | VERA | FA | the invariant is the task; unpaid depreciation > 30d escalates |
| 284 | Deductible collection, CO SB38-compliant: no-waiver language enforced in templates, documented collection, payment plans via existing rails | VERA | FA | invariant: every insurance job shows deductible invoiced + collection evidence |
| 285 | Supplement cycle SLAs: carrier response clocks, escalation ladder (resend → supervisor → DOI complaint draft as AS card) | SCOUT | FA/AS | invariant: no supplement idle past carrier-specific SLA without escalation step |
| 286 | Insurance cash forecast: expected ACV/depreciation/supplement inflows by week into Money view + digest | VERA | FA | reconciled: forecast vs actuals variance tracked |
| 287 | Carrier scorecards: cycle time, supplement approval rate, endorsement friction by carrier — feeds targeting and pricing | SCOUT | FA | quarterly artifact |
| 288 | Statute watch: CO/AZ roofing-insurance law changes → Library policy update proposals | SCOUT | AS | executed monthly; proposals are cards |

## Phase 18 — Compliance Registry (Colorado-critical)

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 289 | License matrix: per-jurisdiction contractor licenses (Denver-metro per-city registrations; AZ ROC) with renewal clocks. **Invariant: no job scheduled in a jurisdiction without an active license** — scheduling is structurally blocked | SAGE | FA | the blocking invariant + renewal SLA (60d warning card) |
| 290 | GL/WC insurance renewals; automated COI issuance to cities/GCs on request | VERA | FA | invariant: zero coverage-lapse days; COI requests fulfilled < 24h |
| 291 | A2P 10DLC registration per tenant + ongoing SMS deliverability/spam-score monitoring | NOVA | FA | invariant: no unregistered traffic; delivery rate ≥ threshold (this may be degrading Bloom's sends today) |
| 292 | Call-recording consent + AI-voice disclosure config per state, enforced in telephony flows | NOVA | FA | invariant: every recorded/AI call carries required disclosure per tenant state |
| 293 | SB38 contract pack: right-to-rescind, deductible provisions, 10-day language in every CO contract — template-version invariant | SAGE | FA | invariant: every signed CO contract used a compliant template version |
| 294 | Permit tracking: **invariant — no production start without required permit on file** per jurisdiction rules | MILO | FA | blocking invariant + permit status watch |
| 295 | Safety documentation: toolbox talks scheduled/logged, equipment inspection logs, incident intake flow | MILO | FA | executed weekly; logs complete per active crew |
| 296 | Entity hygiene: bonds, registered agent, annual reports per tenant with renewal clocks | VERA | FA | renewal invariants; 60d warning cards |

## Phase 19 — Production QC & Warranty Loop

**Boundary (owner decision 2026-07-03): the photo software (SiteSnap) does the AI vision analysis — Savvy does NOT run its own photo models.** Savvy ingests QC verdicts/flags from the photo tool and enforces the workflow consequences (punch lists, invoice blocking, scorecards). Checker ≠ doer still holds: Savvy's invariants verify the *workflow* (every job audited, no invoice with open items), the photo tool owns the *judgment*.

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 297 | Photo-QC ingestion: pull audit verdicts/flags per job from the photo software (SiteSnap) behind a `PhotoQC` seam; failures → punch-list exceptions in Savvy | SCOUT | FA | invariant: every production job has an ingested QC verdict before invoice; ingestion lag < 4h |
| 298 | Punch-list workflow: crew notified with photos, re-photo required, closure verified via re-ingested verdict | MILO | FA | invariant: no invoice sent with open punch items |
| 299 | Final walkthrough: digital sign-off + auto-generated COC (feeds #283 depreciation submission) | MILO | FA | invariant: every completed job has signed walkthrough + COC |
| 300 | Manufacturer warranty registration within 10 days of completion (GAF/OC portals) | VERA | FA | invariant: 100% registration; certificate stored on job |
| 301 | Certification-tier maintenance (e.g. GAF requirements): install counts, training credits, standing tracked per tenant | SAGE | FA | renewal/requirement clocks; shortfall cards |
| 302 | Callback tracking: warranty calls tagged root-cause → crew/sub scorecard + spec-checklist updates | SCOUT | FA | invariant: every callback linked to job + cause; scorecards refresh monthly |
| 303 | Warranty claim flow: intake → triage (ours vs manufacturer) → schedule → cost tracked vs sub backcharge | MILO | FA | invariant: warranty intake acknowledged < 4h, scheduled < 72h |
| 304 | Safety spot-check ingestion: harness/edge-protection flags from the photo software's sampling; violations → crew card in Savvy | SCOUT | FA | weekly ingestion; violation rate tracked |

## Phase 20 — Maintenance & Recurring Revenue

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 305 | Maintenance program product: annual tune-up subscription (price book item, Stripe recurring) | VERA | FA | reconciled: subscriptions ↔ Stripe; MRR in Money view |
| 306 | Auto-enrollment offers: post-job drip + valley-cleaning funnel graduates + inspection-no-sale leads | NOVA | FA | executed; conversion tracked per source |
| 307 | Annual visit scheduling: route-batched by neighborhood (Turf synergies), crew light-duty windows | MILO | FA | invariant: every active member visited within 12mo |
| 308 | Visit report to homeowner: photos, condition score, small-repair quotes — the renewal driver | SCOUT | FA | invariant: every visit produces report < 48h |
| 309 | Members = top Strike List tier: first contact post-storm, pre-authorized inspection | ATLAS | FA | invariant: member ∩ swath contacted < 24h |
| 310 | Churn watch: renewal drips, lapsed-member winback, cancel reasons tagged | NOVA | FA | renewal rate in digest; every cancel has reason |

## Phase 21 — Continuity & Resilience

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 311 | Comms health: number reputation, delivery rates, spam-score checks, volume ramp rules per number | NOVA | FA | invariant: delivery ≥ threshold; degradation ⇒ auto-throttle + card |
| 312 | Comms failover: standby number pool/subaccount; documented cutover; inbound falls back to human cell chain | SAGE | FA | quarterly failover test **executed** (drill is the evidence) |
| 313 | Backup verification: quarterly restore drill of prod DB to scratch env — **a backup that hasn't been restored is a hope, not a backup** | SAGE | FA | drill executed + restored-row-count evidence |
| 314 | Vendor outage detection (Vercel/Twilio/QB/Stripe status): degrade gracefully, queue outbound actions, replay after | SAGE | FA | invariant: outage window actions queued not dropped; replay reconciliation |
| 315 | "System down" runbook in Library: one page for the office human — phone failover, manual booking sheet, who to call | SAGE | M→FA | runbook version current < 90d; linked from Today |
| 316 | Security cadence: key rotation clocks, access audit, secret-box review | SAGE | FA | rotation invariants; quarterly audit artifact |
| 317 | Tenant data export: full monthly export per tenant to owner-controlled storage (also preserves acquisition exit optionality) | SAGE | FA | executed monthly; export integrity check |

## Phase 22 — Commission Engine

Headless like the rest of Money: plans are Library documents, math is invariant-proven, reps see statements, disputes are cards.

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 318 | Plan engine: per-rep comp plans (% of collected GM, tiers, self-gen vs company-lead splits) versioned in Library | VERA | FA | invariant: every rep has exactly one active plan version |
| 319 | Accrual on **collection** events (not invoicing) — commission exists only when cash does | VERA | FA | invariant: accruals == plan math × collected GM (extends existing money check) |
| 320 | Chargebacks: callbacks/cancellations/refunds claw back per plan rules automatically | VERA | FA | invariant: every qualifying event produced its chargeback |
| 321 | Monthly rep statements auto-generated + delivered; line-item drill to jobs; disputes → exception cards with evidence attached | VERA | FA | executed monthly; every dispute resolved < 14d |
| 322 | Payout export to QB/payroll rail; owner approval card above threshold | VERA | AS | reconciled: payouts == approved statements |
| 323 | Commission forecast for reps ("pipeline pay"): expected commissions from their open jobs — retention tool | VERA | FA | forecast vs actual variance tracked |

### Media policy (owner decision 2026-07-03)

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 341 | Media caps per project: **max 2 videos, ≤ 500MB each**; photos unlimited. Enforced at upload/ingest (reject with clear message), not by memo. No transcoding pipeline — payout-gated out; the cap alone keeps storage boring (~1.4GB/project all-in). Revisit only if R2 bill > $100/mo | MILO | FA | invariant: zero projects with > 2 videos or oversize clips; monthly storage $ in digest |

## Phase 23 — Supplier Economics

Suppliers are notorious for not honoring agreed pricing, and landed cost varies by job size (a $125 delivery fee vs a lower shingle price flips at some square count). Both are pure math — perfect background ops.

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 335 | Supplier cost sheets: agreed pricing per supplier (ABC, SRS, QXO, Beacon…) as versioned Library docs — unit prices, delivery fees, fuel surcharges, minimums, terms | VERA | FA | invariant: every active supplier has current cost sheet < 90d old or a renewal card |
| 336 | **Invoice price-guard: every supplier invoice line checked against the agreed cost sheet; overage ⇒ auto credit-request email with line-level evidence (invoice vs sheet); recovery tracked to resolution** | VERA | FA | invariant: 100% of invoice lines checked; every overage has open credit request or received credit; recovered $ in digest |
| 337 | Optimal supplier selection: given a job's measurement + material list, compute **landed cost** per supplier (units × price + delivery + surcharges) → auto-pick on the PO, or card if savings < confidence margin | MILO | FA | invariant: every material order carries the landed-cost comparison artifact; realized vs predicted tracked |
| 338 | Price-drift watch: invoice actuals vs cost sheets over time → cost-sheet update proposals + estimate price-book margin alerts (suppliers creep, your prices shouldn't lag) | VERA | AS | monthly drift report; margin-floor breach ⇒ card |
| 339 | Rebate tracking: manufacturer/supplier volume rebates accrued as expected receivables with claim-window clocks | VERA | FA | invariant: no rebate claim window expires unclaimed |
| 340 | Supplier scorecard: delivery reliability, error rate, credit responsiveness — feeds the selector as a tiebreaker | MILO | FA | quarterly artifact |

## Phase 26 — Margin & Market (owner-approved 2026-07-11)

### 26a · Mobilization Blitz (crew-on-the-street economics)
The week of a build, marginal cost to sell the same street is near zero. Trigger:
production scheduled.

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 342 | Blitz orchestrator: on production scheduling, build the audience — closest 25–50 homes (tenant config) by geocode, deduped against suppression/do-not-mail | REMY | FA | invariant: every scheduled build spawns a blitz or logged exclusion |
| 343 | Three postcard waves via PostGrid timed to arrive-by-start / during-build / days-after windows (USPS 1–3d local — windows, not exact days). ~$129/job books as job-attributed marketing spend; auto-approved under a per-job blitz cap (config), card above | REMY | FA | reconciled: pieces == audience × waves; spend within cap |
| 344 | Canvass tie-in: auto-create the day-before/day-of territory + route around the job in the canvass app, with context ("we're roofing #14 through Friday — mobilization discount this week") | SCOUT | FA | invariant: every blitz has its canvass territory pushed |
| 345 | Facebook boost card: auto-generated creative (street-level framing; homeowner-consent flag required for any job photo; never a house number) + one-tap manual boost card day-before + day-of. NO ad-API automation (payout-gated out) | REMY | AS | executed per blitz; consent invariant: zero creatives using an unconsented customer's job |
| 346 | Blitz measurement: `mobilization` source tag on resulting leads; CAC per blitz and rolling ratio vs the 1-roof-per-7-jobs target in the weekly digest | VERA | FA | invariant: every blitz lead carries attribution; quarterly report artifact |

### 26b · Material reconciliation & returns

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 347 | Ordered-vs-used reconciliation: crew EOD leftover-stock photo (Production Pulse EOD flow) → parsed count vs PO; variance beyond threshold flags the job | VERA | FA | invariant: every completed job reconciles materials or logs why not |
| 348 | Returns discipline: returnable leftovers → pickup/return scheduled, restocking terms from the supplier cost sheet, credit chased to resolution by the price-guard machinery; recovered $ in digest | VERA | FA | invariant: no return sits unresolved > 14d |

### 26c · Win/loss price intelligence

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 349 | Lost-on-price capture: optional fields on the lost flow (competitor bid ~$, competitor name) — 10-second entry, never required | reps/SAGE | FA | % of price-losses with a captured bid tracked (target, not gate) |
| 350 | Market pricing map: quarterly artifact — our bid vs captured competitor bids by area/product/tier; feeds price-book review alongside the drift watch | VERA | FA | executed quarterly once n≥10 captures |

### 26d · Slow-week fill loop

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 351 | Crew-gap detector: capacity look-ahead (exists) emits a fill signal when a crew hole opens inside N days | SAGE | FA | invariant: every detected gap produces a fill plan or logged pass |
| 352 | Fill campaigns: aging-estimate this-week incentive (config discount, margin floor respected), repair backlog scheduling, maintenance-visit pull-forward — through existing drip/offer rails + touch governor | NOVA | FA (discount > threshold = AS card) | conversion per fill campaign tracked; idle crew-days in digest |

### 26e · Office role (pre-scale requirement)

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 353 | Roles/permissions audit: document current rep/office/crew/admin access reality; define the office-role tier (what they see, approve, and own) | session | M→AS | audit artifact + proposed matrix for owner approval |
| 354 | Office Today: scoped exception queue (their cards: scheduling, docs, collections calls, endorsement signatures) with owner-only items excluded; card ownership field on exceptions | SAGE | FA | invariant: owner-tier cards never render for office role |

**Deferred from this round (owner):** Spanish-speaking homeowner experience (revisit
post-Alta launch).

---

## Deferred — visible placeholders in the CRM

Per owner decision, build these as **blurred/locked tiles** so they're never forgotten:

- **M&A Machine** — locked tile on the Portfolio view: blurred mock of deal pipeline (sourcing → diligence → integration), label "Phase 24 — locked". One click shows the one-paragraph thesis and a "spec this" action that opens a registry stub.
- **Labor Supply** (crews/subs recruiting) — same treatment in the Agents section, "Phase 25 — locked."

Implementation: trivial static component, `aria-hidden` content, no data. The point is a standing visual reminder on the map — deferred ≠ invisible.
