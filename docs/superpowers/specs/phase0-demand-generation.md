# Phase 0: Demand Generation — Master Task List Extension

**Tasks #213–#271, #324–#334** · same registry format as the 212 (owner, mode, evidence binding, verification tier).
Seed into `task_registry` alongside the master list. New agent designation: **REMY** (revenue/marketing) — or assign to NOVA if you'd rather not add a sixth agent yet.

Modes: FA = full_auto · AS = assisted (surfaces as exception) · M = manual (gray until automated)
New scope value used below: `per_channel_recurring`.

---

## 0.1 Storm Sentinel (StormProofCerts, inverted)

| # | Task | Owner | Mode | Evidence binding (tier) |
|---|---|---|---|---|
| 213 | Monitor NWS/StormProof feed for verified hail/wind events intersecting service areas | SCOUT | FA | executed: sentinel run per event day; invariant: no event polygon in service area without a sentinel record within 6h |
| 214 | Intersect event swath with property DB (customers, dead quotes, enriched addresses) → target list | SCOUT | FA | invariant: every event has target list with counts; spot-check 5 addresses inside polygon |
| 215 | Launch storm mailer via PostGrid Print & Mail API: address-specific cert language + QR verification page | REMY | AS — owner approves spend per event over threshold | reconciled: PostGrid order count == target list count; sample mail-piece render check |
| 216 | Spin up storm-event landing page (event date, map, verification, booking link) | REMY | FA | invariant: every event > N affected addresses has live page; uptime check |
| 217 | Geo-fenced ad activation on swath (Google/Meta) with capacity throttle | REMY | AS — budget card | reconciled: ad platform spend == approved budget ± 5% |
| 218 | SMS to *prior opt-in* contacts inside swath (TCPA guard: opt-in flag required) | NOVA | FA | invariant: zero storm SMS to non-opt-in numbers — permanent compliance invariant |
| 219 | Claim-deadline ladder: monthly StormProof sweep of all DB addresses; escalating sequence as filing window ages (compliant wording: inspection offer, never claim advice) | SCOUT | FA | executed monthly; invariant: every address with verified event < 12mo old is enrolled or excluded with reason |
| 220 | Attach StormProof cert to every insurance scope/supplement package | SCOUT | FA | invariant: 100% of filed claims carry cert ref; track supplement hit-rate delta as metric |

**Compliance notes baked into bindings:** #218's zero-tolerance invariant; #215/#219 copy templates live in Library with "no public-adjusting language" rubric, sample-audited weekly (tier: sampled_audit).

## 0.2 Database resurrection (the acquisition multiplier)

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 221 | Import acquired/legacy contact DB → dedupe → enrichment pipeline (geocode, roof age, storm history, email append via B2 seam) | ATLAS | FA | invariant: % of imported records enriched ≥ threshold within 14d; dedupe invariant extended to imports |
| 222 | Segment engine: 18+yr roofs / storm-hit dead quotes / past customers / unreachable | ATLAS | FA | invariant: every enriched record carries exactly one active segment |
| 223 | Reactivation drips per segment (NOVA): inspection offer / "conditions changed" / maintenance+referral | NOVA | FA | executed per segment; no_double_send + appended-email guard invariants apply |
| 224 | Diligence tool: run a *target company's* customer list through 221–222 pre-LOI → "database value report" | SCOUT | AS | executed per deal; report artifact stored |

## 0.3 Neighbor engine

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 225 | Post-job radius mail (50 nearest homes, "we did your neighbor's roof") auto-triggered at job completion | REMY | FA | invariant: every completed job has radius send within 7d or exclusion reason |
| 226 | Yard-sign ask inserted into post-job drip | NOVA | FA | executed; template versioned |
| 227 | Permit-record watch: competitor permits in service area → neighbor mail for those addresses | REMY | FA | executed weekly; source scrape health check (stale ⇒ amber) |

