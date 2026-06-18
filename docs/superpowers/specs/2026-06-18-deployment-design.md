# Deployment / Infra — Design Spec (2026-06-18)

The second production-readiness sub-project (after Auth & provisioning, PR #26). Makes
Savvy deployable to a real, internet-reachable production environment so the first
pilot roofing companies can use it. The other two sub-projects (onboarding UX,
hardening/observability) are separate specs.

## Goal
A running production Savvy on a managed stack: web app on Vercel, Postgres on Neon
(RLS enforced via a non-superuser role), durable workflows on Inngest Cloud, files on
Cloudflare R2, AI direct to Anthropic. Done-when: `GET /api/health` returns
`{status:"ok", db:"up", commit:<sha>}` on the production domain, a brand-new sign-up
auto-provisions a tenant and reaches `/dashboard`, and firing a lead produces a visible
agent run.

## What this sub-project is (and is NOT)
This is **config-as-code + a runbook**, not an executable build. Most of the work is
Brett's hands: creating accounts (Neon/Vercel/Inngest/Cloudflare), pasting secrets,
pointing DNS, and wiring third-party webhooks to the production domain. The repo's job
is to make every dependency the deploy needs **explicit, version-controlled, and
verifiable** — and to give the human a precise, ordered runbook. There is deliberately
no subagent execution plan.

## Topology (chosen)
**Vercel + Neon + Inngest Cloud + Cloudflare R2 + Anthropic-direct.**

| Concern            | Choice                | Why |
|--------------------|-----------------------|-----|
| Web/app            | Vercel (Root = `apps/web`) | Native Next.js 16; monorepo-aware; preview deploys. |
| Postgres           | Neon                  | Serverless Postgres, branchable; RLS works with a non-superuser role. |
| Durable workflows  | Inngest Cloud         | The agent runtime; `serve()` route already exists at `/api/inngest`. |
| File storage       | Cloudflare R2         | Already integrated (6A presigned PUT); cheap egress. |
| AI                 | Anthropic-direct      | Skip deploying LiteLLM (see below). |
| Auth               | Clerk (prod instance) | Already the identity authority (PR #26). |

### Key simplification — skip deploying LiteLLM
The `@savvy/ai` gateway is env-aware (PR #23): when `LITELLM_BASE_URL` contains
`api.anthropic.com`, capability tiers resolve to real Claude model ids
(`resolveModel`/`isAnthropicGateway` in `packages/ai/src/capabilities.ts`). So for
pilots we set `LITELLM_BASE_URL=https://api.anthropic.com/v1` +
`LITELLM_API_KEY=<anthropic key>` and ship — **no LiteLLM container to deploy**. A
LiteLLM router (logical model names, multi-provider, cost controls) is a later add: point
the same two env vars at it, no code change.

## Non-negotiables honored
- **Tenant isolation**: the app connects as the non-superuser `savvy_app` role on Neon
  (RLS enforced). `scripts/prod-bootstrap.sql` creates that role; `pnpm db:migrate`
  re-applies the per-table grants from `rls-grants.sql`. Migrating/connecting as the
  Neon owner would silently bypass RLS — the bootstrap script and runbook call this out.
- **No secrets in repo**: only `.env.production.example` (a manifest, no values) is
  committed. `TEST_MODE` is intentionally absent from it.
- **Webhooks fail closed in prod**: Clerk/DocuSeal/CompanyCam/Stripe webhooks already
  require their signing secrets in production; the env manifest marks each REQUIRED.
- **Durable, not fire-and-forget**: AI/multi-step work stays in Inngest Cloud; Vercel
  route handlers stay quick (so a 60s function ceiling is just a safety net).

---

## In-repo artifacts (this PR)

1. **`apps/web/src/app/api/health/route.ts`** — public liveness probe. `force-dynamic`,
   runs `SELECT 1` via the **app `pool`** (`DATABASE_URL`/`savvy_app` — the real request
   connection; `SELECT 1` needs no grants), returns `{status, db, commit}` (commit from
   `VERCEL_GIT_COMMIT_SHA`), 503 on DB failure. NOT `adminPool` — `DATABASE_ADMIN_URL`
   isn't set on the deploy, so probing it would false-negative. Added `/^\/api\/health$/`
   to `middleware.ts` PUBLIC so it isn't Clerk-gated.

2. **`apps/web/vercel.json`** — minimal. `framework: nextjs` + a `functions` glob
   `app/api/**/*` → `maxDuration: 60`. Lives at `apps/web/vercel.json` (NOT repo root)
   because the Vercel Root Directory is `apps/web`; a repo-root `vercel.json` would be
   ignored. The glob form `app/api/**/*` is Vercel's documented Next.js App Router
   pattern (the builder normalizes the `src/` prefix away); a glob that matches nothing
   would fail the build, so the path was doc-verified.

3. **`scripts/prod-bootstrap.sql`** — one-time Neon setup: create the non-superuser
   `savvy_app` role + CONNECT/USAGE grants (mirrors `docker/initdb/01-roles.sql`, which
   Neon does not auto-run). Per-table grants intentionally NOT here — they live in
   `rls-grants.sql` and are re-applied by `db:migrate` on every run (so new tables from
   later migrations are auto-covered).

4. **`.env.production.example`** — the full env manifest grouped by concern, Anthropic-
   direct AI, `TEST_MODE` absent, every dev `dev-*` fallback (`UNSUBSCRIBE_SECRET`,
   `CREW_SESSION_SECRET`, webhook secrets) flagged REQUIRED.

5. **`docs/DEPLOYMENT.md`** — the human runbook (ordered steps + smoke test).

## Runbook summary (full detail in docs/DEPLOYMENT.md)
1. **Neon**: create project → run `prod-bootstrap.sql` as owner → set a strong
   `savvy_app` password → capture `DATABASE_URL` (savvy_app, pooled) +
   `DATABASE_ADMIN_URL` (owner).
2. **Migrate**: `DATABASE_ADMIN_URL=<neon owner> pnpm db:migrate` MANUALLY from your
   machine (no auto-migrate-on-deploy for pilots). It runs migrations + re-applies grants.
3. **Inngest Cloud**: create app → `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` →
   register synced URL `https://<domain>/api/inngest`.
4. **Cloudflare R2**: create bucket → access keys → R2 env.
5. **Clerk**: production instance, Organizations ON → pk_live/sk_live → webhook to
   `/api/clerk/webhook` → `CLERK_WEBHOOK_SECRET`.
6. **Vercel**: import repo, Root Directory `apps/web`, paste env from
   `.env.production.example`, deploy. Then point custom domain.
7. **Wire prod webhooks**: Clerk, Stripe, DocuSeal, CompanyCam, Twilio → prod domain.
8. **Smoke test**: `/api/health` green → sign up → auto-provision → fire a lead →
   agent run appears in Command Center.

## Out of scope (other sub-projects)
- Sentry / rate-limiting / structured logging → hardening/observability sub-project.
- Onboarding wizard + landing page → onboarding UX sub-project.
- LiteLLM router deployment → later, when multi-provider routing/cost-control is needed.
- Auto-migrate-on-deploy / migration CI gating → deferred (manual migrate for pilots is
  safer; revisit when tenant count grows).

## Risks / honest constraints
- **Most of this is Brett's hands.** The agent can produce config + runbook only; it
  cannot create accounts, hold secrets, or set DNS.
- **Real third-party shapes unvalidated in prod**: DocuSeal/CompanyCam/QBO gateways are
  fake-backed until their keys are set and were sandbox/best-effort validated — confirm
  against live instances during the smoke test.
- **Neon pooled vs direct**: app uses the pooled connection string; long-lived admin
  operations (migrate) use a direct/owner string. The runbook specifies which is which.
- **`vercel.json` glob**: if a future refactor moves API routes out of `app/api`, the
  glob would match nothing and fail the build — keep them under `app/api`.
