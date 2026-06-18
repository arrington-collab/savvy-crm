# Leads Page — Design Spec (2026-06-17)

Replace the styled-stub `/leads` page with a real, data-backed funnel: a sortable
lead list, a per-lead detail page, lead creation, and status-gated actions
(convert to job, assign owner, mark lost). Reuses the cockpit design system and
agent personas already shipped.

## Goal

Give a rep a working "what do I call next, and what do I do with it" surface for
leads, backed by real tenant-scoped data, consistent with the existing jobs /
command-center pages.

## Scope

In:
- List page (`/leads`): funnel-count strip + sortable list, status filter.
- New lead (`/leads/new`): form → creates customer+property+lead, fires intake agent.
- Detail page (`/leads/[id]`): customer/property, AI score+reason, source, owner,
  communications timeline, status-gated actions.
- Actions: create, convert-to-job, assign owner, mark lost.
- Tests: `@savvy/db` integration tests for new lifecycle helpers; Playwright
  `leads.spec.ts` for list/filter/create/detail/actions.

Out (this slice):
- Lead editing, bulk actions, real-time updates.
- Adding `leadId` to `agent_run` (proper per-lead run linkage) — see Known limits.
- The deferred `qualified`/`won` automation (those statuses remain manual-only).

## Architecture (Approach A — server-first)

List and detail are `force-dynamic` server components that read through thin,
tenant-scoped lib queries. Filtering and sorting are URL search params (no client
data fetching). The only client components are the lead-creation form and the
action bar, which call `"use server"` actions that mutate inside `withTenant` and
`revalidatePath`. This mirrors `jobs/page.tsx`, `job-actions.ts`, and
`invoices/new/NewInvoiceForm.tsx`.

### Files

| File | Kind | Purpose |
|------|------|---------|
| `packages/db/src/lifecycle/leads.ts` | new | `setLeadOwner(tx, {tenantId, leadId, userId})`, `setLeadLost(tx, {tenantId, leadId})` lifecycle helpers (caller wraps in `withTenant`). Distinct names from the web actions to avoid import collision. Export via `@savvy/db`. |
| `packages/db/src/lifecycle/leads.test.ts` | new | Integration tests for the two helpers (RLS-scoped, idempotent, status transitions). |
| `apps/web/src/lib/leads-queries.ts` | new | `getLeads({status?, sort?})`, `getLeadFunnelCounts()`, `getLeadDetail(id)` — thin queries. |
| `apps/web/src/lib/lead-actions.ts` | new | `"use server"`: `createLead(input)`, `convertLead(id)`, `assignLeadOwner(id, userId\|null)`, `markLeadLost(id)`. |
| `apps/web/src/app/(app)/leads/page.tsx` | replace | Funnel strip + sortable list. |
| `apps/web/src/app/(app)/leads/new/page.tsx` | new | Hosts `NewLeadForm`. |
| `apps/web/src/app/(app)/leads/new/NewLeadForm.tsx` | new | Client form (name/phone/address/source). |
| `apps/web/src/app/(app)/leads/[id]/page.tsx` | new | Lead detail. |
| `apps/web/src/components/leads/LeadActions.tsx` | new | Client action bar, status-gated. |
| `apps/web/tests/leads.spec.ts` | new | Playwright coverage. |

`convertLeadToJob` already exists in `packages/db/src/lifecycle/appointments.ts`
and is reused as-is (idempotent: lead→booked, job seeded, drips stopped).

## Data layer (`leads-queries.ts`)

All via `withTenant(getTenantId(), tx => ...)`.

- `getLeads({ status, sort })`:
  - select `lead.{id,status,score,scoreReason,source,createdAt}`,
    `customer.name`, `property.address`, `user.name as ownerName`
  - left-join customer (by `lead.customerId`), property (by `lead.propertyId`),
    user (by `lead.assignedUserId`)
  - `where` status when provided (validated against `LEAD_STATUS`)
  - `orderBy`: `sort==="age"` → `lead.createdAt desc`; default → `score desc nulls last`, tiebreak `createdAt desc`
- `getLeadFunnelCounts()`: `select lead.status, count(*) group by status`, returned
  as a `Record<LeadStatus, number>` (zero-filled for missing statuses).
- `getLeadDetail(id)`: the lead joined to customer + property + owner, plus the
  lead's communications (`communication` rows joined by `customer.id`, newest
  first, capped ~20). Returns `null` if the lead isn't found in-tenant (→ 404).

## Actions (`lead-actions.ts`, `"use server"`)

Each: `getTenantId()` → mutate in `withTenant` → `revalidatePath`. Return a
discriminated union (`{ok:true} | {error: "..."}`) like `job-actions.ts`.

- `createLead(input)`: validate with `leadIntakeSchema` (`@savvy/core`); call
  `createLeadForTenant(tenantId, input)` (existing — creates customer+property+lead
  status=`new`, fires `lead/created`). The post-tx `inngest.send` is wrapped so a
  missing Inngest engine logs-and-continues (lead still created). Returns
  `{ ok:true, leadId }`. Default `source` for hand-entered = `"manual"`.
