# Onboarding UX — Design Spec (2026-06-18)

The third production-readiness sub-project (after Auth & provisioning #26, and
Deployment/infra #27). Turns the moment after sign-up from "dropped on an empty
dashboard" into a guided setup, and gives the product a public front door. The other
remaining sub-project (hardening/observability) is a separate spec.

## Problem
Today: sign up → `/select-org` (Clerk) → create org → land directly on an **empty
`/dashboard`**. The freshly-provisioned tenant has no confirmed company name, no
`revenueBand` (Phase 8 billing falls back to Starter), no teammates, no integrations —
and there's no public landing page (`/` just redirects to `/dashboard`).

## Goal
A new owner, right after creating their org, sees a focused **onboarding wizard**: a
required welcome step (confirm company name), then optional steps (profile, invite team,
connect tools) they can skip and resume later from a **dashboard checklist**. And a lean,
honest **landing page** at `/` for logged-out visitors. Done-when: a brand-new org is
gated through the welcome step into a working dashboard that shows a resumable setup
checklist, and a logged-out visitor at `/` sees a marketing page with a sign-up CTA.

## Scope (decided)
- **Wizard + a minimal landing page** (both in this sub-project).
- Required step = **confirm company name only** (low friction; the billing band is set by
  Savvy/admin for hand-onboarded pilots, offered as an optional step).
- Integrations featured: **Stripe, CompanyCam, QuickBooks, Roofr** — all optional, each
  reusing its existing `/settings/*` connect flow (no reimplementation).
- Landing page kept **lean**: hero + 3–4 honest value props + sign-up CTA. No pricing
  table, no invented features/testimonials.

## Approach (chosen)
**Dedicated `/onboarding` route (its own minimal layout) + a resumable dashboard
checklist**, with state in `tenant.settings.onboarding` (no new table).
- *Rejected — pure dashboard checklist, no wizard*: doesn't satisfy the required-step gate.
- *Rejected — a route per step* (`/onboarding/profile`, …): too many routes for 4 steps.

## Non-negotiables honored
- **Tenant isolation**: tenant-table writes go through `adminDb` scoped by `getTenantId()`
  (the established pattern — `tenant` is the RLS root with no policy; `savvy_app` can't
  write it). All write helpers live in `@savvy/db` and are integration-tested incl.
  cross-tenant reject.
- **Admin-gated mutations**: onboarding server actions are gated by `isOrgAdmin()`
  (`lib/authz.ts`) — they mutate company-level config.
- **TEST_MODE**: the gate redirect runs only under real auth (like PR #26's Clerk paths);
  TEST_MODE bypasses it. The wizard page itself renders under TEST_MODE so e2e can drive it.
- **Thin web layer, logic in packages**: pure logic + zod in `@savvy/core`, DB writes in
  `@savvy/db`, web queries `server-only` + thin, actions `"use server"`. apps/web is
  Playwright-only (no vitest).
- Ships with tests; typecheck + lint clean. **No schema migration.**

---

## Part 1 — Onboarding state (`@savvy/core`, pure)

`tenant.settings.onboarding` shape (stored, minimal):
```ts
{ requiredCompletedAt: string | null, dismissed: boolean }
```
- `parseOnboardingState(raw): OnboardingState` — zod parser, defaults
  `{ requiredCompletedAt: null, dismissed: false }`. Unit-tested (empty, partial, full).
- `deriveOnboardingSteps(input): { company, band, team, integrations }` — pure, derives
  the **optional checklist** truth from real data, NOT stored flags:
  - `company` = `requiredCompletedAt != null`
  - `band` = `revenueBand != null`
  - `team` = active Clerk-user count > 1 (count where `clerkUserId IS NOT NULL AND
    deactivatedAt IS NULL` — excludes PIN-only crew and the lone owner)
  - `integrations` = any of `stripeAccountId` / `qboConnectionId` / `companycamConnectionId` set
  Input is a plain object (`{ requiredCompletedAt, revenueBand, activeUserCount, connections }`)
  so it's trivially unit-tested. (Roofr has no per-tenant connection column, so it's shown
  in the wizard but not a checklist signal — noted, not gated.)
- `isOnboardingComplete(steps)` = all four true. The checklist hides when complete OR
  `dismissed`.

## Part 2 — DB write helpers (`@savvy/db lifecycle/onboarding.ts`, adminDb)
Single write-path, idempotent, integration-tested (incl. cross-tenant reject):
- `setOnboardingRequiredComplete({ tenantId, name })` — update `tenant.name` + merge
  `settings.onboarding.requiredCompletedAt = now()` (JSON merge preserving other settings).
- `setOnboardingProfile({ tenantId, revenueBand, timezone })` — update
  `tenant.revenueBand` + merge `settings.finance.timezone` (validated upstream).
- `dismissOnboarding({ tenantId })` — merge `settings.onboarding.dismissed = true`.

`settings` merges must be **read-modify-write within one adminDb statement** (use
`jsonb ||` concatenation or read-then-write) so concurrent settings writers don't clobber
sibling keys (scheduling/estimate/finance/esign). Prefer Postgres `jsonb_set` / `||` on the
specific path to avoid a read race.

## Part 3 — Web layer (apps/web)
- `lib/onboarding-queries.ts` (`import "server-only"`): `getOnboardingStatus()` →
  `{ state, steps }`. Reads tenant (adminDb by `getTenantId()`), active user count, and
  connection ids; runs `parseOnboardingState` + `deriveOnboardingSteps`.
- `lib/onboarding-actions.ts` (`"use server"`, each `isOrgAdmin()`-gated, returns a
  discriminated union `{ ok } | { error }`):
  - `completeWelcome({ companyName })` → `setOnboardingRequiredComplete`.
  - `saveProfile({ revenueBand, timezone })` → validate band ∈ `BILLING_BANDS` + IANA tz
    via `parseFinanceConfig`, then `setOnboardingProfile`.
  - `dismissChecklist()` → `dismissOnboarding`.
  - Invite reuses the existing `inviteTeammate` from `team-actions.ts` (no new invite code).

## Part 4 — Routing, gate & chrome
- **New route group** `(onboarding)/onboarding/page.tsx` + `(onboarding)/layout.tsx`.
  The layout repeats the auth choke-point from `(app)/layout`: `auth()` → no `userId`
  → `/sign-in`; no `orgId` → `/select-org`; then `getCurrentUser()` to provision. Renders
  full-screen, **no sidebar/topbar** (focused), espresso/gold theme.
- **The gate** (in `(app)/layout.tsx`, real-auth branch only): after `getCurrentUser()`,
  fetch onboarding status; if `requiredCompletedAt` is null → `redirect("/onboarding")`.
  Once stamped, `/dashboard` is reachable and `/onboarding` stays accessible for resuming
  optional steps (no redirect away from it).
- TEST_MODE: `(app)/layout` keeps skipping auth+provisioning (unchanged), so the gate
  doesn't fire in e2e; `/onboarding` is still directly visitable.

## Part 5 — UI components (`components/onboarding/`)
- `OnboardingWizard` (client): a stepper with 4 steps —
  1. **Welcome** (required): company name input (prefilled), "Continue" → `completeWelcome`.
  2. **Profile** (optional): billing-band cards (Starter/Growth/Scale from `BILLING_BANDS`)
     + timezone select → `saveProfile`. Skip allowed.
  3. **Invite team** (optional): email + role → `inviteTeammate`; "add another" / Skip.
  4. **Connect tools** (optional): 4 cards (Stripe/CompanyCam/QuickBooks/Roofr) linking to
     the existing `/settings/*` connect pages; shows ✓ when its connection is present.
  Persistent **"Skip to dashboard"**; after the last step → `/dashboard`.
- `OnboardingChecklist` (dashboard card): lists the **optional** steps only
  (band / team / integrations — `company` is always done by the time the dashboard is
  reachable, so it isn't shown), each an incomplete→link / complete→✓ row, a progress
  count, and a **Dismiss**. Hidden when `isOnboardingComplete` OR `dismissed`. Added to the
  top of `/dashboard`.

## Part 6 — Landing page (lean, honest)
- `apps/web/src/app/page.tsx`: resolve the caller's user id through a **TEST_MODE-safe
  helper** (`auth()` THROWS in TEST_MODE — gotcha from PR #26 — so the helper returns null
  there). If a real authed `userId` → `redirect("/dashboard")` (returning users skip the
  landing); else render `<LandingPage/>`. Under TEST_MODE the helper returns null →
  the landing renders, so it's e2e-testable. (Existing e2e that navigate to `/` expecting
  the dashboard must be updated to go to `/dashboard` directly — checked during planning.)
- Add `/^\/$/` to `middleware.ts` `PUBLIC` (else `auth.protect()` bounces logged-out
  visitors to `/sign-in` and the landing is never seen).
- `components/landing/LandingPage.tsx`: hero (headline = Savvy is the AI agent ops layer
  that runs a roofing company; subhead honest), 3–4 value props grounded in real features
  (unified lead→paid pipeline · five AI agents that do real work · get paid faster with
  e-sign + invoicing), primary CTA "Start free" → `/sign-up`, secondary "Sign in" →
  `/sign-in`. Espresso/gold theme. No pricing table, no fake social proof.

## Testing
- **Unit (`@savvy/core`)**: `parseOnboardingState` (defaults/partial/full),
  `deriveOnboardingSteps` (each flag), `isOnboardingComplete`.
- **Integration (`@savvy/db`)**: the 3 write helpers — happy path + settings-merge
  preserves sibling keys + cross-tenant reject.
- **e2e (Playwright, TEST_MODE)**: (a) visit `/onboarding`, complete Welcome → redirected
  to `/dashboard`; (b) seed a band-less tenant → dashboard shows the checklist, Dismiss
  hides it; (c) logged-out `/` renders the landing with a working sign-up link. The
  real-auth gate redirect is **manual-verify** (Clerk-only, like PR #26).

## Out of scope (other sub-projects / later)
- Hardening/observability (Sentry, rate-limiting, secret-fallback sealing).
- Self-serve billing-band enforcement / Stripe subscription for the platform fee.
- Rich marketing site (pricing page, docs, blog), per-tenant onboarding analytics.
- Per-user personal onboarding (e.g. Google Calendar connect lives in personal settings).

## Risks / honest constraints
- **Gate redirect is real-auth only** → not covered by TEST_MODE e2e; must be manually
  verified with a Clerk dev instance (same constraint as PR #26's auth flows).
- **QuickBooks/Roofr connect flows are still partial** (QBO OAuth is a Nango stub; Roofr
  has no per-tenant connection) — the wizard links to them honestly but "connected" state
  for those may not flip. Only Stripe/CompanyCam reliably show ✓.
- **`settings` jsonb merge race**: multiple settings writers touch `tenant.settings`;
  use path-scoped `jsonb` updates so onboarding writes don't clobber scheduling/finance.
