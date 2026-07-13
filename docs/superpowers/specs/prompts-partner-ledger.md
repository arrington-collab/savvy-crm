# Claude Code Prompt — Partner Ledger (per-referral-partner P&L)

Written 2026-07-11. Owner problem: referral partners (realtors, insurance agents) send
inspections that cost real time and don't always become roofs. We need to know exactly
what each partner produces vs. what they cost — per partner, per class, trailing 12
months — and turn the answer into actions, not vibes.

Design principles:
- Costs are counted honestly with STANDARD costs (an inspection is 2–3 loaded hours —
  tenant-config standard, default $200, methodology documented) plus trackable actuals
  (fees, free repairs, expenses, certs).
- Value is GROSS MARGIN attributed from collected job costing actuals — not revenue —
  plus open pipeline so new partners aren't judged prematurely.
- Grades produce CARDS, never automatic cutoffs. Humans end relationships; the machine
  ranks them.
- The two kinds of inspection are different products: damage/opportunity inspections
  are free prospecting; transaction-driven (realtor closing) inspections become a PAID
  roof-cert product (Phase 0 #241) — converting the worst-converting partner class
  from cost center to revenue line.
- Attribution hygiene or nothing: partners are PICKED (typeahead, create-once), never
  free-typed — or the ledger fragments into "Jane Smith / jane smith / J. Smith RE-MAX".

---

Work in ~/Sites/savvy-crm. Build the Partner Ledger. One worktree per slice → TDD →
PR → watch CI. Read CLAUDE.md. Survey first: lead.source/source_detail taxonomy
(landed — insurance_agent/realtor/partner classes + per-person referred-revenue
rollup from the leads overhaul), referral-fee payable machinery, friend-rule/repair-
credit machinery (Roof Record build), inspection entity (Roof Record if landed; else
appointment completions as the inspection signal), Phase 0 tasks #238–#242 (partner
CRM, cert product, quarterly coffee list), expense/money-events path, relationship
touch governor (Customer for Life build, if landed — partner reports route through
it). Check packages/db/drizzle/meta/_journal.json from YOUR worktree.

## Slice 1 — Partner entity + attribution hygiene

1. `partner` (tenant-scoped, RLS): id, name, org, class: realtor · insurance_agent ·
   property_manager · other, contact (phone/email), status: active · paused ·
   archived, notes, created_at.
2. Lead source flow: when source class is realtor/insurance_agent/partner, the "which"
   field becomes a TYPEAHEAD against partner records with inline create-once (name +
   org + class). lead.partner_id FK set on selection.
3. MIGRATION of existing data: normalize current source_detail free-text into partner
   records (case/whitespace/org-suffix folding); ambiguous or near-duplicate matches
   ⇒ a one-time review card listing proposed merges — never silently merge distinct
   humans.
4. Evidence: partner.attribution — zero partner-class leads without partner_id
   (red-path test: free-text source rejected for partner classes).

## Slice 2 — Cost accrual

Per-partner ledger entries (type, amount_cents, source_ref, occurred_at) accrued
automatically:
1. INSPECTION STANDARD COST: each completed inspection on a partner-sourced lead
   accrues the tenant standard cost (config, default $200; tooltip documents the
   loaded-hours methodology — same honesty pattern as founder-minutes).
2. FREE REPAIRS: friend-rule fixed_free_today items on partner-sourced
   leads/inspections accrue at their estimated value.
3. REFERRAL FEES: paid referral-fee money events link to the partner.
4. CERT/REPORT generation costs (nominal config value) when not sold (slice 4 sales
   book as revenue instead).
5. MANUAL EXPENSE QUICK-LOG: phone-friendly action (amount + note + partner picker)
   for lunches/gifts/sponsorships; weekly sum appears in the digest. No receipts
   pipeline — this is a log, not accounting (QuickBooks stays the books).
Evidence: partner.ledger_complete — every completed partner-sourced inspection has a
cost entry.

## Slice 3 — Value, grades, and decision cards

1. VALUE: attributed collected GM (from job-costing actuals #135) per partner + open
   pipeline value (unaccepted estimates, active jobs) shown separately. Funnel per
   partner: sent → inspected → estimated → won, with conversion %s and median
   days-to-convert.
2. NET VALUE: trailing-12mo GM − trailing-12mo costs. Per-partner AND per-class
   rollups (the realtor-vs-insurance-agent conversion gap becomes visible data).
3. GRADES: A/B/C thresholds in Library config (defaults: A = net value > $X and ≥1
   win; C = ≥N referrals with 0 wins in 12mo). Consequences:
   - A → feeds the quarterly coffee list (#242) + scheduling-priority flag on their
     referrals.
   - C → DECISION CARD with the numbers and three suggested actions: have the
     conversation / slack-capacity-only scheduling / move to paid certs (slice 4).
     Never auto-terminate; cards, not cutoffs.
4. UI: Partner Ledger view under the Stalk List/partner area (or Library → Partners
   until Stalk List ships): ranked table (grade, sent, won, GM, cost, net), partner
   detail with funnel + ledger entries + expense log. Read-mostly; actions via cards.
5. Evidence: partner.grades_current — grades recomputed monthly per tenant TZ cron.

## Slice 4 — Paid cert lane (Phase 0 #241)

1. Roof-cert product: price book item (tenant config price, default $195; per-tenant
   toggle). Request flow: partner or office creates cert request → scheduled through
   existing booking (slack-capacity class unless partner is priority) → inspection
   (Roof Record machinery, kind: cert) → cert PDF (condition summary + age range +
   photos; NO free repair marketing inside a paid deliverable) delivered ≤48h SLA →
   invoiced via existing rails.
2. Partner ledger books cert sales as partner-attributed REVENUE; any roof that
   emerges from a cert inspection attributes its GM to the partner as usual.
3. Evidence: cert.sla — every cert request reaches delivered-or-declined ≤48h.

## Slice 5 — Partner-facing quarterly report + internal ranking

1. Per A/B partner: a tokenized quarterly summary (page + PDF) — you sent N, we
   inspected N, M became projects, honest outcomes, thank-you framing, zero shame
   mechanics. Routed through the relationship touch governor (counts as a touch;
   quiet hours; demo-mute).
2. Internal quarterly artifact: all partners ranked by net value, class rollups,
   biggest movers, C-partner cards outstanding — one digest line links it.
3. Evidence: partner.quarterly — reports generated each quarter for every A/B
   partner (or logged suppression).

## House rules
Per-tenant TZ; thresholds/standard costs/grades in Library config, not code; demo-mute
everywhere; QuickBooks remains the accounting truth (this ledger is operational
economics, not books); post-contract work — log as such in PRs.

## Verification (live)
Seed a test partner: 3 leads (1 → won job with costed actuals, 1 → estimate open,
1 → inspection only), one manual expense, one cert sale. Confirm: attribution
invariant, cost entries complete, funnel + net value correct, grade computed, C-card
fires on a seeded zero-win partner, cert SLA path, quarterly report renders. State
every verification in the PR.

Start with the survey, then slice 1. Restate the plan, confirm the migration number,
list files you'll touch.
