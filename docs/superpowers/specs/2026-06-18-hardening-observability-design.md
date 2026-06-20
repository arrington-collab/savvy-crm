# Hardening & Observability — Design Spec (2026-06-18)

The fourth and final production-readiness sub-project (after Auth #26, Deployment #27,
Onboarding #28). Closes the security + operability gaps that remain before pilots run on
the deployed app: a forgeable-token fallback secret, no error visibility, no abuse
protection on public routes, and no structured logs.

## Goal
A production Savvy that (1) never falls back to a public constant for a real secret,
(2) reports prod errors to Sentry, (3) throttles its abusable public routes, and
(4) emits structured logs. Done-when: with the new env set, a missing `UNSUBSCRIBE_SECRET`
hard-fails in prod instead of using a known fallback; uncaught/route/server-action errors
appear in Sentry; hammering `/api/leads` or the crew PIN login returns a throttle response;
and public/webhook routes emit JSON log lines. All four are **disabled-by-absence** so dev,
e2e, and TEST_MODE are unaffected.

## Scope (decided)
Four parts, one spec, each independently shippable. **No schema migration.** The `/api/health`
probe (the 5th hardening item) already shipped in PR #27.

## Non-negotiables honored
- Disabled-by-absence: every new mechanism no-ops when its env is unset (Sentry without
  `SENTRY_DSN`, rate-limit without Upstash env) so the e2e/TEST_MODE path is unchanged.
- No secrets in repo; new env documented in `.env.example` + `.env.production.example`.
- Ships with tests (the testable parts); typecheck + lint clean; e2e stays green.
- Tenant isolation untouched (this sub-project adds no tenant data paths).

---

## Part 1 — Seal secret fallbacks (`@savvy/core`)

The `UNSUBSCRIBE_SECRET` env var signs unsubscribe links, booking tokens, AND the
Stripe-Connect OAuth `state`. It currently falls back to the literal
`"dev-unsubscribe-secret"` in **6 source sites** — a public constant (the repo is public),
so if the var is ever unset in prod those HMACs are forgeable.

- New pure helper `requireSecret(name, opts?): string` in `packages/core/src/secrets.ts`
  (exported from the core index):
  - returns `process.env[name]` when set;
  - throws `Error("Missing required secret: <name>")` when unset AND
    `process.env.NODE_ENV === "production"`;
  - otherwise returns `opts?.devFallback ?? "dev-<name-lowercased>"`.
  Reading `process.env` is a mild stretch of core's "pure logic" boundary, but core is the
  only module both `apps/web` and `packages/agents` import — and the function is trivially
  testable by setting env. (Approved.)
- Replace all 6 `process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret"` with
  `requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" })`:
  `apps/web/src/app/api/unsubscribe/[token]/route.ts`,
  `apps/web/src/app/api/stripe/connect/start/route.ts`,
  `apps/web/src/app/api/stripe/connect/callback/route.ts`,
  `apps/web/src/lib/booking-action.ts`,
  `packages/agents/src/functions/lead-intake.ts`,
  `packages/agents/src/functions/appointment-reminders.ts`.
- `CREW_SESSION_SECRET` already fails closed in prod (`crew-session.ts` throws) — refactor
  it to use `requireSecret` for consistency (no behavior change). Leave public-default
  fallbacks alone (`NANGO_HOST`, integration IDs, `APP_BASE_URL`); `CLERK_WEBHOOK_SECRET`
  already fails closed in its webhook.
- **Tested** (`@savvy/core` unit): set value wins; unset + `NODE_ENV=production` throws;
  unset + non-prod returns the dev fallback (explicit and defaulted).

## Part 2 — Sentry error tracking (`apps/web`)

Standard `@sentry/nextjs`, auto-disabled when `SENTRY_DSN` is unset.
- `apps/web/instrumentation.ts`: `register()` initializes Sentry for the Node + edge
  runtimes; export the Next-16 `onRequestError` hook (captures route handler / RSC /
  server-action errors).
- `apps/web/instrumentation-client.ts`: browser `Sentry.init`.
- `apps/web/src/app/global-error.tsx`: render-error boundary that reports to Sentry.
- `next.config.ts`: wrap export in `withSentryConfig`; **source-map upload disabled** for
  now (no `SENTRY_AUTH_TOKEN` dependency) — deferred as optional polish.
- `Sentry.init` receives `dsn: process.env.SENTRY_DSN` → when unset the SDK is inert, so
  no env branching is needed and dev/e2e/TEST_MODE are unaffected.
- Exact API surface (file names, `withSentryConfig` options, `onRequestError` signature)
  confirmed against the current `@sentry/nextjs` docs during planning — this is the part
  most sensitive to SDK version.
- **Verification**: build + typecheck pass; manual throw-route check with a real DSN (can't
  e2e — disabled without DSN). Documented as manual-verify.

## Part 3 — Rate-limiting (Upstash Redis, `apps/web`)

Deps `@upstash/ratelimit` + `@upstash/redis`; env `UPSTASH_REDIS_REST_URL` +
`UPSTASH_REDIS_REST_TOKEN`.
- Pure pieces in `@savvy/core` (`rate-limit-key.ts`, unit-tested): `rateLimitKey(bucket, id)`
  → `${bucket}:${id}`, and the per-bucket limit map (`leads` = 10/60s, `crew-pin` = 5/60s).
- `apps/web/src/lib/rate-limit.ts` (the IO wrapper, imports the pure pieces from core):
  - Lazily builds a singleton `Redis` + sliding-window `Ratelimit` ONLY when both env vars
    are present; otherwise the module is in "disabled" mode.
  - `checkRateLimit(bucket: string, id: string): Promise<{ ok: boolean }>`:
    - disabled mode (no env) → `{ ok: true }` (fail-open; dev/e2e unaffected);
    - on a limiter/Redis error → `{ ok: true }` + a single warning log (fail-open:
      availability over strict limiting; a limiter outage must not break lead capture);
    - else the real sliding-window decision, keyed by `rateLimitKey(bucket, id)`.
- Client IP from the `x-forwarded-for` header (first hop; Vercel sets it), falling back to
  `"unknown"`.
- Applied at exactly two call sites:
  - `apps/web/src/app/api/leads/route.ts`: before processing, `checkRateLimit("leads", `${key}:${ip}`)`;
    on `!ok` return **HTTP 429** `{ error: "rate_limited" }`.
  - `apps/web/src/lib/crew-actions.ts` `crewLogin(key, pin)`: before the PIN check,
    `checkRateLimit("crew-pin", `${key}:${ip}`)`; on `!ok` return
    `{ error: "too many attempts" }`. (IP via `headers()` from `next/headers`.)
- **Tested** (the testable parts): `rateLimitKey` is pure; `checkRateLimit` in disabled
  mode returns `{ ok: true }`. (These are web-layer; per the project's apps/web =
  Playwright-only rule, put the pure `rateLimitKey` + the limit map in a place that can be
  unit-tested — see "Testing note" below.) Live Redis limiting is manual/integration.

## Part 4 — Structured logging (`apps/web`)

- Pure formatter in `@savvy/core` (`log-format.ts`, unit-tested):
  `formatLog(level, msg, ctx, time): string` → `JSON.stringify({ level, msg, time, ...ctx })`
  (`time` passed in as an ISO string so the function is pure/testable).
- `apps/web/src/lib/log.ts` (~20 lines, no dep): `log.info/warn/error(msg, ctx?)` thin
  wrappers that call `formatLog(level, msg, ctx, new Date().toISOString())` and
  `console[...]` the result. Vercel captures stdout/stderr.
- `ctx` carries optional `requestId`, `tenantId`, `route` (plain fields, no PII beyond ids).
- Applied to the public/webhook routes and their error paths, replacing ad-hoc `console.*`:
  `/api/leads`, `/api/stripe/webhook`, `/api/docuseal/webhook`, `/api/companycam/webhook`,
  `/api/clerk/webhook`, `/api/twilio/*`, and `crewLogin`. (Light touch — log request
  receipt + errors; don't over-instrument.)
- **Tested**: `formatLog` is pure → unit-tested.

## Testing note (apps/web is Playwright-only)
`apps/web` has no vitest. The pure helpers introduced here (`rateLimitKey` + the limit map,
`formatLog`) need a unit-test home. Put them in a **new tiny `@savvy/core` module each**
(`rate-limit-key.ts`, `log-format.ts`) — pure functions, unit-tested there — and have the
`apps/web` modules import + wrap them with the IO (Redis client, console). `requireSecret`
(Part 1) is already in `@savvy/core`. This keeps every piece of real logic tested while the
web layer stays the thin IO wrapper, consistent with the rest of the codebase.

## New environment (documented, not committed)
Add to `.env.example` and `.env.production.example`:
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (rate-limiting; absent → disabled).
- `SENTRY_DSN` already present; add a comment that absence disables Sentry. `SENTRY_AUTH_TOKEN`
  noted as optional/future (source-map upload).

## Out of scope (deferred)
- Sentry source-map upload + release tracking (needs build-time auth token).
- Rate-limiting the HMAC-verified webhooks (signature check already rejects forgeries) and
  the `/intake` page; add later if abuse appears.
- pino / log drains / a hosted log pipeline beyond Vercel's stdout capture.
- Langfuse AI-observability wiring (separate concern; keys already reserved in env).
- WAF/edge rate rules (chose app-level Upstash for per-tenant/per-PIN granularity).

## Risks / honest constraints
- **Sentry wiring is SDK-version-sensitive** — `instrumentation*.ts` + `withSentryConfig`
  shape must be confirmed against the installed `@sentry/nextjs` version at plan time.
- **Rate-limiting is fail-open** — if Upstash is unconfigured or down, there is NO throttle
  (by design). The protection only exists once the Upstash env is set in prod; the runbook
  must list it as required for the limit to be active.
- **Sentry + live rate-limit can't be e2e-tested** (disabled without their env, which is the
  e2e condition) — both have manual-verify steps.
- `x-forwarded-for` can be spoofed by a client, but on Vercel the platform sets the
  left-most hop; for pilot-scale abuse mitigation this is adequate (not a security control).