## 0.4 Reputation & referral loop (compliant — no gating)

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 228 | Mid-job pulse check SMS ("how are we doing, 1–5?") at material-delivery and tear-off milestones | NOVA | FA | invariant: every production job has ≥1 pulse sent; response rate tracked |
| 229 | Detractor signal (1–3) ⇒ service-recovery exception opens; **review ask auto-paused** until resolved | SAGE | AS — recovery is a human card | invariant: zero review invitations sent while an open recovery exception exists for that job — *this is the legal version of gating* |
| 230 | Review invitation to **all** customers post-walkthrough (after any recovery resolves) — Google + BBB + Nextdoor rotation | NOVA | FA | invariant: every closed job gets invitation (FTC/Google-safe: no conditional suppression by rating); delivery receipts |
| 231 | AI-drafted responses to all public reviews within 24h (negative ones: AS — owner approves) | NOVA | FA/AS | invariant: no unanswered review > 24h |
| 232 | Referral program drip: post-payment offer, tracked codes, auto-payout via existing payments rail | NOVA | FA | reconciled: payouts == redeemed codes |
| 233 | GBP posts auto-generated from completed-job photos (CompanyCam) weekly | REMY | FA | executed weekly; photo-rights flag on customer contract required (invariant) |

## 0.5 Paid channels & speed

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 234 | LSA/aggregator instant-response: answer/auto-text within 60s with booking link | ATLAS | FA | invariant: p95 first-response < 60s per source (extends existing speed-to-lead) |
| 235 | Capacity-aware spend throttle: pause/boost channels vs 2-week install capacity | REMY | AS — changes over $X/day are cards | reconciled: platform budgets match throttle decisions; decision log |
| 236 | CAC auto-attribution per channel per tenant (leads already carry `source`) | VERA | FA | invariant: every won job has source + spend allocation; monthly CAC report artifact |
| 237 | Kill-switch rule: channel CAC > threshold for 2 consecutive months ⇒ pause + exception | SAGE | AS | invariant: no channel running above kill threshold without an approved override |

## 0.6 Partner channel (B2B)

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 238 | Partner CRM list (realtors, insurance agents, property managers) enriched + maintained | ATLAS | FA | staleness invariant: no partner record untouched > 90d |
| 239 | Instant roof/storm report generator for partners (StormProof + enrichment data, branded PDF) | SCOUT | FA | executed per request; render check |
| 240 | Monthly partner nurture with report offer + market stats from area↔roof-type dataset | NOVA | FA | executed monthly; no_double_send |
| 241 | Roof-cert-for-home-sale product line (big in AZ): request → inspection booking → cert delivery | MILO | FA | invariant: every cert request reaches booked-or-declined within 48h |
| 242 | Quarterly human coffee list: top partners ranked by referred revenue → card for local rep | SAGE | AS | executed quarterly |

