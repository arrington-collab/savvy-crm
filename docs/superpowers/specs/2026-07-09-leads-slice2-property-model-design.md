# Leads Overhaul — Slice 2: Property Data Model

**Date:** 2026-07-09
**Status:** Design approved — ready for implementation plan
**Worktree:** `.claude/worktrees/leads-slice-2` (branch `worktree-leads-slice-2`, off `origin/main` @ `c27396d`)
**Migration:** 0070 (journal confirmed at 0069)
**Source prompt:** `docs/superpowers/specs/prompts-leads-slices-2-5.md` (Slice 2 section)

## Goal

Extend the property/lead data model so a lead reflects roofing reality more faithfully:
dual roof types, an **effective roof age** derived from a known replacement date (not just
year built), and append-only **lead notes**. This is post-contract-adjacent lead-quality
work; it changes scoring inputs but binds no new evidence check (that is Slice 5).

Three features, **one migration (0070)**:

1. Dual roof types on the property.
2. Last-known roof replacement (date + source) → effective roof age.
3. Append-only lead notes, rendered in a minimal merged feed.

## Non-goals (scope guards)

- **No estimate-template system.** No such selector exists today; "secondary roof type
  flows into template selection" is implemented via the existing `deriveLane()` hook, not a
  new template abstraction. (YAGNI.)
- **No full lead timeline rebuild.** Notes render in a minimal notes+comms merged feed. The
  full comms + document-events interleave and tile reorganization belong to **Slice 4**.
- **No rationale-wording change.** Effective age feeds the scoring *number* now; the
  rationale text ("roof ~9 yrs — replaced 2017") and the `lead.effective_age` evidence
  binding are **Slice 5**.
- **No roof-type provenance column.** Owner-confirmed primary roof/year is protected by a
  gap-fill guard (enrichment only writes when the column is null), not a new source column.
- **No pgEnum.** Both new controlled vocabularies use `text` + a core const, matching the
  existing `roof_type` pattern and avoiding painful Postgres enum alters.

## Key decisions (resolved during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Notes timeline scope | Minimal notes+comms feed now; full merge deferred to Slice 4 | Slice 4 already owns tile reorg + comms timeline; keeps Slice 2 tight |
| Secondary roof → "template selection" | Extend `deriveLane()` (primary OR secondary tile → tile lane) | No template system exists; lane is the real downstream hook |
| Enrichment guard width | Guard new replacement field **and** gap-fill primary roof/year | Fixes a pre-existing house-rule violation (unconditional clobber) with minimal scope |
| Replacement source storage | `text` + `ROOF_REPLACEMENT_SOURCE_VALUES` core const | Matches `roof_type` (text + `ROOF_TYPE_VALUES`); no pgEnum alter pain |

## Current-state anchors (from survey, read on `origin/main`)

- `property` table: `packages/db/src/schema/crm.ts:23`. `roofType: text("roof_type")` (:33),
  `yearBuilt: integer("year_built")` (:38). No secondary/replacement/source columns.
- Roof enum: `ROOF_TYPE_VALUES` in `packages/core/src/schemas.ts:31` =
  `["asphalt_shingle","tile","metal","flat_foam","other"]` — TS/Zod const, **not** a pgEnum;
  DB stores free text; membership enforced at the write action.
- Roof age derivation (single source): `packages/core/src/lead-features.ts` `buildLeadFeatures`,
  `roofAgeYears = year_built ? currentYear - year_built : null`.
- Scoring consumers: `packages/core/src/lead-scoring.ts:91` (`roofSubScore`) and `:132`
  (`reasons.push(\`Roof ~${roofAgeYears} yrs\`)`); `install-recommendation.ts:37`.
- Lane derivation: `packages/core/src/lane.ts:9` `deriveLane()` (tile → "tile"); fallback at
  `packages/agents/src/functions/lead-intake.ts:127`.
- Roof editor: `apps/web/src/app/(app)/leads/[id]/RoofTypeEditor.tsx` →
  `setPropertyRoofType(leadId, propertyId, v)` in `apps/web/src/lib/lead-actions.ts:73`.
  Rendered at `leads/[id]/page.tsx:127`.
- Lead detail data: `getLeadDetail` in `apps/web/src/lib/leads-queries.ts` (`detail.roofType`,
  `detail.propertyId`, `detail.communications`). Lead page comms card is a **flat list**
  (`page.tsx:145-164`) — no merged timeline exists on the lead page.
- Enrichment write path: `packages/agents/src/enrichment.ts:71` (stormproof enricher)
  **unconditionally** sets `roofType`/`yearBuilt`/`county`. No provenance guard today.
