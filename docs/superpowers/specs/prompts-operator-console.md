# Claude Code Prompt: Operator Console v1 (the mockup UI, for real)

Paste everything below this line into a fresh Claude Code session at `~/Sites/savvy-crm`. This is the second half of **contract cell 5** (see `docs/superpowers/specs/first-20-cells.md`). Requires cells 1–4 on `main` (registry, evidence, health sweep, Today exceptions). If they aren't, stop and say so.

---

Rebuild Savvy's information architecture into the Operator Console shown in `docs/superpowers/specs/mockups/savvy-redesign-mockup.html` and `savvy-orchestrator-pages-mockup.html`. These mockups ARE the spec — open them in a browser, match their layout, hierarchy, and visual language (the existing dark/gold theme; reuse current design tokens and shadcn components — no new color system, no hardcoded colors that break the theme). The Stalk List mockup is wave 2 — do NOT build it now.

## The transformation

**Nav: 13 items → 5.** Today · Pipeline · Money · Agents · Library.
- Today ← home route (replaces Dashboard as `/`), absorbs Exceptions
- Pipeline ← Jobs + Leads (one continuum; lead vs job is a stage, not a module)
- Money ← Invoices, Payments, Billing, Commissions, QuickBooks
- Agents ← Command Center, Comms config
- Library ← Price Book, Team, Schedule config, Settings

**No old route dies:** every existing route 301-redirects to its new home (bookmarks, muscle memory, deep links from old SMS). Existing pages become sub-views reachable from the new sections — this is re-grouping and re-skinning, not rewriting working pages.

## Screens (in build order)

1. **Today (home).** Per the redesign mockup: portfolio strip (one card per tenant the user can access: cash-wk, AR, open exceptions, coverage % — from rollups; render gracefully with "—" where a metric isn't instrumented yet), decision queue header ("N decisions · est. X min" — sum of per-card estimates, default 3 min/card until founder-minutes instrumentation lands), ranked exception cards (severity chip, title, $ impact where known, why-line from the exception's evidence, SLA/meta, action buttons wired to their existing resolutions), "while you were out" digest panel (last 24h agent_run summary), money strip (4 KPIs from existing data), Coverage Map panel (task_health per tenant: green/amber/red/gray cells with tooltips = task name + status reason; click → task detail drawer). Empty queue state: "Nothing needs you" — the product working, celebrate it quietly.
2. **Pipeline.** Merge leads + jobs into one board (stages: lead → inspected → estimate → approved → production → invoiced → paid). Each card: name, address, value, and the **waiting-on line** — from job_task blocking info where instantiated, else derived from stage + last activity ("waiting on: customer decision · NOVA drip 2/5d"). Stuck (> N days) cards get the warning treatment and already emit exceptions — the board itself stays read-mostly; actions happen via cards in Today. Filter chips: all / stuck / waiting-on-human / claims / $25k+.
3. **Money.** KPI grid (cash-wk, WIP, GM — label it "estimated" until cell 14 lands actuals, AR aging ladder), the **nightly proof-of-correctness panel** (render each reconciliation/invariant check with pass/fail + evidence detail — from verification_run), commissions accrual summary. Existing invoice/payment/QB pages become drill-downs linked from here. No CRUD on this page.
4. **Agents.** Roster cards per agent (tasks owned from registry, 24h actions from agent_run, errors/skips, audit placeholder), the audit-principle panel, and the old Command Center feed demoted to a "telemetry" drill-down per agent. Locked tile: **Labor Supply — Phase 25** (blurred static mock, click shows one-paragraph thesis).
5. **Library.** Card grid: Task Registry (browse the 212+ with status), Policies, Claims Playbooks, Price Book, Templates & Drips, Tenant Settings (timezone visible!). Each links to its existing page or a simple read view. Locked tile on Portfolio strip area of Today: **M&A Machine — Phase 24** (same blurred treatment).
6. **Job Ledger** section on the job detail page: per-job task checklist from job_task (status glyph, task name, owner, evidence link, blocked-by), progress bar, per the orchestrator-pages mockup. Where job_task isn't populated for old jobs, show the derived timeline from existing events rather than an empty state.

## Rules

- **Read-mostly everywhere.** The only writes in this build: exception card actions (existing), role confirm patterns later. If you find yourself building a form, stop and check the spec.
- Graceful degradation over fake data: metrics not yet instrumented render as "—" with a tooltip naming the cell that will light them up. NEVER render invented numbers.
- Every panel that shows derived data links to its evidence (verification_run, agent_run, job_task rows). Proof-of-execution is the design language.
- Mobile: Today must be fully usable on a phone (the owner's primary surface). Other pages: responsive-reasonable is fine.
- Accessibility + dark mode per repo non-negotiable #7. Playwright e2e: nav redirects, Today renders cards from seeded exceptions, coverage map renders from seeded health, pipeline merge shows both leads and jobs, money proof panel renders check results.
- Tests + typecheck + lint per house rules. One PR per screen (6 PRs), worktree per slice.

Definition of done: the deployed app's Today screen is recognizably the mockup, running on real data from cells 1–4, with zero fictional numbers. Screenshot comparison against the mockup in the final PR description.

Start with screen 1. Restate the plan, open both mockup files, inventory which existing components you'll reuse, and list routes to be redirected.
