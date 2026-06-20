# Navigation & Discoverability — Design Spec (2026-06-19)

First of two UX sub-projects that came out of a product walkthrough (the second is a
Schedule upgrade, brainstormed separately). This one closes pure navigation/discoverability
gaps — no underlying feature changes. The job-detail page, the board, and the dashboard
already hold the data; users just can't get to it fluidly.

## Goal
Make the app explorable: every detail page has a breadcrumb back to its parent, job cards
open on click (drag moves to a dedicated grip), the dashboard pipeline drills into the board,
and the "idle" agent label stops reading as broken. **No feature logic changes, no schema
change, no restyle** — navigation only.

Branch `feat/nav-discoverability` off `main` (independent of open PRs #27/#28/#29).

## Non-negotiables honored
- No schema migration; no change to any query's data, only how the UI links.
- apps/web stays Playwright-only (no vitest added); verification is e2e + the gate.
- Follows existing cockpit component patterns (`components/cockpit/*`, `PageHeader`,
  `StatusBadge`) and the espresso/gold token system — no hardcoded colors.
- Tenant isolation untouched (adds no data paths).

---

## Part 1 — Breadcrumb component

New `apps/web/src/components/cockpit/Breadcrumb.tsx`: a presentational component taking
`segments: { label: string; href?: string }[]`. Renders segments joined by `/`; any segment
with an `href` is a `<Link>`, the last segment (current page) is plain text (no link). Styled
with existing tokens (`text-text-faint` for links, `text-foreground` for current), mono
eyebrow scale to match `PageHeader`.

Placed at the top of each detail page (the page already loads the data each label needs —
no new queries):

| Page | Breadcrumb |
|---|---|
| `app/(app)/jobs/[id]/page.tsx` | `Jobs` (→`/jobs`) ` / ` `<customer name>` |
| `app/(app)/leads/[id]/page.tsx` | `Leads` (→`/leads`) ` / ` `<customer name>` |
| `app/(app)/jobs/[id]/estimates/[estimateId]/page.tsx` | `Jobs` (→`/jobs`) ` / ` `<customer>` (→`/jobs/[id]`) ` / ` `Estimate` |
| `app/(app)/jobs/[id]/change-orders/[changeOrderId]/page.tsx` | `Jobs` (→`/jobs`) ` / ` `<customer>` (→`/jobs/[id]`) ` / ` `Change Order` |

Where a customer name is null (lead without a name), fall back to the existing page title
string (e.g. "Lead" / "Job"). The component itself is dumb; each page supplies its segments.

## Part 2 — Job card: click opens, grip drags

`app/(app)/jobs/board.tsx`. Today the whole `<Card>` carries the `useDraggable`
`listeners`/`attributes`, and a tiny "Open" `<Link>` is the only way into detail.

Change:
- Add a dedicated drag grip (a small `⠿` handle, top-left of the card) that carries the
  `{...listeners} {...attributes}` from `useDraggable` (with `useSortable`/`useDraggable`'s
  `setActivatorNodeRef` on the grip so only the grip initiates a drag).
- The card body becomes the navigation surface: wrap it in a `<Link href={`/jobs/${card.id}`}>`
  (or an `onClick` → `router.push`). Remove the now-redundant "Open" link.
- Keep the drag node ref on the card root (so the whole card still visually drags), but the
  **activator** is only the grip — clicking the body navigates, dragging the grip moves stage.
- Accessibility: the card body link is keyboard-focusable; the grip has `aria-label="Drag to
  move"`.

This is the one interaction with real nuance: `@dnd-kit` separates the draggable node from its
activator via `setActivatorNodeRef`. Putting the activator on the grip is what lets the body
be a plain link without the drag sensor swallowing the click. Confirm the exact `@dnd-kit` API
(`useDraggable` vs `useSortable`, `setActivatorNodeRef`) against the installed version at plan
time — this is the version-sensitive part.

## Part 3 — Dashboard pipeline drill-down

`app/(app)/dashboard/page.tsx` + `app/(app)/jobs/board.tsx`.
- Each dashboard pipeline-stage card (currently a static `<Card>`) becomes a `<Link href={
  `/jobs?stage=${stage}`}>`.
- `app/(app)/jobs/page.tsx` (server) reads `searchParams.stage`, validates it against the
  known stage list, and passes an optional `focusStage` prop to the board client component.
- The board **highlights + scrolls to** that column (a ring via `--accent-gold`/`ring` token
  + `scrollIntoView({ inline: "center" })` in an effect keyed on `focusStage`). **All columns
  stay visible** — focus, not filter. Invalid/absent `stage` → no focus, normal board.

Decided: highlight+scroll (preserve board context), NOT filter-to-stage.

## Part 4 — "Idle" agent clarity

`app/(app)/dashboard/page.tsx`. The status pill that currently shows `"idle"` when an agent
has no recent run gets a `title` tooltip: `"No activity in the recent window"`. Pure
presentational; no logic change to how idle is determined (still = not among the latest runs).

---

## Testing (Playwright e2e — apps/web has no vitest)
New `apps/web/tests/e2e/nav-discoverability.spec.ts` (seeded tenant), asserting:
1. **Breadcrumb**: open a job detail → breadcrumb shows `Jobs / <name>`; click `Jobs` →
   back on `/jobs`. Same for a lead detail.
2. **Card click**: on `/jobs`, click a job card body → lands on `/jobs/<id>` (detail header
   visible). Assert the drag grip element exists (`aria-label="Drag to move"`).
3. **Dashboard drill-down**: on `/dashboard`, click a pipeline-stage card → URL is
   `/jobs?stage=<stage>` and that column has the focus ring (testid/class assertion).
Drag-reorder itself is not e2e-asserted (dnd drag is flaky in Playwright); the grip's
presence + the existing board behavior cover it. Gate: typecheck + lint clean.

## Out of scope (deferred)
- Wiring the other dashboard cards (24h actions, AI spend, error rate, rep-performance rows)
  to destinations — only the pipeline stages drill down for now.
- Any visual restyle / new layout. Navigation only.
- Filter-to-stage on the board (chose highlight+scroll).
- Breadcrumbs on non-detail pages (lists already are the top level).

## Risks / honest constraints
- **`@dnd-kit` activator wiring is the sensitive part** — separating click-to-navigate from
  drag requires `setActivatorNodeRef` on the grip; confirm the API against the installed
  version at plan time. If the body-link + drag still conflict, fall back to an explicit
  `onClick`+`router.push` on the body guarded by a drag-distance check.
- `scrollIntoView` + ring is a client effect; under `force-dynamic`/SSR it must run in
  `useEffect` keyed on `focusStage` (guard for the column ref existing).
- The board is shared by Part 2 and Part 3 — both edits land in `board.tsx`; keep them
  cohesive (grip + focusStage) and re-run the jobs e2e after.
