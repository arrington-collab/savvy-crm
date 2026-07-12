# Claude Code Prompt — The Estimate Experience (page, price book, accept flow, close-rate loop)

Written 2026-07-08. Owner decisions locked: 50% deposit at acceptance · accept flow offers
install dates · shingle color selector on the page · 30-day validity · tiers = IKO
Cambridge (Good) / IKO Dynasty (Better, recommended) / TAMKO Titan XT + TAMKO warranty
(Best) · NO StormProof cert on retail estimates (storm ⇒ insurance path) · open-signal
goes to the REP first with a 60-second window, then NOVA texts the customer.

Round-2 owner decisions (2026-07-08): PRESENT MODE for kitchen-table closes = top
priority · Why Us page IN · rep post-inspection video IN · owner day-after video IN
(one pre-recorded video per tenant, personalized wrapper, owner-priority routing) ·
page Q&A IN · value-adding follow-up sequence IN · color-on-their-roof render DEFERRED
(sequence carries an inactive slot for it) · comparison-armor content DEFERRED ·
neighborhood/Turf proof DEFERRED until Turf data exists.

One worktree per slice → TDD → PR → watch CI. Read CLAUDE.md. Survey first: estimate
schema + auto-draft (estimate-generate, measurement_source stamping), sketch outputs
(plan/surface area, deduped edge LF by type, ventilation NFA), price book current shape,
DocuSeal e-sign integration, Stripe payments path, financing seam (#148, dormant),
homeowner status page (tokenized page pattern), drips (expiry follow-ups), demo-mute flag
if landed. Check the drizzle journal from YOUR worktree before migrations.

---

## Slice 1 — Price book: assemblies + tiers

1. ASSEMBLIES consume sketch quantities: tear-off + install per square (surface area);
   drip edge (eave+rake LF); ridge cap (DEDUPED ridge LF); valley material (valley LF);
   ice & water (eave LF × courses + valleys); underlayment (squares); ventilation line
   items (from NFA calc + physical ridge LF); flashing/pipe boots (counted units);
   disposal (squares × layers). Each assembly: cost basis, margin floor, unit.
2. TIER COMPONENTS: tier = shingle product + warranty package + ventilation package.
   Seed products: IKO Cambridge (Good), IKO Dynasty (Better, flagged recommended),
   TAMKO Titan XT (Best). Each product carries: manufacturer, per-square cost slot
   (owner fills real costs — emit a "price book needs costs" card, don't invent),
   WARRANTY TEXT/registration details (IKO for Good/Better, TAMKO for Best — the
   estimate renders the correct manufacturer warranty per tier), and its COLOR PALETTE
   (name + swatch hex; owner-editable list per product in Library).
3. GENERATION: pure function measurement + edge LF + ventilation + roof type(s) →
   assembly expansion → three tier totals → margin-floor check (violation ⇒ card, never
   silent under-floor). Pricing-inputs snapshot on the estimate (extends the existing
   stamp). Property tests on the math.
4. FAST PRICE UPDATES (owner: costs arrive this week and change often): a Library
   flow — paste or upload a supplier price sheet/quote → AI-parse to a proposed cost
   diff (old vs new per item, margin impact preview) → one-tap apply as a NEW price
   book version (never in-place edits; versioning is the audit trail). Estimates
   already sent keep their 30-day locked price (their stamped version); new drafts
   use current. Wire the supplier-invoice price-drift signal (#136/#338 machinery) to
   propose these diffs automatically when invoices reveal cost creep. Red-path test:
   applying a version that pushes any tier under its margin floor requires explicit
   owner confirm.

## Slice 2 — The customer-facing estimate page

Tokenized route (reuse the /status token pattern; short-lived-signed media URLs), MOBILE-
FIRST, tenant-branded LIGHT theme (this is homeowner-facing — warm/trustworthy, not the
operator console aesthetic). Top to bottom:
1. Their roof: sketch render or aerial + customer name/address ("this is about MY house").
2. Three tier cards: product name, upgrade bullets ONLY (shared scope lives below —
   never three columns of line items), total, and MONTHLY PAYMENT TOGGLE (from the
   financing seam when a vendor is wired; hidden while dormant). "Recommended" badge on
   Better/Dynasty.
3. COLOR SELECTOR per selected tier (that product's palette; selection stored on the
   estimate; note "subject to supplier availability" from Library copy).
4. "What's included" visual rows: tear-off, ice & water, drip edge, ventilation,
   cleanup + magnetic nail sweep, permits, workmanship warranty — icons + one-liners.
5. Inspection photos (customer-safe flagged only), annotations if present.
6. Warranty panel — switches by selected tier (IKO vs TAMKO) + workmanship warranty.
7. Trust strip: license #s (from the license matrix), insured, years/local line —
   NO StormProof cert on retail (owner decision).
8. Validity: "Price valid through <date>" (30 days, tenant-config).
9. Accept CTA → slice 3 flow. PDF download link (server-rendered fallback that matches
   the page content; also the email attachment).

## Slice 3 — Accept flow (yes → signed → paid → scheduled, one motion)

1. Accept(tier, color) → DocuSeal e-sign inline (SB38-compliant template on CO tenants —
   template-version invariant applies) → Stripe deposit for 50% of accepted tier
   (tenant-config percentage; payment on the same page, no email detour).
2. On signed+paid: the EXISTING acceptance path fires (estimate accepted → job created →
   lead won — do not fork it), then the page immediately offers INSTALL WEEK selection
   from real capacity (reuse scheduling/capacity work; offer weeks not days at this
   stage; selection creates the tentative production hold).
3. Confirmation state: what happens next timeline + status-page link.
4. Red-path tests: deposit failure ⇒ signed-but-unpaid state with card + retry link (no
   job creation until paid unless tenant-config says otherwise); double-accept
   idempotent; expired estimate (>30d) shows renewal prompt and notifies the rep instead
   of accepting at stale prices.

## Slice 4 — Telemetry + the 60-second rep race

1. Page telemetry: opens, dwell, tier views, color plays — stored on the estimate
   (evidence, and NOVA's trigger). No third-party analytics; first-party only.
2. THE RACE (owner-specified choreography): on a hot signal (first open, or return
   visit) → notify the ASSIGNED REP (push/SMS with customer name + one-tap call link).
   If the rep doesn't initiate a call within 60 SECONDS (call event or rep tap-through),
   NOVA sends the customer text (Library template: "Saw you're looking over your
   estimate — questions? I'm here."). Throttle: once per session, max 1/day per
   customer; quiet hours respected; demo-mute respected.
3. Rep race metrics on the #278 scorecard: response rate within 60s, close rate on
   rep-called vs NOVA-texted opens (this settles the choreography with data).
4. Expiry: at 30d unaccepted → existing follow-up drips get the expiry variant;
   renewal regenerates against current price book version.

## Slice 5 — Present mode + Why Us + videos + page Q&A (owner-approved round additions)

1. PRESENT MODE (the kitchen-table close — highest-leverage item in this build): a
   rep-triggered full-screen presentation state (no nav/chrome, large tap targets) for
   tablet use at the table same-visit. WALKTHROUGH ORDER (owner's close sequence):
   ① roof shape/condition (diagram + Roof Record findings when the inspection build
   lands) → ② our suggestions → ③ estimate tiers → ④ colors → ⑤ close/accept flow
   inline. Estimate auto-draft speed matters here: verify
   the inspection-complete → draft path runs in minutes, and the approval threshold
   config is respected so under-threshold table closes NEVER wait on an owner card.
   Rep launches it from the lead tile; exiting present mode returns to normal page.
2. WHY US page/panel: tenant-branded Library content block (story, crew photos,
   license/insurance, workmanship warranty promise, process timeline) linked from the
   estimate page — owner-editable content, versioned like templates. (Comparison-
   armor content explicitly deferred this round.)
3. REP VIDEO: optional 60s video slot above the tiers — rep records post-inspection
   via the existing voice/media upload path ("here's what I found on your north
   slope"); customer-safe review flag applies. Estimate renders it when present.
4. OWNER DAY-AFTER VIDEO — PERSONALIZED-FIRST WITH GENERIC FALLBACK (owner decision:
   personalization is the point; availability is why it works):
   a. VIDEO BATCH CARD on Today, daily at a tenant-config time: yesterday's sent
      estimates as a recording queue — per customer: name (with phonetic hint when
      non-obvious), rep who visited, city, tier + price quoted, one context nugget
      (claim vs retail, a note or Q&A concern if any). Everything needed to record
      10 videos in 20 minutes with zero lookup.
   b. BATCH RECORDER: opening the card starts a rapid capture flow — teleprompter-style
      overlay with the current customer's details, record (target 30–60s), one-tap
      approve/redo (first-3-seconds preview), auto-advance to the next customer. Each
      take auto-attaches to its estimate; no filing, no uploads.
   c. AI POST-PROCESSING (automatic, no editor): trim leading/trailing silence,
      normalize audio, AUTO-CAPTIONS (most recipients watch muted — captions are not
      optional), tenant-branded end card with the owner line. No generative/synthetic
      video ever — editing only, the face and voice are real or it defeats the point.
   d. DELIVERY: NOVA sends the personalized video day-after with the wrapper text
      ("You talked with Seth yesterday — our owner wanted a word"). Estimates with no
      recorded take by send time get the GENERIC tenant video (one-time Library asset)
      with the same wrapper — the touch never depends on the owner's day. Watch
      telemetry recorded; personalized-vs-generic close rates split out in the
      close-rate report (this measures the 10% hypothesis directly).
   e. OWNER-PRIORITY LINE: inbound to the promised owner channel becomes a flagged
      digest card (break-glass above tenant threshold) with instant NOVA
      acknowledgment so the availability promise is always kept. Throttle: once per
      estimate; quiet hours; demo-mute.
5. PAGE Q&A: "ask a question" box on the estimate page → NOVA answers grounded ONLY
   in this estimate's scope/price book/warranty content (never invents; below
   confidence ⇒ "let me get the owner/rep" escalation card to the rep with 60s-race
   style notify). Every Q&A logged on the estimate (objection data for the close-rate
   report). Rate-limited; demo-mute respected.

## Slice 6 — Value-adding follow-up sequence

Post-send sequence where each touch ADDS something (never "just checking in"):
day 1: owner video (slice 5.4) · day 4: Why Us + warranty comparison angle ·
day 8: monthly-payment angle (only when financing is live) · day 20: validity reminder
(expires <date>) · then existing expiry flow. Template slots include a COLOR-RENDER
touch that activates automatically when/if the roof color-render feature ships in a
later round (do NOT build rendering now — owner-deferred; the sequence must work
without it). All touches: Library-versioned templates, telemetry-stamped, throttled,
quiet-hours + demo-mute respected; every touch's send + open feeds the close-rate
report.

## Slice 7 — Insurance variant + close-rate loop

1. INSURANCE TEMPLATE: no tiers, no monthly toggle by default — scope aligned to the
   carrier claim (from the parsed claim ledger), deductible framed with SB38-compliant
   language, upgrade OPTIONS rendered as out-of-pocket add-ons (e.g. impact-resistant
   upgrade difference). Same trust strip, same accept flow with deposit rules per
   tenant insurance config.
2. TEMPLATE VERSIONING + CLOSE-RATE REPORT: templates versioned in Library; every sent
   estimate stamps its version; monthly report — sent/opened/accepted by template
   version and by tier — activates at ≥20 sent per version ("insufficient data — n=X"
   below). Same calibration pattern as scoring/ballpark.
3. Evidence checks: estimate.page (every sent estimate has a live tokenized page +
   matching PDF), estimate.validity (zero acceptances at expired prices), and the
   margin-floor invariant from slice 1 bound into the sweep.

## House rules
Per-tenant TZ; no literal secrets; parsed/derived values never overwrite confirmed data;
customer-safe photo flag respected; demo-mute respected on all sends; post-contract work
— update first-20-cells STATUS only if evidence states change. Verify each slice live
(send yourself a real estimate on a test lead: open it on a phone, run the race with
your own number as rep, accept with a Stripe test payment on a demo/test path — never a
real customer) and state verifications in the PRs.

Start with the survey, then slice 1. Restate the plan, confirm the migration number,
list files you'll touch.
