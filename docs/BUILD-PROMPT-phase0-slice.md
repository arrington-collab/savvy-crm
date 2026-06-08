# Claude Code build prompt — Phase 0 + Vertical Slice

Paste this into Claude Code in an empty repo. Drop `CLAUDE.md`, `DATA-MODEL.md`, and `ROADMAP.md` into the repo root first so it has the full brief.

---

You are building **Savvy**, a multi-tenant SaaS that runs roofing operations with AI agents. Read `CLAUDE.md`, `DATA-MODEL.md`, and `ROADMAP.md` in the repo root — they are the source of truth. Follow every non-negotiable in CLAUDE.md.

**Work in two stages. Plan before you code. Do not start coding until I approve the plan.**

## Stage 1 — Phase 0 foundation
Scaffold a runnable, multi-tenant, tested skeleton:

1. **Monorepo**: pnpm + Turborepo with packages exactly as in CLAUDE.md (`apps/web`, `packages/{db,agents,integrations,ai,ui,core}`).
2. **Web app**: Next.js (App Router) + TypeScript + Tailwind + shadcn/ui. App shell with a left nav (Dashboard, Jobs, Leads, Schedule, Billing) — stubs are fine.
3. **Auth + tenancy**: Clerk with Organizations. Middleware resolves the active org → `tenantId`, and a DB helper sets `SET app.tenant_id` per request/transaction.
4. **Database**: Postgres + Drizzle. Implement the **full core schema** from DATA-MODEL.md (skip the insurance add-on tables except as commented stubs). Enable **RLS with the tenant_isolation policy on every table**.
5. **Inngest**: dev server wired; one no-op example function to prove the pipeline.
6. **AI gateway**: `packages/ai` exposes a capability-based client (`complete({capability})`, `embed()`) that calls a LiteLLM endpoint from env. No model strings in app code.
7. **CI**: GitHub Actions running `pnpm typecheck`, `pnpm lint`, `pnpm test` on push. Add `.env.example` with every required var.
8. **Seed**: script creating 2 demo tenants, users, customers, properties, and a few jobs across stages.
9. **Isolation test (required)**: a Vitest integration test that seeds two tenants, sets context to tenant A, and asserts tenant B's rows are invisible to select/update/delete.

**Stage 1 done when:** app boots, two orgs see only their own data, the isolation test passes, CI is green. Commit.

## Stage 2 — Vertical slice (lead → booked job)
Build one lane end to end through every layer:

1. **Lead intake**: a public web form (name, phone, address, source) that creates a `lead` (+ customer/property) under the right tenant. Also accept an inbound Twilio webhook that creates a lead from a call.
2. **Inngest workflow `lead.intake`** (durable, idempotent): on new lead →
   a. **AI qualify** via the gateway (capability: `cheap-classify`) → set `lead.score` and a short reason.
   b. **Auto-SMS** the homeowner via Twilio with a booking link (log to `communication`, `ai_handled=true` if after-hours).
   c. On booking, create an `appointment` and **convert the lead into a `job`** at stage `lead`/`inspected`, visible on the pipeline.
   d. Record an `agent_run` (agent=`comms`/`orchestrator`) with status + model used.
3. **Dashboard**: turn the mockup into a real page — metric cards + the active-pipeline counts (live from `job` by stage) + an "agents" status strip. Read live data, tenant-scoped.
4. **Tests**: unit tests for the workflow steps (mock Twilio + gateway) and a Playwright e2e: submit the form → workflow runs → SMS logged → appointment + job appear on the pipeline.

**Stage 2 done when:** the e2e passes end to end and the dashboard reflects the new job. Commit.

## Rules of engagement
- **Plan first** — output the file tree, package choices, schema migration plan, and the workflow design; wait for my approval.
- Tenant scope + RLS on everything; AI only via the gateway by capability; multi-step logic only as Inngest workflows with idempotency keys.
- Mock external services (Twilio, LiteLLM) in tests; never call real APIs in CI.
- Small commits with clear messages; keep typecheck/lint/tests green at each commit.
- No secrets committed; update `.env.example` for any new config.
- If anything conflicts with CLAUDE.md or is ambiguous, stop and ask before coding.

Start by proposing the plan.
