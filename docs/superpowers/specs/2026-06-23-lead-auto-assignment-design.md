# Configurable Lead Auto-Assignment — Design

**Date:** 2026-06-23
**Status:** Approved (brainstorming) → ready for implementation plan
**Author:** Claude (with Brett)

## Problem

Leads are assigned to reps **manually** (a dropdown on the lead detail → `assignLeadOwner`). New leads created via the form, the public `/api/leads` endpoint, or the AI intake all land **unassigned** until someone notices. There's no automatic routing, so leads sit unowned and reps don't know what's theirs.

## Goals

- Automatically assign a new lead to a rep as part of the existing `lead-intake` Inngest workflow (right after scoring, so score-based routing is possible).
- The **manager chooses the strategy** per tenant — no hardcoded policy. Support all four: round-robin, least-loaded, territory-based, score-based, plus "off".
- **Opt-in**: default `off`; nothing changes for a tenant until an admin enables it.
- **Never override a manual assignment** — only assign leads that are still unassigned.
- Surface the action in the Command Center (it's the orchestrator agent's job).

## Non-goals (v1)

- **Per-person "receives leads" toggle** — deferred. For round-robin/least-loaded the pool is all active `owner`/`admin`/`rep`; to exclude someone now, use territory/score (which name specific reps).
- Re-assignment / load-rebalancing of existing leads (only assigns at intake).
- Round-robin via a stored cursor (we use a stateless "least-recently-assigned" rule — no mutable counter, no race).
- Notifications to the assigned rep (a natural follow-up, not in scope here).

## Configuration

Stored in `tenant.settings.assignment` (jsonb; read-modify-write preserving sibling settings keys, same pattern as the lead-source store and onboarding):

```ts
type AssignmentConfig = {
  strategy: "off" | "round_robin" | "least_loaded" | "territory" | "score";
  territoryRules?: { state: string; city?: string; userId: string }[]; // most-specific (city+state) wins
  scoreTiers?: { minScore: number; userIds: string[] }[];              // highest minScore that lead meets wins
};
```
Absent/unset → treated as `{ strategy: "off" }`.

**Candidate pool** (computed live, never stored): active users (`deactivatedAt IS NULL`) with role in `("owner","admin","rep")`. Crew/office never receive leads.

## Architecture

```
lead/created → lead-intake (extended)
  load-lead → enrich-property → ai-qualify (score) → [NEW] assign-lead → send-sms

assign-lead step:
  if lead.assignedUserId != null → skip (manual owner wins)
  load AssignmentConfig from tenant.settings; if strategy "off" → skip
  load candidate pool + per-rep { openLeadCount, lastAssignedAt }  (one tenant-scoped query)
  userId = pickAssignee({ strategy, config, candidates, lead })      (pure, @savvy/core)
  if userId → setLeadOwner(tx, {tenantId, leadId, userId}) + recordAgentRun(orchestrator/lead.assign)
  else → leave unassigned
```

### Component boundaries

| Unit | Package | Responsibility |
|---|---|---|
| `AssignmentConfig` type + `parseAssignmentConfig` | `@savvy/core` | typed config + safe defaulting from `tenant.settings` |
| `pickAssignee` (+ strategy helpers) | `@savvy/core` | **pure**, deterministic rep selection; unit-tested per strategy |
| `getAssignmentCandidates` | `@savvy/db` | tenant-scoped query → `{ userId, role, openLeadCount, lastAssignedAt }[]` |
| `assign-lead` step | `@savvy/agents` | wires config + candidates + `pickAssignee` + `setLeadOwner` + agent_run, inside one durable step |
| `getAssignmentSettings` / `saveAssignmentConfig` | `@savvy/db` lifecycle | read + admin write of `tenant.settings.assignment` |
| `/settings/assignment` page + `LeadAssignmentSettings` | `apps/web` | strategy dropdown + territory/score editors |
| `saveAssignmentAction` | `apps/web` | `isOrgAdmin`-gated server action |

## The engine — `pickAssignee` (pure)

```ts
type Candidate = { userId: string; openLeadCount: number; lastAssignedAt: string | null };
pickAssignee(opts: {
  strategy: AssignmentConfig["strategy"];
  config: AssignmentConfig;
  candidates: Candidate[];
  lead: { state: string | null; city: string | null; score: number | null };
}): string | null
```

- **off** or empty `candidates` → `null`.
- **round_robin** → candidate with the oldest `lastAssignedAt` (`null` = never assigned, sorts first). Deterministic, stateless.
- **least_loaded** → lowest `openLeadCount`; tie → oldest `lastAssignedAt`.
- **territory** → restrict to `territoryRules` whose `state` (and `city` if present) match the lead, most-specific first; among the matched rule's `userId`(s) that are still in the candidate pool, pick least-loaded. **No match / matched rep inactive → fallback to least-loaded over the full pool.**
- **score** → choose the highest `scoreTiers` entry with `minScore ≤ (lead.score ?? 0)`; among that tier's `userIds` still in the pool, least-loaded. **No tier / all inactive → fallback least-loaded over the full pool.**

