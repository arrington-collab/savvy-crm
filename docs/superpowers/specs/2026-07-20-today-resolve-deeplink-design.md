# Today "Resolve" — deep-link + in-place resolution

**Date:** 2026-07-20
**Status:** Approved (Brett) — full-select picker, Slice 1 ships first.

## Problem
The Today page renders a ranked queue of "decisions need you" cards, each with a
`Resolve →` button. Today that button is a generic `<Link href={d.href}>` and
almost every href is `/jobs/{id}` — the **top** of a long job page. The operator
lands nowhere near the thing that needs work. Brett's current screen is flooded
with `roof_type_needed` cards ("Roof type unknown — capture it") whose Resolve
opens a job/customer page that has **no roof-type capture control at all**, so
the decision cannot actually be resolved from where it sends you.

## Goal
Resolve should either **do the fix in place** (one-shot structured decisions) or
**drop the operator on the exact surface** that resolves it (anything needing
job context) — never the top of a generic page.

## Two mechanisms (whole feature)
1. **In-place resolve** — the card grows a small control; the operator acts, a
   server action runs, the card clears on the queue's next render. Follows the
   existing `FillApprovalActions` / `BlitzApprovalActions` pattern
   (`useTransition` + a `@/lib/*-actions` server action + `data-testid`).
2. **Deep-link-to-focus** — `href` becomes `/jobs/{id}?focus=<target>`; the job
   page opens the right tab and a small client effect scrolls the target panel
   into view and briefly rings it. Query-param only; no schema/RLS/migration.

## Kind → treatment (whole feature, for reference)
| Kind(s) | Treatment | Target |
|---|---|---|
| **roof_type_needed** | In-place | roof-material picker → `setPropertyRoofMaterial` |
| task_needs_approval | In-place (later slice) | approve/reject |
| stage_evidence, photo_incomplete, photo_quality | Deep-link | job → Docs tab |
| task_overdue, production_*, inspection_gate, job_at_risk | Deep-link | job → Tasks tab |
| material_delivery | Deep-link | job → Materials panel |
| margin_outlier | Deep-link | job → margin card |
| invoice_overdue | Deep-link | `/invoices?focus={invoiceId}` |
| appointment_missed, weather_at_risk | leave | `/schedule` |
| photo_unmatched, supplier_* | leave | already specific |

Everything below the roof-type row is **Slice 2** (separate spec/plan). This
document specs **Slice 1 only**.

---

## Slice 1 — roof-type in-place resolver

### Data threading (core)
`ExceptionItem` (packages/core/src/exception-queue.ts) gains one optional field:
```ts
resolvePropertyId?: string;   // set only for kinds resolved in-place against a property
```
The `roof_type_needed` push sets `resolvePropertyId: r.propertyId` (the input
already carries `propertyId`). `href` is left as-is (harmless fallback; the card
renders the picker instead of the link when `resolvePropertyId` is present).
No other kind sets it. Pure function — covered by the existing
`exception-queue.test.ts` (add one assertion).

### Server action (web)
New `apps/web/src/lib/roof-actions.ts`:
```ts
"use server";
export async function resolveRoofTypeAction(propertyId: string, material: RoofMaterial): Promise<void>
```
- Resolves `tenantId` via `getTenantId()`.
- Validates `material` is in `ROOF_MATERIAL_VALUES` (throws otherwise).
- Calls `setPropertyRoofMaterial(tenantId, { propertyId, material, source: "inspection", confidence: 1 })`.
  - `source: "inspection"` = highest human authority in `ROOF_MATERIAL_SOURCES`,
    so a desk confirmation upgrades assessor/inference guesses and the write
    path's own precedence guard still prevents a weaker source clobbering it later.
- `revalidatePath("/today")` so the resolved card drops off.

### Inline component (web)
New `apps/web/src/app/(app)/today/RoofTypeActions.tsx` (client):
- A **full select** of all 8 `ROOF_MATERIAL_VALUES` with human labels
  (Asphalt shingle, Wood shake, Clay tile, Concrete tile, Metal,
  Flat / built-up, Asbestos-suspect, Other).
- On change → `startTransition(() => resolveRoofTypeAction(propertyId, value))`.
- `data-testid="roof-type-resolve"`; disabled while pending.
- Uses the shared shadcn `Select` (matches design system; no hardcoded colors).

### Wiring (web) — today/page.tsx
- `Decision` type gains `resolvePropertyId?: string`; the `scopedItems.map`
  passes it through from the core item.
- In the decision-card render, when `d.kind === "roof_type_needed" &&
  d.resolvePropertyId`, render `<RoofTypeActions propertyId={d.resolvePropertyId} />`
  in place of the generic `Resolve →` link. All other cards unchanged.

### Tests (Slice 1)
- **core**: `exception-queue.test.ts` — assert the `roof_type_needed` item now
  carries `resolvePropertyId` equal to the input `propertyId`.
- **web (unit)**: `roof-actions` test — valid material writes via
  `setPropertyRoofMaterial` under the right tenant; invalid material throws.
- **web (component)**: a `roof_type_needed` decision renders
  `[data-testid="roof-type-resolve"]` and NOT a `Resolve →` link.
- Full `pnpm test` + `pnpm typecheck` + `pnpm lint` green before PR.

### Out of scope for Slice 1
Deep-link focus mechanism, `?focus=` param, `JobTabs` defaultTab/ring,
task_needs_approval in-place, and every non-roof href change. Those are Slice 2.

### Done when
An operator on Today can set a property's roof type directly from the card in
one interaction, the card clears, and no navigation to a deadend job page is
involved.
