# Navigation & Discoverability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app explorable — breadcrumbs on every detail page, job cards that open on click (drag via a dedicated grip), dashboard pipeline cards that drill into the board, and a clearer "idle" agent label — with zero feature-logic or schema change.

**Architecture:** Pure presentational additions in `apps/web`. One new `Breadcrumb` component reused across detail pages; the `@dnd-kit` drag activator moves from the whole card onto a grip so the card body can be a link; the dashboard pipeline cards become links to `/jobs?stage=X` and the board highlights+scrolls to that column. No new data, no schema.

**Tech Stack:** Next.js 16 (App Router, Turbopack), React, `@dnd-kit/core`, Tailwind v4 + the espresso/gold token system, Playwright (apps/web is Playwright-only — NO vitest).

---

## Conventions for every task

- **Repo root:** `~/Sites/savvy-crm`. **Branch:** `feat/nav-discoverability` (already checked out, off `origin/main`).
- **Gate** (run from repo root before each commit that changes code):
  ```bash
  export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
  pnpm typecheck && pnpm lint
  ```
  Expect typecheck 7/7, lint 0 errors. (If a stale `.next` cache error appears in `@savvy/web`, run `rm -rf apps/web/.next` and re-run.)
- **apps/web is Playwright-only** — do NOT add vitest or `*.test.ts` under apps/web. Verification for UI is the e2e spec in Task 6 + the gate.
- **No `.js` import extensions** in source files. Import from package roots (`@savvy/core`), `@/` = `apps/web/src/`.
- **Styling:** use existing CSS tokens (`var(--text-faint)`, `var(--accent-gold)`, etc.) and utility classes already in the file — no hardcoded hex colors.
- **Route-group parens:** files live under `app/(app)/...`. When `git add`-ing them, quote the path or use `git add -A` to avoid a mangled `\(app\)` dir; check `git status` after.

## File Structure

**New:**
- `apps/web/src/components/cockpit/Breadcrumb.tsx` — reusable breadcrumb trail (Task 1).
- `apps/web/src/lib/breadcrumb-queries.ts` — `getJobCustomerName(jobId)` for the sub-page crumbs (Task 2).
- `apps/web/tests/e2e/nav-discoverability.spec.ts` — e2e coverage (Task 6).

**Modified:**
- `apps/web/src/app/(app)/jobs/[id]/page.tsx`, `apps/web/src/app/(app)/leads/[id]/page.tsx` (Task 1).
- `apps/web/src/app/(app)/jobs/[id]/estimates/[estimateId]/page.tsx`, `apps/web/src/app/(app)/jobs/[id]/change-orders/[changeOrderId]/page.tsx` (Task 2).
- `apps/web/src/app/(app)/jobs/board.tsx` (Task 3 grip + Task 4 focusStage).
- `apps/web/src/app/(app)/jobs/page.tsx`, `apps/web/src/app/(app)/dashboard/page.tsx` (Task 4).
- `apps/web/src/app/(app)/dashboard/page.tsx` (Task 5 — idle tooltip).

---

## Task 1: Breadcrumb component + job/lead detail

**Files:**
- Create: `apps/web/src/components/cockpit/Breadcrumb.tsx`
- Modify: `apps/web/src/app/(app)/jobs/[id]/page.tsx`
- Modify: `apps/web/src/app/(app)/leads/[id]/page.tsx`

- [ ] **Step 1: Create the Breadcrumb component**

Create `apps/web/src/components/cockpit/Breadcrumb.tsx`:

