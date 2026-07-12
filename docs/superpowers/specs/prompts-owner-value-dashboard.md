# Claude Code Prompt — The Owner's Room (speaking dashboard + live company valuation)

Written 2026-07-11. Owner thesis: the dashboard should SPEAK — the owner never needs to
check it because it tells him when and what to do — but it's there when he wants it.
Beyond KPIs, it carries the piece no market tool has: an HONEST live estimate of what
the company could sell for, and what would move that number. Every roofer wants to sell
someday; this is also the empire scoreboard (buy at ~2.5×, systematize, hold at 4×).

Honesty rules (non-negotiable):
- Valuation is a RANGE, never a point. Every multiple adjustment is NAMED with its
  reasoning and source data. Methodology page one click away.
- "Insufficient data" states until inputs are real (QBO connected, TTM history ≥ N
  months, job-costing actuals live). NEVER render a valuation from placeholder data.
- Standing caption: "Planning estimate from your operating data — not an appraisal or
  financial advice." Multiples/comps live in Library config the owner can see and edit.

One worktree per slice → TDD → PR → watch CI. Read CLAUDD.md — CLAUDE.md. Survey first:
Money page + tenant rollups, job costing actuals (#135), founder-minutes, coverage map
data, lead source taxonomy rollups, maintenance/MRR (Phase 20, may be unbuilt — handle
absent), review/reputation data available, AR aging, QBO reconciliation state (cell 8 —
skips until connected), digest + break-glass rails, portfolio strip. Check the drizzle
journal from YOUR worktree.

## Slice 1 — Valuation engine (pure, transparent, config-driven)

1. `valuationSnapshot(tenantId, asOf)` pure function in @savvy/core:
   INPUTS (each with a data-quality flag: real · estimated · missing):
   - TTM revenue + gross margin (job costing actuals; QBO once connected)
   - Adjusted EBITDA proxy (GM − operating estimate; refine when QBO lands — flag
     'estimated' until then)
   - Revenue mix: insurance vs retail vs maintenance/recurring MRR
   - Customer/channel concentration (top customer %, top lead-source %)
   - OWNER-DEPENDENCE: founder-minutes/month trend + coverage % (the Savvy-unique
     inputs — a company at 85% coverage and 40 owner-min/week is structurally
     owner-independent, and the engine prices that)
   - Backlog (signed, unbuilt $), AR health (>60d %), warranty callback rate,
     review score/volume, years operating, license/compliance standing
2. MULTIPLE MODEL: base SDE/EBITDA multiple range per revenue band (Library config,
   seeded from published trade-business comps, e.g. 2.0–3.0× SDE small residential;
   owner-editable with citations field). Named adjustments, each ±x with rationale
   string, e.g.: maintenance MRR ≥ target +0.2–0.4× · coverage ≥ 75% + low
   founder-minutes +0.3–0.5× (documented-process/owner-independence premium) · top
   customer > 25% −0.2–0.4× · insurance mix > 80% −0.1–0.3× (storm-dependence) ·
   QBO-reconciled clean books +0.1–0.2× · AR>60d above threshold −0.1×.
3. OUTPUT: value range (low/likely/high), the adjustment ledger (every +/− named),
   input quality summary, and deltas vs last snapshot. Monthly snapshot cron per
   tenant TZ; history retained for the trend line.
4. Tests: property tests on the math; every adjustment traceable to an input; missing
   inputs degrade to wider ranges + flags, never silent precision.

## Slice 2 — The Owner's Room (the page)

Route under Money (or Today panel link): 
1. HEADLINE: value range + quarterly delta ("≈ $1.9M – $2.6M · +$140K this quarter"),
   input-quality badge, methodology link, the not-an-appraisal caption.
2. VALUE BRIDGE: waterfall of named adjustments from base multiple to current range —
   the owner sees exactly WHY the number is what it is.
3. VALUE LEVERS (the actionable half): ranked list of the 3–5 moves that most raise
   the range, each with estimated impact and a link to the machinery that does it
   ("Grow maintenance MRR to $4K → +$120–240K est. — maintenance program (Phase 20)" ·
   "Cut top-builder concentration below 25% → +$80–160K — demand-gen mix" · "Coverage
   72%→85% → owner-independence premium — automation roadmap"). Levers derive from
   the adjustment ledger — never generic advice.
4. KPI strip (TTM revenue, GM, backlog, MRR, concentration, coverage, founder-min) —
   compact, all sourced, "—" for missing.
5. PORTFOLIO: per-company value ranges + deltas on the portfolio strip — the empire
   scoreboard; sum shown with the same honesty flags.

## Slice 3 — It speaks (proactive, never needy)

1. MONTHLY VALUE PULSE: one digest section — range, delta, the single biggest mover,
   one lever suggestion. No separate email; rides existing digest.
2. THRESHOLD CARDS (exceptions, not chatter): concentration crossing config threshold ·
   a lever completing ("maintenance MRR target hit — value range moved +$X") · an
   input going stale/degrading (QBO disconnect drops input quality → card) · quarterly
   snapshot ready. Break-glass never (nothing here is urgent by definition).
3. SAGE INTEGRATION: "what's my company worth?" answers from the latest snapshot with
   the adjustment ledger cited, same evidence-citation pattern as job questions.
4. Evidence checks: valuation.snapshot_cadence (monthly per tenant, green in sweep) ·
   valuation.no_placeholder (zero snapshots rendered from missing-flagged critical
   inputs — red-path test) · valuation.methodology_current (config version stamped on
   every snapshot).

## House rules
Per-tenant TZ; multiples/thresholds/comps in Library with a citations field (owner can
paste broker/industry sources); demo-mute; the engine NEVER auto-shares valuation
outside the owner role (office role excluded by default — ties to the Phase 26 role
matrix); post-contract work. Verify live: Bloom snapshot renders with honest 'estimated'
flags (QBO not yet connected), levers derive from its real adjustment ledger, digest
pulse appears, Sage answers with citations. State verifications in the PR.

Start with the survey, then slice 1. Restate the plan, confirm the migration number,
list files you'll touch.
