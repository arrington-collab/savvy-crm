# Savvy — Production Deployment Runbook

How to stand up a production Savvy for pilots. Topology:
**Vercel (web) + Neon (Postgres) + Inngest Cloud (workflows) + Cloudflare R2 (files) + Anthropic-direct (AI) + Clerk (auth).**

This is mostly account setup, secrets, and DNS — done by a human. The repo provides the
config-as-code: `apps/web/vercel.json`, `scripts/prod-bootstrap.sql`,
`.env.production.example`, and the `/api/health` probe. Design rationale lives in
`docs/superpowers/specs/2026-06-18-deployment-design.md`.

> **Golden rule (tenant isolation):** the app connects to Postgres as the
> **non-superuser `savvy_app`** role. RLS only enforces against a non-superuser.
> Never point `DATABASE_URL` at the Neon owner. Only `pnpm db:migrate` uses the owner.

---

## 0. Prereqs
- Accounts: Vercel, Neon, Inngest Cloud, Cloudflare (R2), Clerk, plus the integration
  vendors you're enabling (Stripe, Twilio, DocuSeal, Roofr, CompanyCam, Resend, Anthropic).
- Local clone with `pnpm install` working and `psql` available.
- A copy of `.env.production.example` open — it's the checklist of every key to set.

Generate secrets with: `openssl rand -base64 32`

---

## 1. Neon (Postgres)
1. Create a Neon project. Note the database name (Neon often defaults to `neondb` — if so,
   replace `savvy` with `neondb` everywhere below).
2. Grab two connection strings from the Neon dashboard:
   - **Owner / direct** (role = your Neon owner): used for `DATABASE_ADMIN_URL`.
   - **Pooled** (`-pooler` host): used for `DATABASE_URL` once `savvy_app` exists.
3. Create the non-superuser app role (one time), as the owner:
   ```bash
   psql "postgres://<owner>:<pw>@<project>.<region>.aws.neon.tech/savvy?sslmode=require" \
     -f scripts/prod-bootstrap.sql
   ```
4. Set a strong password for `savvy_app` and remember it:
   ```bash
   psql "$DATABASE_ADMIN_URL" -c "ALTER ROLE savvy_app WITH PASSWORD '<strong-secret>';"
   ```
5. Build the app connection string (pooled host, savvy_app role):
   `DATABASE_URL=postgres://savvy_app:<strong-secret>@<project>-pooler.<region>.aws.neon.tech/savvy?sslmode=require`

---