- Append-only precedent: `communication` table (`packages/db/src/schema/comms.ts:11`,
  insert-only, `orderBy(desc(createdAt))`). Author-resolution precedent: `resolveLocalUserId`
  (from PR #170's manual task completion).
- Checks/bindings (for Slice 5, not this slice): `packages/core/src/verification/checks.ts`,
  `packages/db/seeds/master-task-list.ts:46` `CHECK_BINDINGS`.

## Design

### 1. Schema — migration 0070

Add to `property` (`packages/db/src/schema/crm.ts`):

```ts
roofTypeSecondary: text("roof_type_secondary"),            // nullable; ROOF_TYPE_VALUES membership
lastRoofReplacementAt: date("last_roof_replacement_at"),   // nullable
lastRoofReplacementSource: text("last_roof_replacement_source"), // nullable; ROOF_REPLACEMENT_SOURCE_VALUES
```

New table `lead_note` (own schema file or alongside comms; tenant-scoped, RLS like every table):

```ts
export const leadNote = pgTable("lead_note", {
  id: idCol,
  tenantId: uuid("tenant_id").notNull(),
  leadId: uuid("lead_id").notNull().references(() => lead.id),
  authorUserId: uuid("author_user_id").notNull().references(() => user.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

- **Append-only:** no update/delete action is exposed. "Supersede by writing a new note."
- RLS policy mirrors existing tenant tables (`tenant_id = current_setting('app.tenant_id')::uuid`).
- Migration authored via `pnpm db:generate`; RLS policy added in the migration (follow the
  pattern of the most recent tenant-scoped table migration).

New core const (`packages/core/src/schemas.ts`, next to `ROOF_TYPE_VALUES`):

```ts
export const ROOF_REPLACEMENT_SOURCE_VALUES = ["owner_reported", "permit", "assessor"] as const;
export type RoofReplacementSource = (typeof ROOF_REPLACEMENT_SOURCE_VALUES)[number];
```

### 2. Effective roof age — `packages/core`

Pure helper (new, in `lead-features.ts` or a small `roof-age.ts`):

```ts
export function effectiveRoofAge(
  input: { lastRoofReplacementAt: Date | string | null; yearBuilt: number | null },
  now: Date,                    // injected for testability — no ambient Date.now in pure core
): number | null {
  if (input.lastRoofReplacementAt) {
    const y = new Date(input.lastRoofReplacementAt).getFullYear();
    return now.getFullYear() - y;
  }
  return input.yearBuilt ? now.getFullYear() - input.yearBuilt : null;
}
```

- `buildLeadFeatures` sets `roofAgeYears = effectiveRoofAge(...)`. Extend its input to carry
  `lastRoofReplacementAt`; update the caller that assembles features from the property row.
- Because `roofSubScore` already reads `roofAgeYears`, scoring immediately reflects effective
  age. **No rationale-wording change in this slice** (Slice 5).
- **Scope guard:** the `roofSubScore` tile bump stays **primary-only** in Slice 2. Secondary
  roof type affects `deriveLane` (§4) but **not** the scoring weight — the secondary scoring
  contribution ("tile+foam scores like its service-driving component") is explicitly Slice 5.
- Precedence (`owner_reported > permit > assessor`) governs *writes* to the replacement field
  (see §6), **not** this read — the age calc uses whatever date is stored.

### 3. Dual roof types — `RoofTypeEditor`

- Render **Primary** (existing `<select>`) + **Secondary (optional)** `<select>` with a
  "— none —" option that clears to `null`.
- Server action writes both fields. Extend `setPropertyRoofType` (only caller is the editor)
  to `setPropertyRoofTypes(leadId, propertyId, { primary, secondary })`, or add a sibling
  `setPropertySecondaryRoofType` — planner picks the smaller diff. Validate each value against
  `ROOF_TYPE_VALUES` (secondary may be `null`).
- `#82 roof_type_needed` exception stays keyed on **primary only** — unchanged.

### 4. `deriveLane` extension — `packages/core`

- `deriveLane(f)`: storm wins; else **`f.roofType === "tile" || f.roofTypeSecondary === "tile"`
  → "tile"**; else "standard".
- Extend `LeadFeatures` to carry `roofTypeSecondary`. Update the `lead-intake.ts:127` lane
  fallback: `dest.roofType === "tile" || dest.roofTypeSecondary === "tile" ? "tile" : null`.
- This is the concrete meaning of "secondary roof type flows into estimate template selection."

### 5. Replacement inline editor — lead tile roof section

- Small client editor near the roof type on the lead tile: a **date** input +
  **source** `<select>` (`owner_reported` default / `permit` / `assessor`).
- Server action `setRoofReplacement(leadId, propertyId, { at, source })` — validates source
  against `ROOF_REPLACEMENT_SOURCE_VALUES`, **rejects a future `at`** (a future replacement date
  yields a negative effective age and corrupts scoring), writes both columns, revalidates
  `/leads/[id]`.
- Human edits are the owner-confirmed write path and always apply (no guard on the manual
  action — the guard is on *enrichment*, §6).

### 6. Enrichment guard — `packages/agents/src/enrichment.ts`

Two guards:

1. **Replacement precedence** (forward-looking; no enricher writes replacement today). Pure
   helper in core:
   ```ts
   const RANK = { owner_reported: 3, permit: 2, assessor: 1 } as const;
   export function canEnrichmentWriteReplacement(
     existing: RoofReplacementSource | null,
     incoming: RoofReplacementSource,
   ): boolean {
     if (!existing) return true;
     return RANK[incoming] > RANK[existing];   // never overwrite equal-or-higher; owner_reported is top
   }
   ```
   Any future enrichment write of the replacement field routes through this. **Red-path test**
   exercises the helper directly: existing `owner_reported`, incoming `assessor` → `false`.
2. **Primary roof/year gap-fill.** Change `enrichment.ts:71` so the stormproof enricher writes
   `roofType`/`yearBuilt` **only when the stored column is currently `null`** (read the current
   property row in-tx; set only null fields). A human-edited (non-null) value is never
   overwritten. `county`/`lat`/`lng` behavior unchanged unless trivially covered.

### 7. Lead notes UI — minimal merged feed

- Server action `addLeadNote(leadId, body)`: insert `lead_note` with `authorUserId` resolved
  via the `resolveLocalUserId` pattern (from #170); revalidate `/leads/[id]`. Reject empty body.
- Quick-add input on the lead tile ("dog in backyard", "south facet soft decking").
- `getLeadDetail` (or a sibling query) returns notes; the lead comms card becomes a merged
  **notes + comms** feed: local `type LeadFeedItem = { kind: "note" | "comm"; at: string;
  body: string; author?: string }`, sorted `desc` by `at`. Author name shown on note rows.
- Append-only: no edit/delete UI.

## Testing (TDD, red-first)

**Core unit (no DB):**
- `effectiveRoofAge`: replacement present → years since replacement; absent but year_built →
  years since built; neither → `null`; injected `now`.
- `deriveLane`: secondary `tile` → "tile"; storm precedence over tile; neither → "standard".
- `canEnrichmentWriteReplacement`: `owner_reported` existing blocks `assessor`/`permit`
  (**red-path a**); `null` existing allows any; higher rank overwrites lower.

**DB / integration:**
- Migration 0070 applies; `roof_type_secondary`, `last_roof_replacement_at`,
  `last_roof_replacement_source` round-trip; `lead_note` insert + tenant-scoped read.
- `setPropertyRoofTypes` persists primary + secondary; secondary clears to null.
- `setRoofReplacement` writes date + `owner_reported`.
- `addLeadNote` inserts with author; no update/delete path exists.
- Enrichment gap-fill: property with existing non-null `roofType` is **preserved** when
  stormproof enrichment runs (**red-path**); null field is filled.

**e2e (Playwright, signed-in):**
- RoofTypeEditor shows primary + secondary; setting secondary persists.
- Replacement date/source inline edit persists and shows.
- Quick-add note appears in the merged feed with author + timestamp.

**Red-path (spec-required):**
- (a) enrichment overwrite of `owner_reported` replacement rejected — via helper unit test.
- (b) secondary roof type flows into lane/"template" selection — `deriveLane` + `lead-intake`
  fallback test with a secondary-tile lead landing in the tile lane.

## Deploy + prove it (post-merge, owner-gated)

1. Merge PR; CI green (build + e2e).
2. Apply migration 0070 to **prod Supabase** from this worktree: pooler (6543) can't run DDL →
   apply via Supabase MCP `apply_migration` + insert the manual `drizzle.__drizzle_migrations`
   ledger row so `db:migrate` skips it (same pattern as 0068/0069).
3. Verify columns + a round-trip with a direct query.
4. Confirm live as a signed-in Bloom user: set a secondary roof type + a replacement date on a
   lead, add a note, see it in the feed.
5. PR description lists: migration number applied, the (zero) invariants bound, live-verify output.

## House rules (unchanged)

TDD; one PR for the slice; watch CI (`gh pr checks <n> --watch`). Per-tenant timezone. No
literal secrets. Parsed/enriched values never overwrite owner-confirmed data. Update
`first-20-cells.md` STATUS only if evidence states change (they don't here) — log as
post-contract work in the PR description.
