# Command Center — customer name on agent activity

**Date:** 2026-06-30
**Status:** Approved

## Problem

The command-center Agent Activity feed shows a `target` (customer name) per run, but
only resolves it through `agent_run.jobId → job.customerId → customer.name`. Most agent
activity is lead-stage (AI receptionist qualifying leads, speed-to-lead rep alerts, drip
texts, booking SMS) and has **no job yet**, so `agent_run.jobId` is null and the customer
name renders blank — exactly the runs the user wants to see attributed.

## Goal

Show the customer name for lead-stage agent runs too, as plain text in the existing feed.

## Design

### 1. Schema (migration `0036`)
Add `lead_id uuid` (nullable, FK → `lead.id`) to `agent_run`. RLS already covers the table;
no policy change. Existing rows stay `null` (no backfill — historical runs simply show no name).

### 2. Write path
`recordAgentRun` gains an optional `leadId`. Thread the in-scope lead id into the lead-stage
call sites that pass nothing today:
- `lead-intake.ts` (×3)
- `lead-speed-to-lead.ts`
- `voice-fallback.ts` (×2)
- `drip.ts` (raw `agentRun` insert)

Job-stage calls (e.g. `auto-order-measurement`) are unchanged.

### 3. Feed query → moved into `@savvy/db`
A run links to a customer through **either** `job.customerId` **or** `lead.customerId`.
New `listAgentActivity(tenantId, limit)` lifecycle function left-joins both paths (the
`customer` table aliased twice) and selects `target = coalesce(jobCustomer.name, leadCustomer.name)`,
newest-first, limited.

Moved out of `apps/web/src/lib/command-center-queries.ts` because `apps/web` is not in the
Vitest workspace; `packages/db` has the real-Postgres integration harness, so the join and
tenant isolation become testable. The apps/web `getAgentActivity` becomes a thin delegate.

### 4. UI
The feed already renders `r.target` (`command-center/page.tsx:99`); it just stops being blank
for lead-stage runs. Plain text (no link). Minimal/no JSX change.

## Testing (TDD, `packages/db`)
- `recordAgentRun` persists `leadId`.
- `listAgentActivity` returns the customer name for a **lead-linked** run, still returns it for
  a **job-linked** run, and `null` when a run has neither.
- Cross-tenant isolation: tenant A cannot see tenant B's activity.

## Out of scope
- Making the name a clickable link to the lead/customer (clean future add).
- Backfilling `lead_id` on historical `agent_run` rows.