## 0.7 Programmatic SEO (owned data moat)

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 243 | Neighborhood pages: storm history + roof-type mix + jobs completed (anonymized), generated from own dataset | REMY | FA | invariant: page count == active neighborhoods; freshness < 30d |
| 244 | Storm-event archive pages (per verified event, linked from certs' QR verification) | REMY | FA | invariant: every sentinel event has page within 48h |
| 245 | Indexing/rank health check monthly (Search Console API) | REMY | FA | reconciled vs GSC; regressions ⇒ amber |

## 0.8 Channel governance

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 246 | Weekly demand digest: leads/CAC/booked-inspection rate per channel per tenant → owner digest | SAGE | FA | executed weekly |
| 247 | Monthly copy-compliance audit: sampled_audit of all outbound marketing against Library rubrics (TCPA, no-public-adjusting, FTC review rules) | second-model | FA | sampled_audit ≥ 95% pass; fails ⇒ red + card |
| 248 | Lead-source data hygiene: every lead has source, no `unknown` > 5% | ATLAS | FA | invariant (today's "Inbound caller / Unknown" problem, made permanent) |

## 0.9 Listings-at-risk (storm × for-sale intersect)

The wedge: a listed home with an NWS-verified storm event is a **closing risk** — damage surfaces at the buyer's inspection, deals renegotiate or die, and the seller typically still holds claim rights pre-closing. We sell the realtor deal certainty: fast inspection + StormProof cert for the closing file. This is the sharpest version of the partner channel because it has a deadline (closing date) built in.

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 249 | Listing feed ingestion: active/pending listings in service areas via licensed vendor behind a `ListingFeed` seam (dormant default) | ATLAS | FA | staleness invariant: feed sync < 24h; listing count sanity vs prior day |
| 250 | Storm × listing intersect: flag listings with a verified event inside the claim window (StormProof) | SCOUT | FA | invariant: every flagged listing carries event ref + listing ref; spot-check polygon membership |
| 251 | Listing-agent outreach (email + PostGrid letter — **no cold SMS**): closing-risk info pack — verified event data, 48h inspection offer, sample cert | NOVA | FA | executed per flagged listing; suppression: one outreach per agent per listing; CAN-SPAM opt-out invariant |
| 252 | Fast-track inspection lane for listed properties: request → booked-or-declined < 48h | MILO | FA | invariant on the 48h SLA |
| 253 | Closing-file deliverable: inspection report + StormProof cert PDF auto-delivered to the agent | SCOUT | FA | executed; render check; delivery receipt |
| 254 | Conversion tracking: outreach → inspection → cert/job revenue per agent; top agents feed the #242 quarterly coffee list | VERA | FA | invariant: every listing-sourced job carries agent + listing attribution |
| 255 | Steady-state watch: **new** listings appearing in past-storm areas (12mo lookback), so the channel runs between storms, not just after them | SCOUT | FA | executed daily; deduped against #250 flags |
| 256 | Copy rubric: never assert damage exists — "NWS-verified storm event at this address; inspection recommended before buyer's inspection" wording only | second-model | FA | sampled_audit ≥ 95%; fails ⇒ red + card |

**Data-source reality check:** there is no free MLS API. Options behind the `ListingFeed` seam: a licensed feed via SimplyRETS/Trestle/Bridge (usually requires a broker relationship — a friendly local broker partner works), or aggregated listing data from a vendor like ATTOM. The seam keeps the vendor swappable; ship dormant until one is signed. **Status: backburner per owner (2026-07-01)** — seed the tasks as `manual`/gray, build nothing yet.

## 0.10 Golden-roof targeting (shake · clay tile · asbestos)

Certain materials are near-certain paydays when matched with a storm: **shake** (in AZ effectively all end-of-life; many carriers won't renew on shake → replacement pressure), **clay tile** (high $/square, brittle under hail), **asbestos** (big jobs — but require a licensed abatement sub, see #261). Strategy: identify them *before* the storm; when the sentinel fires, golden ∩ swath is a pre-computed query.

Layered identification, cheapest first: (1) county assessor roof-cover fields — Maricopa records Wood Shake / Clay Tile / Concrete Tile / Comp Shingle per parcel, bulk-downloadable; CO counties vary; subtract re-roofed parcels via permit history (#227's source). (2) Aerial CV vendor layer (Nearmap AI / CAPE-class) for parcels the assessor misses. (3) Own flywheel: #82's confirmed roof types + subdivision inference (same builder + same year ⇒ same original roof). Asbestos is invisible from the air: proxy = built pre-~1965 + no re-roof permit + era flags ⇒ verify at inspection.

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 257 | Assessor roof-cover ingestion (Maricopa; Denver-metro counties) → `property.roof_material` with `source='assessor'` + confidence | ATLAS | FA | invariant: % of service-area parcels with material attribute ≥ threshold; annual refresh executed |
| 258 | CV roof-material layer via vendor seam (`RoofIntel`) for parcels lacking assessor data | SCOUT | FA (spend = AS card) | reconciled: vendor query count == billed count; confidence stored per parcel |
| 259 | Verification pass on high-value, low-confidence predictions: VLM classification on street-level/aerial imagery | SCOUT | FA | sampled precision ≥ 90% vs inspection ground truth |
| 260 | Subdivision inference: propagate inspection-confirmed roof types across same-builder/same-year tracts | ATLAS | FA | invariant: every inferred value carries source + confidence; never overwrites confirmed data |
| 261 | Asbestos proxy list: pre-1965 + no re-roof permit + era/region flags ⇒ `possible_asbestos` (verification-at-inspection targets, **not** mail targets); Library policy: no asbestos job sold without licensed abatement sub on file | SCOUT | FA | invariant: zero marketing sends to unverified asbestos flags; abatement-sub check before contract |
| 262 | Golden lists per tenant (shake / clay / asbestos-verified), refreshed monthly, pre-joined to geocodes | ATLAS | FA | invariant: list freshness < 30d; segment counts in weekly digest |
| 263 | Sentinel priority tier: golden ∩ swath fires first — premium mailer, call task, canvass-route ranking; contact within 72h of event | SCOUT/REMY | FA (spend = AS card) | invariant: 100% of golden-intersect addresses actioned < 72h or exclusion reason |
| 264 | Ground-truth loop: every inspection's confirmed material scores the prediction that targeted it; thresholds tuned monthly | SCOUT | FA | executed monthly; precision/recall report artifact |

## 0.11 Roof Tagger, Turf Score & the Strike List

**Terminology:** the unified pre-storm target ledger is the **Strike List** — golden roofs (0.10) + **Turf** neighborhoods (momentum) + claim-window actives, ranked and pre-joined to geocodes. The Roof Tagger app (bloomroofs.vercel.app) is the human ground-truth sampler feeding it.

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 265 | Tagger sync: pins → `property.roof_material` with `source='spotter'` + tagger identity; Savvy pushes suggested drive routes (uncertain clusters from #260) back to the app | ATLAS | FA | invariant: every pin synced < 1h with attribution; route suggestions refreshed weekly |
| 266 | Spotter accuracy loop: inspection ground truth scores each tagger's precision; low scorers get coaching flag | SCOUT | FA | monthly precision report per spotter |
| 267 | Tile-debris funnel: debris pin + roof ≥ 17 yrs → auto valley-cleaning quote (priced from price book; delivered by mailer, or SMS if opt-in contact exists) → cleaning visit doubles as inspection → replacement pipeline | NOVA/MILO | FA (quote > threshold = AS card) | invariant: every qualifying pin actioned < 72h or exclusion reason; funnel conversion tracked |
| 268 | DIY CV pilot: VLM classification on NAIP imagery for golden-candidate parcels; precision measured against tagger pins + inspections; output = buy/skip decision card on paid vendor layer (#258) | SCOUT | FA | executed; precision report artifact; vendor decision recorded |
| 269 | **Turf Score** per neighborhood (subdivision/plat): our completed roofs ÷ total parcels, recency-weighted, plus referral/review density from the area | ATLAS | FA | invariant: monthly refresh; every neighborhood with ≥ 1 job scored |
| 270 | Turf triggers: neighborhood crossing threshold (e.g. 5%) → escalated presence — "your neighbors chose us" mailer variant, canvass-route priority, review/yard-sign pushes concentrated there | REMY | FA (spend = AS card) | invariant: every threshold crossing produces a campaign or logged exclusion |
| 271 | Strike List assembly: golden (#262) + Turf (≥ threshold) + open claim windows (#219) → one ranked ledger per tenant, refreshed weekly; **the storm sentinel targets exclusively from the Strike List** | ATLAS | FA | invariant: freshness < 7d; 100% of sentinel campaigns trace to Strike List entries |

## 0.12 Multifamily & HOA — the Stalk List (tasks #324–#334)

Account-based commercial targeting: apartment complexes and HOAs. Split: **humans build relationships, AI builds the map.** AI does the desk research (who owns it, who manages it, who decides, when they decide); humans confirm on visits and work the relationship. Accounts feed the Strike List — a complex in a swath with a confirmed contact is the top commercial tier.

| # | Task | Owner | Mode | Evidence binding |
|---|---|---|---|---|
| 324 | Commercial inventory: multifamily/HOA parcels from land-use codes + golden-roof layers + unit counts → target accounts | ATLAS | FA | invariant: every multifamily parcel in service area classified; refresh annual |
| 325 | Entity resolution: owner LLC → Secretary of State registry → statutory agent, principals, management company; ownership graph with source links | SCOUT | FA | invariant: every target account has owner chain with ≥ 1 cited source |
| 326 | HOA registry ingestion: **CO DORA HOA registration (designated agent + mgmt contact — bulk answer key)**; county-recorded CC&Rs; AZ county filings | SCOUT | FA | executed quarterly; match rate tracked |
| 327 | People finder: per-account AI research sweep (mgmt co sites, listing pages, LinkedIn, Google reviews, permit pullers, published minutes) → role candidates with confidence + citations. Desk research only; outreach stays on compliant channels | SCOUT | FA | invariant: every candidate has source links; sampled accuracy vs field confirmations ≥ threshold |
| 328 | Stalk List page: org map per account (HOA president · board · CAM/PM · maintenance super · regional), status unknown→suspected→confirmed, last touch, next action, stage (identified→mapped→contacted→relationship→bid list→won) | — | UI | read-mostly; all writes via field capture + AI sweeps |
| 329 | Field capture: voice memo from site visits parses into org map + account notes (same voice-first pattern as rep memos #277) | NOVA | FA | invariant: every logged visit parsed < 12h; unconfirmed role candidates touched by a visit get confirm/deny prompt |
| 330 | Bid-window intelligence: annual meeting dates, budget season, reserve-study cycle, complex roof age → decision timeline per account; work-back nurture schedule | SCOUT | FA | invariant: every account in stage ≥ mapped has a decision timeline or "unknown — next fact to find" |
| 331 | Role-based nurture: CAM/PM portfolio storm reports (StormProof), maintenance-program pitch for complexes, board credentials packet before annual meetings | NOVA | FA | executed per schedule; no_double_send; suppression per role |
| 332 | Portfolio leverage: management-company parent accounts aggregate their properties; a confirmed PM relationship lights up the whole portfolio on the Strike List | ATLAS | FA | invariant: portfolio links derived for every mgmt co with ≥ 2 properties |
| 333 | Strike List integration: complex ∩ swath + confirmed contact = top commercial tier (call task same day); no confirmed contact = "find the person" card with AI's best candidates + suggested trip | ATLAS | FA | invariant: 100% of commercial swath intersects actioned < 24h |
| 334 | Account economics: touches + trips per won account, revenue per account, founder/rep minutes — commercial CAC in the weekly digest | VERA | FA | invariant: every won commercial job traces to account + touch history |

**Why Turf matters:** roofing sells by visible social proof — crews on the street, yard signs, neighbor referrals. A neighborhood where you've done 5%+ of roofs converts materially better on every channel, so momentum itself is targeting data. Turf Score makes it explicit, and #270 concentrates spend where the flywheel is already spinning. When a storm hits a high-Turf neighborhood, those Strike List entries outrank everything — warmest ground, fastest paydays.

---

## Build notes

- **REMY vs NOVA:** if adding an agent is friction, assign REMY's rows to NOVA and split later; the task IDs don't change.
- **New integrations needed:** print-mail API (PostGrid — also gives CASS address verification), ad platform APIs (Google/Meta), permit-record source per county, Search Console, listing feed (SimplyRETS/Trestle/ATTOM behind the `ListingFeed` seam). Each goes behind a seam like `EmailFinder` — dormant default, activate per tenant.
- **Sequencing:** 0.1 Storm Sentinel first (highest leverage, most StormProof reuse), then 0.4 reputation loop (cheap, compounds), then 0.2 resurrection (ready before acquisition #2 closes), then the rest.
- **Every task above ships with its binding** — Phase 0 enters the Coverage Map gray and earns green like everything else. Marketing that can't prove it ran doesn't run.
