# Savvy

Multi-tenant SaaS that runs a roofing company's operations end to end — lead → inspect → estimate → approve → produce → close → bill. Each customer (a roofing company) is a tenant. Ships with **Savvy Canvass**, an offline-first door-knocking PWA for storm-restoration field sales.

SupplementIQ (insurance-supplement intelligence) is a separate premium add-on.

---

## Stack

| Layer | Technology |
|---|---|
| App + API | Next.js (App Router), TypeScript, Tailwind, shadcn/ui |
| Database | Postgres (Supabase) + Drizzle ORM — **multi-tenant via row-level security** |
| Auth | Clerk (Organizations = tenants) for the CRM; signed bearer + PIN for the field app |
| Durable jobs | Inngest (every async/multi-step process is a workflow, never fire-and-forget) |
| Rate limiting | Upstash Redis |
| AI | LiteLLM gateway, requested by capability — never a hard-coded model in feature code |
| Integrations | Twilio, Stripe, Cloudflare R2, DocuSeal, Roofr, Nango, StormProof |
| Tests | Vitest (unit/integration) + Playwright (e2e) |
| Tooling | pnpm + Turborepo |

**Hosting:** CRM/API on Vercel · canvass PWA on Cloudflare Pages · StormProof API on Railway.

### Tenant isolation (the core invariant)
Every tenant-scoped table carries `tenant_id` with a Postgres RLS policy bound to the non-superuser `savvy_app` role. All DB access goes through `withTenant(tenantId, tx => …)`, which sets the `app.tenant_id` GUC for the transaction. No query bypasses RLS. See `CLAUDE.md` → Non-negotiables.

---

## Repo layout

```
apps/web                 Next.js app (UI + API route handlers)
packages/db              Drizzle schema, migrations, RLS policies, lifecycle fns, seed
packages/agents          Inngest functions (the durable workflow domains)
packages/integrations    Twilio, Stripe, R2, DocuSeal, Roofr, StormProof wrappers
packages/ai              LiteLLM client + capability router helpers
packages/core            Shared types, zod schemas, pure domain logic
packages/ui              Shared shadcn components
docs/superpowers/        Design specs + implementation plans, one per shipped slice
```

The **canvass field app** lives in a separate repo (`savvy-canvass`) — a deliberately dependency-free vanilla-JS PWA (single HTML file + service worker) so it installs instantly and keeps working with no signal at a door.

---

## Running locally

**Prerequisites:** Node 20+, pnpm, Docker (for local Postgres).

```bash
pnpm install
cp .env.example .env.local        # fill in the values you need
pnpm db:up                        # start local Postgres in Docker
pnpm db:migrate                   # apply migrations
pnpm db:seed                      # optional: seed demo data
pnpm dev                          # Next.js + Inngest dev server
```

`.env.example` documents every required variable. The app degrades gracefully when optional integrations are unset (e.g. no Upstash → rate limiting disabled; no StormProof key → certificates return unverified).

### Common commands

```bash
pnpm typecheck                    # all packages
pnpm lint
pnpm test                         # vitest
pnpm db:generate                  # generate a migration after a schema change
```

**DB tests share one local Postgres** — run them serially:

```bash
npx vitest run --no-file-parallelism
```

---

## Deploying

- **CRM/API:** `npx vercel --prod --archive=tgz --force` (deploys the working tree).
- **Migrations:** generated locally with `pnpm db:generate`, applied to production via the Supabase MCP `apply_migration`. Verify the local migration number against production before applying — the two can drift.
- **Canvass PWA:** `npx wrangler pages deploy .` from the `savvy-canvass` repo. Bump `APP_VERSION` **and** the service-worker cache version `V` together, or clients won't pick up the release.

---

## Canvass (field app) at a glance

Reps sign in with a company code + name + PIN, then knock doors offline-first:

- **Map + territories** — verified storm swaths (hail/wind) and target zones cross-referenced with county-assessor roof age.
- **Storm certificates** — a verified, homeowner-shareable storm record mintable at any door, backed by a full evidentiary PDF.
- **Contracts at the door** — signature capture that creates a CRM lead + stored document.
- **Gamification** — points/tiers/streaks derived from knocks, head-to-head challenges, and a spiff ledger.
- **Digital rep ID** — a public QR page showing the rep's identity, license, and insurance, with homeowner capture.
- **Alerts** — e.g. a sale sitting 30 minutes with no signed contract notifies the rep and every manager.

Design specs and implementation plans for each of these live in `docs/superpowers/`.

---

## Docs

- `CLAUDE.md` — architecture, conventions, non-negotiables, definition of done
- `DATA-MODEL.md` — core schema, RLS, enums
- `ROADMAP.md` — phased build plan
- `docs/superpowers/specs/` · `docs/superpowers/plans/` — per-feature design + build plans
- `docs/BUILD-PROMPT-phase0-slice.md` — original scaffold prompt
