# CLAUDE.md — Savvy

This file is the standing brief for every Claude Code session in this repo. Read it before doing anything. If a task conflicts with the non-negotiables below, stop and flag it.

## What Savvy is
Savvy is a **multi-tenant SaaS that runs a roofing company's operations with AI agents.** Each customer (a roofing company) is a tenant. The product is an agent-driven operations layer over the full job lifecycle (lead → inspect → estimate → approve → produce → close → bill). The defensible value is the **orchestration + the unified UI + the data**, not the integrations. Insurance-supplement intelligence (SupplementIQ) is a separate premium add-on — build the core CRM first.

Pricing is by **revenue band, unlimited seats** (usage scales cost; revenue is the proxy). Target gross margin 70%+. Cost discipline matters: prefer self-hostable open-source for infra.

## Architecture (the stack)
- **Frontend:** Next.js (App Router) + TypeScript + Tailwind + shadcn/ui.
- **Backend:** Next.js route handlers / server actions; TypeScript everywhere.
- **DB:** Postgres (Supabase/Neon in dev) + **Drizzle ORM**. Multi-tenant via row-level security.
- **Auth:** Clerk (Organizations = tenants). Every request resolves a `tenantId` from the active org.
- **Orchestration / agents:** **Inngest** — every multi-step or async process is a durable workflow, never a fire-and-forget call.
- **AI gateway:** **LiteLLM** (self-hosted). App calls models through the gateway via the Vercel AI SDK. **Never hard-wire a provider/model in feature code** — request a capability ("cheap-classify", "reason", "embed") and let the gateway route (Gemini Flash for volume, Claude for judgment, Voyage for embeddings).
- **Integrations:** Nango for third-party OAuth (QuickBooks, CompanyCam, etc.). Twilio (voice/SMS), Stripe (payments), Cloudflare R2 (files), DocuSeal (e-sign), Roofr (measurement).
- **Testing:** Vitest (unit/integration) + Playwright (e2e).
- **Tooling:** pnpm + Turborepo.

## Repo structure (monorepo)
```
apps/web            Next.js app (UI + API)
packages/db         Drizzle schema, migrations, RLS policies, seed
packages/agents     Inngest functions (the 5 agent domains)
packages/integrations  Twilio, Stripe, Nango, Roofr, R2, DocuSeal wrappers
packages/ai         LiteLLM client + capability router helpers
packages/ui         shared shadcn components
packages/core       shared types, zod schemas, domain logic
```

## Non-negotiables (do not violate without flagging)
1. **Tenant isolation on every table and every query.** Each table has `tenant_id`. Postgres RLS policies enforce `tenant_id = current_setting('app.tenant_id')::uuid`. Every request sets the tenant context. No raw query bypasses RLS. There is a test suite that asserts cross-tenant reads return nothing — keep it green.
2. **All AI calls go through the gateway** by capability, never a hard-coded model string in feature code.
3. **Anything multi-step or async is an Inngest workflow** with retries + idempotency keys — not an un-awaited promise.
4. **No secrets in the repo.** Everything via env (`.env.local` git-ignored). Document required env in `.env.example`.
5. **Integrate commodities, don't rebuild them** (telephony, payments, accounting, e-sign, measurement). Build only orchestration, UI, data model, and Savvy-specific logic.
6. **Every feature ships with tests** and passes typecheck + lint before commit.
7. **Accessibility + the design system**: clean, flat, shadcn defaults; no hardcoded colors that break dark mode.

## Data model
See `DATA-MODEL.md`. Core entities: tenant, user, customer, property, lead, job, job_task, communication, appointment, estimate, invoice, payment, document, measurement, agent_run, audit_log. Insurance entities (carrier, claim, supplement) are stubbed for the add-on.

## The 5 agents (= workflow domains, not chatbots)
orchestrator (task state/assignment/pipeline) · comms · scheduling · finance · claims(add-on). Each is a set of Inngest functions + a model-routing policy + its integrations.

## Commands
- `pnpm install` · `pnpm dev` (web + inngest dev) · `pnpm test` · `pnpm typecheck` · `pnpm lint`
- `pnpm db:generate` (migrations) · `pnpm db:migrate` · `pnpm db:seed`

## Definition of done (per task)
- [ ] Plan written and approved before coding
- [ ] Feature behind tenant scope; RLS verified by test
- [ ] AI via gateway by capability; workflows durable + idempotent
- [ ] Unit/integration tests written and passing; typecheck + lint clean
- [ ] `.env.example` updated if new config; no secrets committed
- [ ] Small, reviewed commit/PR with a clear summary

## Working style
Plan first (use plan mode), build a vertical slice before breadth, one workflow per task, small commits, review diffs. When unsure about scope or a non-negotiable, ask before coding.