```tsx
import Link from "next/link";

export type Crumb = { label: string; href?: string };

/** Cockpit breadcrumb trail. Each segment with an href is a link; the last
 *  segment is the current page (rendered plain, never linked). */
export function Breadcrumb({ segments }: { segments: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" data-testid="breadcrumb" className="mono mb-3 flex flex-wrap items-center gap-1.5 text-[12px]">
      {segments.map((s, i) => {
        const last = i === segments.length - 1;
        return (
          <span key={i} className="flex items-center gap-1.5">
            {s.href && !last ? (
              <Link href={s.href} className="hover:underline" style={{ color: "var(--text-faint)" }}>
                {s.label}
              </Link>
            ) : (
              <span style={{ color: last ? "var(--text-primary)" : "var(--text-faint)" }}>{s.label}</span>
            )}
            {!last ? <span aria-hidden style={{ color: "var(--text-faint)" }}>/</span> : null}
          </span>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 2: Add the breadcrumb to the job detail page**

In `apps/web/src/app/(app)/jobs/[id]/page.tsx`:
- Add the import near the other `@/components/...` imports:
  ```ts
  import { Breadcrumb } from "@/components/cockpit/Breadcrumb";
  ```
- Find the page's main `return (` (around line 277) and its top-level wrapper element. Insert the breadcrumb as the FIRST child inside that wrapper, before the existing header card. The customer name is available as `jobRow.customerName`:
  ```tsx
  <Breadcrumb segments={[{ label: "Jobs", href: "/jobs" }, { label: jobRow.customerName ?? "Job" }]} />
  ```
  (If the top-level wrapper is a fragment or a bare element without a flex/space container, wrap so the breadcrumb sits above the header — match the surrounding structure; the page already uses `space-y` containers.)

- [ ] **Step 3: Add the breadcrumb to the lead detail page**

In `apps/web/src/app/(app)/leads/[id]/page.tsx`:
- Add the import:
  ```ts
  import { Breadcrumb } from "@/components/cockpit/Breadcrumb";
  ```
- The return is `<div className="space-y-6" data-testid="lead-detail">` with a `<PageHeader ... />` first child (around line 26-27). Insert the breadcrumb as the FIRST child of that `div`, before `<PageHeader>`:
  ```tsx
  <Breadcrumb segments={[{ label: "Leads", href: "/leads" }, { label: detail.customerName ?? "Lead" }]} />
  ```

- [ ] **Step 4: Gate**

Run from repo root:
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint
```
Expected: typecheck 7/7, lint 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/cockpit/Breadcrumb.tsx "apps/web/src/app/(app)/jobs/[id]/page.tsx" "apps/web/src/app/(app)/leads/[id]/page.tsx"
git commit -m "feat(web): breadcrumb component + job/lead detail breadcrumbs"
```

---

## Task 2: Breadcrumb on estimate & change-order sub-pages

These sub-pages only receive `jobId` (no customer name), so add a one-select helper to label the middle crumb. Breadcrumb shape: `Jobs (→/jobs) / <customer> (→/jobs/[id]) / Estimate|Change Order`.

**Files:**
- Create: `apps/web/src/lib/breadcrumb-queries.ts`
- Modify: `apps/web/src/app/(app)/jobs/[id]/estimates/[estimateId]/page.tsx`
- Modify: `apps/web/src/app/(app)/jobs/[id]/change-orders/[changeOrderId]/page.tsx`

- [ ] **Step 1: Create the customer-name helper**

First read `apps/web/src/lib/pipeline-queries.ts` to copy its EXACT tenant-scoping pattern (how it gets `tenantId` and wraps queries — likely `getTenantId()` + `withTenant`, importing `job`, `customer`, `eq` from `@savvy/db`). Then create `apps/web/src/lib/breadcrumb-queries.ts` mirroring that pattern:

```ts
import "server-only";
import { withTenant, job, customer, eq } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";

/** Customer name for a job, for breadcrumb labels on job sub-pages. Null if not found. */
export async function getJobCustomerName(jobId: string): Promise<string | null> {
  const tenantId = await getTenantId();
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ name: customer.name })
      .from(job)
      .leftJoin(customer, eq(customer.id, job.customerId))
      .where(eq(job.id, jobId));
    return row?.name ?? null;
  });
}
```

IMPORTANT: verify the actual import names and the tenant helper against `pipeline-queries.ts` and `@savvy/db` exports before finalizing — match what that file does (e.g. if it imports `getTenantId` from a different path, or uses `adminDb`/`withTenant` differently). The query must be tenant-scoped exactly like the sibling queries. Adjust the join/column names (`job.customerId`, `customer.name`) to the real schema if they differ.

- [ ] **Step 2: Add breadcrumb to the estimate sub-page**

`apps/web/src/app/(app)/jobs/[id]/estimates/[estimateId]/page.tsx` currently ends with `return <EstimateEditor estimate={estimate} jobId={jobId} />;`. Change it to fetch the name and wrap with a breadcrumb:
- Add imports:
  ```ts
  import { Breadcrumb } from "@/components/cockpit/Breadcrumb";
  import { getJobCustomerName } from "@/lib/breadcrumb-queries";
  ```
- Before the return, add:
  ```ts
  const customerName = await getJobCustomerName(jobId);
  ```
- Replace the return with:
  ```tsx
  return (
    <div className="space-y-4">
      <Breadcrumb
        segments={[
          { label: "Jobs", href: "/jobs" },
          { label: customerName ?? "Job", href: `/jobs/${jobId}` },
          { label: "Estimate" },
        ]}
      />
      <EstimateEditor estimate={estimate} jobId={jobId} />
    </div>
  );
  ```

- [ ] **Step 3: Add breadcrumb to the change-order sub-page**

`apps/web/src/app/(app)/jobs/[id]/change-orders/[changeOrderId]/page.tsx` has `const { id, changeOrderId } = await params;` and returns a `<div>` wrapping `<ChangeOrderEditor changeOrder={co} jobId={id} />`. 
- Add imports:
  ```ts
  import { Breadcrumb } from "@/components/cockpit/Breadcrumb";
  import { getJobCustomerName } from "@/lib/breadcrumb-queries";
  ```
- Before the return add:
  ```ts
  const customerName = await getJobCustomerName(id);
  ```
- Insert the breadcrumb as the FIRST child of the returned wrapper `<div>`, before `<ChangeOrderEditor>`:
  ```tsx
  <Breadcrumb
    segments={[
      { label: "Jobs", href: "/jobs" },
      { label: customerName ?? "Job", href: `/jobs/${id}` },
      { label: "Change Order" },
    ]}
  />
  ```

- [ ] **Step 4: Gate**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint
```
Expected: typecheck 7/7, lint 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/breadcrumb-queries.ts "apps/web/src/app/(app)/jobs/[id]/estimates/[estimateId]/page.tsx" "apps/web/src/app/(app)/jobs/[id]/change-orders/[changeOrderId]/page.tsx"
git commit -m "feat(web): breadcrumbs on estimate + change-order sub-pages"
```

---

## Task 3: Job card — click body opens, grip drags

**Files:**
- Modify: `apps/web/src/app/(app)/jobs/board.tsx` (the `JobCard` function only)

- [ ] **Step 1: Rewrite `JobCard` to move the drag activator to a grip and make the body a link**

In `apps/web/src/app/(app)/jobs/board.tsx`, replace the entire `JobCard` function (currently lines ~49-88) with:

```tsx
function JobCard({ card }: { card: BoardCard }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({ id: card.id });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  // Real owning agent (latest run on this job) with stage heuristic as fallback.
  const { persona } = card.agent ? resolveAgent({ agent: card.agent, taskKey: card.taskKey }) : resolveAgentForStage(card.stage);
  return (
    <Card
      ref={setNodeRef}
      size="sm"
      style={style}
      data-testid="job-card"
      data-job-id={card.id}
      className={cn("gap-2 p-3", isDragging && "opacity-50")}
    >
      <div className="flex items-start gap-1.5">
        <button
          ref={setActivatorNodeRef}
          {...listeners}
          {...attributes}
          aria-label="Drag to move"
          data-testid="job-card-grip"
          className="mt-0.5 shrink-0 cursor-grab touch-none text-[13px] leading-none"
          style={{ color: "var(--text-faint)", background: "transparent", border: "none" }}
        >
          ⠿
        </button>
        <Link href={`/jobs/${card.id}`} data-testid="job-card-link" className="min-w-0 flex-1 outline-none">
          <div className="font-medium" style={{ color: "var(--text-primary)" }}>{card.customerName}</div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>{card.address}</div>
          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="mono font-medium" style={{ color: persona.colorToken }}>{formatValue(card.valueEstimate)}</span>
            <span className="mono rounded px-1.5 py-0.5 text-[10px]" style={{ color: "var(--text-faint)", background: "var(--surface-panel)" }}>
              {daysInStage(card.stageEnteredAt)}d
            </span>
          </div>
          <div className="mt-2 flex min-w-0 items-center gap-1.5" style={{ borderTop: "1px solid var(--border-panel)", paddingTop: 8 }}>
            <AgentAvatar persona={persona} size="sm" />
            <span className="truncate text-[11px]" style={{ color: "var(--text-muted)" }}>{personaLine(persona, seedFromId(card.id))}</span>
          </div>
        </Link>
      </div>
    </Card>
  );
}
```

Key changes: `setActivatorNodeRef` + `{...listeners} {...attributes}` now live ONLY on the grip `<button>` (so only the grip starts a drag); `setNodeRef` stays on the `Card` (so the whole card still visually drags); the card body is a `<Link>` to `/jobs/${card.id}`; the old "Open" link is removed; `cursor-grab` moved off the Card onto the grip.

Note on the `@dnd-kit/core` API: `useDraggable` returns `setActivatorNodeRef` in the installed version. If typecheck reports it does not exist on the returned type, STOP and report — do not guess; the version matters. (It is part of `@dnd-kit/core`'s `useDraggable` return; this should typecheck.)

- [ ] **Step 2: Gate**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint
```
Expected: typecheck 7/7, lint 0 errors.