Rules referencing a deactivated/removed rep are ignored because selection always intersects with the live `candidates` pool. `least_loaded` is the shared fallback primitive (extract a helper).

## The `assign-lead` Inngest step

- Runs after `ai-qualify` (so `lead.score` is set), before `send-sms`. One `step.run("assign-lead", …)` (durable/idempotent; DB writes inside the step).
- Re-read the lead's `assignedUserId` inside the step; if already set, return early (idempotent — a retry won't reassign; a manually-owned lead is never touched).
- `getAssignmentCandidates(tx, tenantId)` returns each active sales user with `openLeadCount` (leads where `assignedUserId = user.id AND status NOT IN ('won','lost')`) and `lastAssignedAt` (max `createdAt` of leads assigned to them) via one grouped query.
- On a pick: `setLeadOwner(tx, {tenantId, leadId, userId})` + `recordAgentRun({tenantId, agent:"orchestrator", taskKey:"lead.assign", status:"ok"})` (shows as SAGE in the cockpit; `resolveAgent` already maps orchestrator→SAGE). On no pick: `recordAgentRun(status:"skipped")` with a reason, no throw.

## Manager config UI (`/settings/assignment`)

- Admin-gated (`isOrgAdmin`; TEST_MODE bypass) page. Server-loads `getAssignmentSettings(tenantId)` + the active sales users (for the rep pickers).
- `LeadAssignmentSettings` (client): a strategy `<select>` (Off / Round-robin / Least-loaded / Territory / Score). Conditional editors:
  - **Territory** → rows of `{ State, City (optional), Rep <select> }` → `territoryRules`.
  - **Score** → rows of `{ Min score (number), Reps (multi) }` → `scoreTiers`.
- `saveAssignmentAction(config)` (`"use server"`, `isOrgAdmin`-gated, discriminated-union return) validates via a zod schema (`assignmentConfigSchema` in core) and persists through `saveAssignmentConfig` (read-modify-write preserving siblings).
- Add a link from the `/settings` hub.

## Error handling

- Enrichment-style best-effort: a failure loading config/candidates leaves the lead unassigned (logged), never fails intake.
- Config from `tenant.settings` is parsed defensively (`parseAssignmentConfig`) → unknown/garbage strategy falls back to `off`.
- Admin gate on the save action (server actions are independently callable); tenant-scoped throughout (no cross-tenant rep leakage).

## Testing

- **Unit (pure, `@savvy/core`)**: `pickAssignee` for every strategy + each fallback (no candidates, off, territory no-match→least-loaded, score no-tier→least-loaded, round-robin null `lastAssignedAt` ordering, least-loaded tiebreak); `parseAssignmentConfig` defaulting; `assignmentConfigSchema` validation.
- **Integration (`@savvy/db`)**: `getAssignmentCandidates` computes openLeadCount/lastAssignedAt correctly and is tenant-scoped (cross-tenant reps excluded); `saveAssignmentConfig` preserves sibling settings.
- **Integration (`@savvy/agents`)**: the `assign-lead` step assigns under each strategy with a seeded multi-rep tenant; skips when off / already-assigned.
- **e2e (Playwright)**: `/settings/assignment` renders, switching strategy reveals the right editor, save persists (admin path; TEST_MODE). Reuse the seed-direct pattern; Inngest assignment itself is covered by the agents integration test (the e2e harness's Inngest-driven path is covered by existing lead-intake e2e).
- Existing tenant-isolation suite stays green.

## Non-negotiables checklist (CLAUDE.md)

- ✅ Tenant isolation: candidate query + assignment write tenant-scoped via `withTenant`/RLS; settings read/write `adminDb` filtered by explicit `tenantId`.
- ✅ Durable/idempotent Inngest step; re-read assignment inside the step so retries don't reassign.
- ✅ No hardcoded policy — strategy is data; AI not involved (deterministic routing). `recordAgentRun` for visibility.
- ✅ No secrets; no new env. Migration: **none** (reuses `tenant.settings` jsonb + existing `lead.assignedUserId`).
- ✅ Tests at every layer; typecheck + lint + local prod build before PR.

## Implementation slices (for the plan)

- **1 — Engine**: `AssignmentConfig`/`parseAssignmentConfig`/`assignmentConfigSchema` + `pickAssignee` (+ least-loaded helper), all pure + unit-tested.
- **2 — Wiring**: `getAssignmentCandidates` (@savvy/db) + `assign-lead` step in `lead-intake` + `getAssignmentSettings`/`saveAssignmentConfig`, with integration tests.
- **3 — Settings UI**: `/settings/assignment` page + `LeadAssignmentSettings` editors + `saveAssignmentAction` + settings-hub link + e2e.

## Open questions / future

- Per-person "receives leads" toggle (deferred).
- Notify the assigned rep (SMS/email) — natural next slice.
- Re-balance/round-robin a backlog of existing unassigned leads (a one-shot action).
- Territory match by ZIP, not just city/state.
