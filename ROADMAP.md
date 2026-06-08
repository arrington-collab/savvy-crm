# Savvy — Phased Build Roadmap

Build in vertical slices. Don't go wide until the spine works end to end. Each phase has a goal, deliverables, and acceptance criteria (the "done" gate).

## Phase 0 — Foundation (get this right; everything rides on it)
**Goal:** a runnable, multi-tenant, tested skeleton.
- Monorepo (pnpm + Turborepo) per the structure in CLAUDE.md.
- Next.js + Tailwind + shadcn app shell; Clerk auth with Organizations = tenants.
- Postgres + Drizzle; the full core schema from DATA-MODEL.md; **RLS on every table**.
- Inngest wired (dev server); LiteLLM gateway config + `packages/ai` capability router; Nango placeholder.
- CI: typecheck + lint + Vitest on every push. `.env.example`. Seed script (2 demo tenants, users, sample jobs).
**Done when:** app boots, you can log in as two different orgs and see only your own data; the **cross-tenant isolation test passes**; CI is green.

## Phase 1 — Vertical slice + dashboard (prove the whole stack)
**Goal:** one lane works end to end through every layer.
- **Flow:** inbound lead (web form + Twilio inbound) → Inngest workflow → AI qualify (via gateway) → auto-SMS (Twilio) → book appointment (calendar) → **job created** and visible on the pipeline.
- The AI receptionist can start as after-hours/overflow stub; real voice later.
- Turn the existing **mockup** into the real Dashboard (metrics + pipeline + the agent status strip), reading live data.
**Done when:** a lead submitted in the UI flows through the workflow to a booked appointment + a job on the pipeline, with the comms logged and an `agent_run` recorded — covered by an e2e test.

## Phase 2 — Jobs & pipeline core
Job record (timeline, tasks, docs, comms), pipeline board with drag-between-stages, `job_task` lifecycle seeded from the 212-task list, days-in-stage. **Done:** a job moves through stages, tasks auto-create/advance, analytics show days-in-stage.

## Phase 3 — Comms agent
Twilio voice (after-hours AI reception) + SMS drips + email (SES); templated + AI-drafted (gateway: Gemini volume / Claude nuanced); all logged to `communication`. **Done:** outbound drip + inbound capture + AI reception answering after hours, all durable workflows.

## Phase 4 — Scheduling agent
Appointment booking, calendar sync, crew/inspection scheduling, basic route clustering, reminders. **Done:** appointments created/synced, reminders fire, no double-booking.

## Phase 5 — Finance agent
Built-in invoicing (create/send/track), Stripe payments (card + ACH), AR/dunning workflows, QuickBooks integration (Nango) when present, commission calc. **Done:** invoice → payment → reconciled; overdue dunning runs automatically.

## Phase 6 — Production & close-out
Material order (Roofr/supplier), CompanyCam integration + in-app photo capture w/ sharing, crew check-in protocol, change orders, lien waivers/certs via DocuSeal, completion gating on required photos. **Done:** a job goes from approved → produced → closed with documents attached.

## Phase 7 — Measurement & retail estimate
Roofr ordering (pass-through +$3) → auto-generate retail estimate from measured areas + price book → e-sign. **Done:** Roofr report auto-produces a retail estimate that's ~98% complete, rep edits, customer e-signs.

## Phase 8 — Reporting & billing meters
Dashboards (pipeline, velocity, rep/team performance), usage metering (jobs processed, AI minutes, storage) → the revenue-band billing + overages. **Done:** per-tenant usage + the billing band compute correctly; storage cap + cold-archive enforced.

## Phase 9 — SupplementIQ add-on (insurance)
Wire the existing KB (kb_chunk/scope_chunk + vector + BM25), Claims agent, supplement detection, code lookup, carrier rebuttals, letters. **Done:** insurance jobs get supplement analysis + KB-cited letters as a toggleable premium module.

## Cross-cutting (every phase)
Multi-tenant RLS, AI via gateway, durable Inngest workflows, tests + typecheck gates, small reviewed commits, `agent_run` cost tracking, observability (Sentry + Langfuse).