- [ ] **Step 3: Manual sanity (optional, if a dev server is handy)**

If `next dev` is running against a seeded tenant, load `/jobs`, click a card body → should navigate to `/jobs/<id>`; the `⠿` grip should still drag a card between columns. (Full e2e is Task 6.)

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/jobs/board.tsx"
git commit -m "feat(web): job cards open on click, drag via dedicated grip"
```

---

## Task 4: Dashboard pipeline drill-down + board column focus

**Files:**
- Modify: `apps/web/src/app/(app)/jobs/board.tsx` (the `Column` and `Board` functions)
- Modify: `apps/web/src/app/(app)/jobs/page.tsx`
- Modify: `apps/web/src/app/(app)/dashboard/page.tsx` (pipeline cards only)

- [ ] **Step 1: Add `focusStage` highlight + scroll to the board**

In `apps/web/src/app/(app)/jobs/board.tsx`:
- Add `useEffect` and `useRef` to the React import (line 3 currently `import { useState, useTransition } from "react";`):
  ```ts
  import { useState, useTransition, useEffect, useRef } from "react";
  ```
- Change the `Column` function signature and body to accept a `focused` prop, scroll into view when focused, and show a ring. Replace the `Column` function header + its returned `<div>` opening so it reads:
  ```tsx
  function Column({ stage, cards, focused }: { stage: JobStage; cards: BoardCard[]; focused?: boolean }) {
    const { setNodeRef, isOver } = useDroppable({ id: stage });
    const colRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
      if (focused) colRef.current?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }, [focused]);
    const muted = stage === "lost";
    const accent = resolveAgentForStage(stage).persona.colorToken;
    return (
      <div
        ref={(el) => {
          setNodeRef(el);
          colRef.current = el;
        }}
        data-testid={`col-${stage}`}
        data-focused={focused ? "true" : undefined}
        className={cn("flex w-64 shrink-0 flex-col gap-2 rounded-xl p-2", muted && "opacity-60")}
        style={{
          border: focused
            ? "1px solid var(--accent-gold)"
            : isOver
              ? "1px solid var(--accent-040)"
              : "1px solid var(--border-panel)",
          background: "var(--surface-panel)",
          boxShadow: focused ? "0 0 0 2px var(--accent-gold)" : isOver ? "var(--active-shadow)" : "none",
        }}
      >
  ```
  Leave the rest of the `Column` body (the header `<div>` with stage name/count and the cards map) unchanged.
- Change the `Board` function to accept and pass `focusStage`. Update its signature and the `Column` render:
  ```tsx
  export function Board({ initialBoard, focusStage }: { initialBoard: Record<string, BoardCard[]>; focusStage?: string }) {
  ```
  and in the returned JSX where columns are mapped:
  ```tsx
  {ALL_STAGES.map((stage) => (
    <Column key={stage} stage={stage} cards={board[stage] ?? []} focused={stage === focusStage} />
  ))}
  ```

- [ ] **Step 2: Pass the `stage` search param from the jobs page to the board**

In `apps/web/src/app/(app)/jobs/page.tsx`:
- Change the page signature to accept `searchParams` (Next 15+ passes it as a Promise):
  ```tsx
  export default async function JobsPage({ searchParams }: { searchParams: Promise<{ stage?: string }> }) {
  ```
- At the top of the function body (after the signature, before/with the existing `Promise.all`), read it:
  ```ts
  const { stage: focusStage } = await searchParams;
  ```
- Update the board render (currently `<Board initialBoard={board} />`):
  ```tsx
  <Board initialBoard={board} focusStage={focusStage} />
  ```
  (The board only highlights a column whose `stage` matches, so an unknown/absent value is a harmless no-op — no validation needed here.)

- [ ] **Step 3: Make the dashboard pipeline cards link to the focused board**

In `apps/web/src/app/(app)/dashboard/page.tsx`, the pipeline section maps `activeStages.map((s) => <Card ...>...)` (around lines 63-72). `Link` is already imported at the top. Wrap each `<Card>` in a `<Link>` to the stage-focused board, moving `flex-1` to the link:

```tsx
{activeStages.map((s) => (
  <Link key={s} href={`/jobs?stage=${s}`} className="flex-1" data-testid={`pipeline-link-${s}`}>
    <Card className="h-full p-3 transition hover:border-accent-040">
      <div className="mono flex items-center gap-1.5 text-[11px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: STAGE_DOT[s] ?? "var(--text-faint)" }} />
        {s}
      </div>
      <div className="mt-1 text-xl font-semibold" data-testid={`stage-${s}`}>{pipeline.byStage[s]}</div>
    </Card>
  </Link>
))}
```
(Keep `key` on the outer `Link` and remove it from the inner `Card`. Preserve the `data-testid={`stage-${s}`}` exactly — existing dashboard e2e asserts it.)

- [ ] **Step 4: Gate**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint
```
Expected: typecheck 7/7, lint 0 errors.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(app)/jobs/board.tsx" "apps/web/src/app/(app)/jobs/page.tsx" "apps/web/src/app/(app)/dashboard/page.tsx"
git commit -m "feat(web): dashboard pipeline cards drill into focused board column"
```

---

## Task 5: "Idle" agent tooltip

**Files:**
- Modify: `apps/web/src/app/(app)/dashboard/page.tsx` (the agent status label only)

- [ ] **Step 1: Add a clarifying tooltip to the idle label**

In `apps/web/src/app/(app)/dashboard/page.tsx`, find the agent status line that renders `{latest ? ago(latest.startedAt) : "idle"}` (around line 144). Add a `title` attribute to its enclosing `<span>` so the idle state is explained on hover. The element currently looks like:
```tsx
<span ...>{latest ? ago(latest.startedAt) : "idle"}</span>
```
Add `title={latest ? undefined : "No activity in the recent window"}` to that span's existing attributes (keep all existing className/style). Result:
```tsx
<span ... title={latest ? undefined : "No activity in the recent window"}>{latest ? ago(latest.startedAt) : "idle"}</span>
```

- [ ] **Step 2: Gate**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint
```
Expected: typecheck 7/7, lint 0 errors.

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/dashboard/page.tsx"
git commit -m "feat(web): clarify idle agent label with a tooltip"
```

---

## Task 6: e2e coverage

**Files:**
- Create: `apps/web/tests/e2e/nav-discoverability.spec.ts`

This is the real verification for the UI behavior (apps/web has no vitest). Model it on the existing specs in `apps/web/tests/e2e/` (e.g. `leads.spec.ts`, `command-center.spec.ts`) for the seeded-tenant + TEST_MODE setup and any `data-testid` helpers they use.

- [ ] **Step 1: Read an existing e2e spec to match conventions**

Read `apps/web/tests/e2e/leads.spec.ts` and one of `command-center.spec.ts` to copy: the import line (`import { test, expect } from "@playwright/test";`), how they navigate (`page.goto("/...")`), and any seeding helpers. The seeded tenant is created by `tests/e2e/create-tenant.ts` and surfaced via `TEST_TENANT_ID`; routes run under `TEST_MODE`.

- [ ] **Step 2: Write the spec**

Create `apps/web/tests/e2e/nav-discoverability.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("job card body click opens the detail page", async ({ page }) => {
  await page.goto("/jobs");
  const card = page.getByTestId("job-card").first();
  await expect(card).toBeVisible();
  // The grip exists as the drag activator (separate from the body link).
  await expect(card.getByTestId("job-card-grip")).toBeVisible();
  await card.getByTestId("job-card-link").click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]+$/);
});

test("job detail shows a breadcrumb that returns to the board", async ({ page }) => {
  await page.goto("/jobs");
  await page.getByTestId("job-card-link").first().click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]+$/);
  const crumb = page.getByTestId("breadcrumb");
  await expect(crumb).toBeVisible();
  await crumb.getByRole("link", { name: "Jobs" }).click();
  await expect(page).toHaveURL(/\/jobs$/);
});