- `convertLead(id)`: `withTenant(tx => convertLeadToJob({tenantId, leadId:id}))`;
  revalidate `/leads` + `/leads/[id]` + `/jobs`. Returns `{ok:true, jobId}`.
- `assignLeadOwner(id, userId)`: `withTenant(tx => setLeadOwner(tx, {...}))`.
  `userId` of `null` clears the owner.
- `markLeadLost(id)`: `withTenant(tx => setLeadLost(tx, {...}))` (sets status=`lost`).

User list for the Assign dropdown comes from the existing `listUsers()`
(`scheduling-queries.ts`), tenant-scoped `{id, name}`.

## Lifecycle helpers (`@savvy/db`)

- `setLeadOwner(tx, { tenantId, leadId, userId })`: `update lead set assigned_user_id=userId where id=leadId`. Validates the user (if non-null) belongs to the tenant; throws on cross-tenant. Idempotent.
- `setLeadLost(tx, { tenantId, leadId })`: `update lead set status='lost' where id=leadId`. No-op if already lost.

Both take an open `tx` (caller wraps in `withTenant`), matching
`convertLeadToJob`/`recordStageChange` conventions. Integration-tested in
`leads.test.ts` (create tenant+user+lead, assign/clear, mark lost, cross-tenant
rejection).

## UI

### List page (`/leads`)
- `PageHeader eyebrow="Funnel" title="Leads"` with a `right` slot = `[+ New Lead]`
  link to `/leads/new`.
- Funnel strip: one chip per `LEAD_STATUS` (new/contacted/qualified/booked/won/lost)
  rendered with `MetricCard` (label=status, value=count). Each chip is a link to
  `?status=<s>`; an "All" chip clears. Active status visually highlighted.
- List (sorted): columns — score · customer · address · source · `StatusBadge` ·
  age (`lib/format.ts` relative time) · owning-agent `AgentAvatar`. Sort links for
  score / age toggle `?sort=`. Each row links to `/leads/[id]`.
- Owning-agent persona = derived from status via a small helper
  (`new|contacted|qualified|booked` → ATLAS; `won` → SAGE; `lost` → ATLAS dimmed).
  Presentation only — not a real `agent_run` lookup (see Known limits).
- Empty state: a cockpit-styled "No leads yet" with the New Lead CTA.

### New lead (`/leads/new` + `NewLeadForm`)
- Client form (`useState`/`useTransition`/`useRouter`/`toast`), fields: customer
  name, phone (E.164 `+1…`, with help text), address, source (default `manual`).
- Submit → `createLead` → on `{ok}` toast + `router.push("/leads/" + leadId)`.
- Client-side required-field checks; server re-validates with `leadIntakeSchema`.
  Surface server validation errors as a toast.

### Detail page (`/leads/[id]`)
- `getLeadDetail`; `null` → `notFound()`.
- Header: customer name + `StatusBadge`.
- Cards: AI score + `scoreReason` (ATLAS-attributed); source; assigned owner.
- Communications timeline: real `communication` rows for the lead's customer
  (channel, direction, snippet, time), persona via `resolveAgent`.
- `LeadActions` bar.

### Actions component (`LeadActions.tsx`, client)
Status-gated:
- `new|contacted|qualified` → `[Convert to Job]` `[Assign ▾]` `[Mark lost]`
- `booked` → `[Assign ▾]` (job already exists)
- `won|lost` → read-only (no buttons)

Assign is a small dropdown of `listUsers()` results (+ "Unassigned"). Each button
uses `useTransition`; on success → `toast` + `router.refresh()`.

## Data flow
browser → server page (`getLeads`/`getLeadDetail` via `withTenant`) → render.
Mutation → client component → `"use server"` action → lifecycle/SQL in
`withTenant` tx → `revalidatePath`/`router.refresh()` re-renders. No client fetch.

## Error handling
- Cross-tenant / not-found lead → `notFound()` (RLS already scopes reads).
- Action errors → discriminated union → toast; never throw to the user.
- `inngest.send` failure on create → logged, lead still created (qualification just
  doesn't auto-run without the engine).

## Testing
- `packages/db` vitest integration: `setLeadOwner` (set/clear/cross-tenant),
  `setLeadLost` (sets lost, idempotent).
- Playwright `leads.spec.ts` (seeded demo tenant, `TEST_MODE=1`): funnel counts
  render; clicking a status chip filters rows; New Lead form creates a lead that
  appears as `new`; row → detail; Convert moves a lead to `booked` and removes the
  Convert button; Mark lost makes the lead read-only. Preserve/add `data-testid`s.
- Gate: `pnpm typecheck && pnpm lint && pnpm test` at repo root, green.

## Known limits / future
- No per-lead `agent_run` linkage today (lead.qualify run is recorded without a
  job/lead id). A future slice can add `leadId` to `agent_run` + `recordAgentRun`
  to show the actual qualify run on the detail timeline. For now score+reason is
  the truthful qualify signal.
- `[+ New Lead]` is a manual entry path; it intentionally reuses the same
  `createLeadForTenant` flow as API/booking intake, so new manual leads get the
  same ATLAS qualification when Inngest is running.