## 2. Migrate (manual, from your machine)
No auto-migrate-on-deploy for pilots — run it deliberately:
```bash
DATABASE_ADMIN_URL="postgres://<owner>:<pw>@<project>.<region>.aws.neon.tech/savvy?sslmode=require" \
  pnpm db:migrate
```
This applies all Drizzle migrations **and** re-applies `packages/db/src/rls-grants.sql`
(grants ON ALL TABLES → new tables auto-covered). Expect the tail line
`migrations + grants applied`. Optionally seed the task lifecycle / defaults if a pilot
needs them (`pnpm db:seed` — review what it inserts first; it's dev-oriented).

> Re-run migrations the same way after every schema change you ship.

---

## 3. Inngest Cloud (durable workflows)
1. Create an Inngest Cloud app.
2. Copy `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`.
3. After the Vercel deploy exists (step 6), register the synced URL:
   `https://<your-domain>/api/inngest` (the `serve()` route already exists). Inngest will
   discover all functions there. The crons (`meterUsageMonthly`, `coldArchiveDocuments`)
   register automatically.

---

## 4. Cloudflare R2 (files)
1. Create a bucket (e.g. `savvy-documents`).
2. Create an R2 API token (access key id + secret).
3. Capture `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.

---

## 5. Clerk (auth) — production instance
1. Create/switch to a **production** Clerk instance; **enable Organizations**.
2. Copy `pk_live_...` → `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `sk_live_...` → `CLERK_SECRET_KEY`.
3. Webhook is wired in step 7 (needs the live domain first).

---

## 6. Vercel (web app)
1. Import the GitHub repo into Vercel.
2. **Root Directory = `apps/web`.** (Vercel reads `apps/web/vercel.json`; it auto-detects
   Next.js + pnpm + the Turborepo workspace.)
3. Add every env var from `.env.production.example` under **Production** (and Preview if you
   want preview deploys to work). Double-check:
   - `TEST_MODE` is **NOT set** (it disables auth + tenant isolation).
   - All `*_WEBHOOK_SECRET`, `UNSUBSCRIBE_SECRET`, `CREW_SESSION_SECRET` have **real**
     generated values (no `dev-*` fallbacks).
   - `LITELLM_BASE_URL=https://api.anthropic.com/v1` + `LITELLM_API_KEY=sk-ant-...`.
4. Deploy. Then add your custom domain (e.g. `app.yourdomain.com`) and set `APP_BASE_URL`
   to it (redeploy if you changed it after the first build).

---

## 7. Wire production webhooks (point each vendor at the live domain)
| Vendor      | Endpoint                          | Secret env                 | Posture |
|-------------|-----------------------------------|----------------------------|---------|
| Clerk       | `/api/clerk/webhook`              | `CLERK_WEBHOOK_SECRET`     | 401s without it (fail-closed) |
| Stripe      | `/api/stripe/webhook`            | `STRIPE_WEBHOOK_SECRET`    | signature-verified |
| DocuSeal    | `/api/docuseal/webhook`          | `DOCUSEAL_WEBHOOK_SECRET`  | HMAC when set |
| CompanyCam  | `/api/companycam/webhook`        | `COMPANYCAM_WEBHOOK_SECRET`| fail-closed in prod |
| Twilio      | voice/inbound → `/api/twilio/*`  | (uses `TWILIO_AUTH_TOKEN`) | per-route |

Register each in the vendor dashboard against `https://<your-domain>` and paste the
signing secret into the matching Vercel env, then redeploy so the secret is live.

---

## 8. Smoke test (production)
1. **Health**: `curl -s https://<domain>/api/health` → `{"status":"ok","db":"up","commit":"<sha>"}`.
   `db:"down"` ⇒ `DATABASE_URL` wrong or `savvy_app` missing/unprivileged.
2. **Auth + provisioning**: sign up → create an organization → land on `/dashboard` with no
   500 (a `tenant` row + owner `user` row now exist).
3. **Agents alive**: create/fire a lead → within a few seconds a lead-qualify **agent run**
   appears in `/command-center` (confirms Inngest Cloud is registered and AI resolves to
   Claude). If nothing appears, check the Inngest Cloud dashboard for the synced app +
   recent runs.
4. **Team**: invite a teammate from `/settings/team`; confirm the Clerk webhook syncs the
   new `user` row.

---

## Troubleshooting
- **`/api/health` says db down**: app role/connection wrong. Re-check `DATABASE_URL` uses
  `savvy_app` + pooled host; confirm `prod-bootstrap.sql` ran and the password matches.
- **Every authed page 500s on first login**: provisioning didn't run — confirm Clerk keys
  are the prod instance and Organizations is enabled.
- **Agent runs never appear**: Inngest app URL not registered, or `INNGEST_SIGNING_KEY`
  missing. Re-register `https://<domain>/api/inngest`.
- **Webhook 401s**: the matching `*_WEBHOOK_SECRET` is unset or mismatched (these fail
  closed in prod by design).
- **AI errors / no Claude output**: `LITELLM_BASE_URL` must contain `api.anthropic.com`
  and `LITELLM_API_KEY` must be a valid `sk-ant-` key.
- **Build fails on `vercel.json` functions pattern**: only happens if API routes were moved
  out of `app/api` — keep route handlers under `apps/web/src/app/api`.

## What's deliberately NOT here (other sub-projects)
- Sentry / error tracking, rate-limiting public+webhook routes, structured logging →
  **hardening/observability** sub-project.
- Onboarding wizard + marketing landing page → **onboarding UX** sub-project.
- LiteLLM router deployment → add later for multi-provider routing/cost control.