test("dashboard pipeline card drills into the focused board column", async ({ page }) => {
  await page.goto("/dashboard");
  // Click the 'lead' pipeline card (always present in the stage list).
  await page.getByTestId("pipeline-link-lead").click();
  await expect(page).toHaveURL(/\/jobs\?stage=lead/);
  await expect(page.getByTestId("col-lead")).toHaveAttribute("data-focused", "true");
});

test("lead detail shows a breadcrumb that returns to the leads list", async ({ page }) => {
  await page.goto("/leads");
  // Open the first lead (leads rows link to /leads/[id]).
  const firstLeadLink = page.locator('a[href^="/leads/"]').first();
  await firstLeadLink.click();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]+$/);
  const crumb = page.getByTestId("breadcrumb");
  await expect(crumb).toBeVisible();
  await crumb.getByRole("link", { name: "Leads" }).click();
  await expect(page).toHaveURL(/\/leads$/);
});
```

If the leads-row selector (`a[href^="/leads/"]`) does not match the real markup, adjust it to how `leads.spec.ts` opens a lead detail (copy that locator).

- [ ] **Step 3: Run the e2e**

Bring up the harness (Postgres is already running + migrated; create a fresh tenant) and run just this spec. From repo root:
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy AI_STUB_PORT=4010
node apps/web/tests/e2e/ai-stub.mjs > /tmp/nav-aistub.log 2>&1 &
npx --yes inngest-cli@latest dev -u http://localhost:3000/api/inngest --no-discovery > /tmp/nav-inngest.log 2>&1 &
sleep 6
pnpm --filter @savvy/web exec tsx tests/e2e/create-tenant.ts
export TEST_TENANT_ID="$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)")"
cd apps/web && pnpm exec playwright test nav-discoverability --reporter=list ; cd ..
```
Expected: 4 passed. (If a test's locator needs adjusting to the real markup, fix it and re-run — the behavior, not the exact selector, is what matters. Kill the bg services after: `pkill -f ai-stub; pkill -f inngest-cli`.)

- [ ] **Step 4: Full gate**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Expected: typecheck 7/7, lint 0, all existing unit tests still green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/tests/e2e/nav-discoverability.spec.ts
git commit -m "test(web): e2e for breadcrumbs, card click-open, dashboard drill-down"
```

---

## Final verification (whole-branch, before PR)
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green; `nav-discoverability` e2e green.
- [ ] Manual: card body click opens detail; `⠿` grip still drags a card between columns (the one thing e2e doesn't assert — verify by hand in a dev server).
- [ ] `git log --oneline origin/main..HEAD` shows the spec commit + 6 task commits; no stray `\(app\)` dirs (`git status` clean).
- [ ] No feature-logic or schema change (grep the diff: only presentational/nav additions).

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| Breadcrumb component | Task 1 (Step 1) |
| Breadcrumb on job + lead detail | Task 1 (Steps 2–3) |
| Breadcrumb on estimate + change-order sub-pages (`Jobs / <customer> / X`) | Task 2 |
| Job card: click body opens, grip drags (`setActivatorNodeRef`) | Task 3 |
| Dashboard pipeline card → `/jobs?stage=X` | Task 4 (Step 3) |
| Board highlights + scrolls to focused column (not filter) | Task 4 (Steps 1–2) |
| "Idle" tooltip | Task 5 |
| e2e (breadcrumb nav, card click, dashboard drill-down) | Task 6 |
| No schema change, no vitest in apps/web, token styling | All (verified in final) |
