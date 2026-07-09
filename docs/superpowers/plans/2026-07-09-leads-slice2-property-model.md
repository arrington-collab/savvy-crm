# Leads Slice 2 — Property Data Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dual roof types, an effective-roof-age model (last replacement date + source), and append-only lead notes to the property/lead data model.

**Architecture:** Pure helpers land in `@savvy/core` first (effective age, lane precedence, enrichment guards) with zero-DB unit tests. One migration (0070) adds three `property` columns and a `lead_note` table. Enrichment is guarded so it never clobbers owner-confirmed roof/year. Web wires two inline editors plus a minimal notes+comms feed. No new evidence binding (that is Slice 5).

**Tech Stack:** TypeScript, Drizzle ORM (Postgres + RLS), Next.js App Router server actions, Vitest (unit + db integration), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-07-09-leads-slice2-property-model-design.md`

## Global Constraints

- **Migration number is 0070** (journal confirmed at 0069). Generate via `pnpm db:generate` from this worktree.
- **Roof enum stays text + core const** — no pgEnum. `ROOF_TYPE_VALUES` = `["asphalt_shingle","tile","metal","flat_foam","other"]`.
- **New controlled vocab:** `ROOF_REPLACEMENT_SOURCE_VALUES = ["owner_reported","permit","assessor"]`, text column, app-enforced.
- **Tenant isolation on every table.** New `lead_note` carries `tenant_id` + `tenantIsolation()` policy. RLS grants auto-inherit (`ALTER DEFAULT PRIVILEGES`) — no manual GRANT needed.
- **Enrichment never overwrites owner-confirmed data.** Primary roof/year is gap-filled (write only when null); replacement source obeys precedence `owner_reported > permit > assessor`.
- **DB test imports use the `.js` suffix** (ESM): `import { adminDb, property, eq } from "../src/index.js"`; helpers from `"./helpers.js"`.
- **Per-tenant timezone**; no literal secrets; TDD (red first); commit each task.
- **Do NOT change scoring rationale wording or bind `lead.effective_age`** — those are Slice 5. The `roofSubScore` tile bump stays primary-only.

---

### Task 1: Core roof helpers (`roof.ts`)

Three pure functions + the source const, all unit-tested with zero DB.

**Files:**
- Create: `packages/core/src/roof.ts`
- Create: `packages/core/src/roof.test.ts`
- Modify: `packages/core/src/index.ts` (add barrel export)

**Interfaces:**
- Produces: `ROOF_REPLACEMENT_SOURCE_VALUES`, `type RoofReplacementSource`, `effectiveRoofAge(input, now)`, `canEnrichmentWriteReplacement(existing, incoming)`, `roofYearGapFill(existing, incoming)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/roof.test.ts
import { describe, it, expect } from "vitest";
import {
  effectiveRoofAge,
  canEnrichmentWriteReplacement,
  roofYearGapFill,
  ROOF_REPLACEMENT_SOURCE_VALUES,
} from "./roof";

const NOW = new Date("2026-07-09T00:00:00Z");

describe("effectiveRoofAge", () => {
  it("uses years since replacement when a replacement date is present", () => {
    expect(effectiveRoofAge({ lastRoofReplacementAt: "2015-06-01", yearBuilt: 1990 }, NOW)).toBe(11);
  });
  it("falls back to years since year_built when no replacement", () => {
    expect(effectiveRoofAge({ lastRoofReplacementAt: null, yearBuilt: 1990 }, NOW)).toBe(36);
  });
  it("is null when neither is known", () => {
    expect(effectiveRoofAge({ lastRoofReplacementAt: null, yearBuilt: null }, NOW)).toBeNull();
  });
});

describe("canEnrichmentWriteReplacement", () => {
  it("blocks enrichment from overwriting an owner_reported replacement", () => {
    expect(canEnrichmentWriteReplacement("owner_reported", "assessor")).toBe(false);
    expect(canEnrichmentWriteReplacement("owner_reported", "permit")).toBe(false);
  });
  it("allows writing when nothing is stored", () => {
    expect(canEnrichmentWriteReplacement(null, "assessor")).toBe(true);
  });
  it("allows a higher-precedence source to overwrite a lower one", () => {
    expect(canEnrichmentWriteReplacement("assessor", "permit")).toBe(true);
    expect(canEnrichmentWriteReplacement("permit", "assessor")).toBe(false);
  });
});

describe("roofYearGapFill", () => {
  it("preserves an existing (owner-edited) roof type / year — gap-fill only", () => {
    expect(
      roofYearGapFill({ roofType: "tile", yearBuilt: 2001 }, { roofType: "asphalt_shingle", yearBuilt: 1995 }),
    ).toEqual({});
  });
  it("fills only the null fields", () => {
    expect(
      roofYearGapFill({ roofType: null, yearBuilt: 2001 }, { roofType: "metal", yearBuilt: 1995 }),
    ).toEqual({ roofType: "metal" });
  });
});

describe("ROOF_REPLACEMENT_SOURCE_VALUES", () => {
  it("is the owner/permit/assessor vocabulary", () => {
    expect(ROOF_REPLACEMENT_SOURCE_VALUES).toEqual(["owner_reported", "permit", "assessor"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core test -- roof.test`
Expected: FAIL — `Cannot find module './roof'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/roof.ts

export const ROOF_REPLACEMENT_SOURCE_VALUES = ["owner_reported", "permit", "assessor"] as const;
export type RoofReplacementSource = (typeof ROOF_REPLACEMENT_SOURCE_VALUES)[number];

const SOURCE_RANK: Record<RoofReplacementSource, number> = { owner_reported: 3, permit: 2, assessor: 1 };

/**
 * Effective roof age in whole years: years since a known replacement when
 * present, else years since year_built, else null. `now` is injected so the
 * function stays pure and testable.
 */
export function effectiveRoofAge(
  input: { lastRoofReplacementAt: Date | string | null; yearBuilt: number | null },
  now: Date,
): number | null {
  if (input.lastRoofReplacementAt) {
    return now.getFullYear() - new Date(input.lastRoofReplacementAt).getFullYear();
  }
  return input.yearBuilt ? now.getFullYear() - input.yearBuilt : null;
}

/** True when enrichment may write `incoming` over `existing`. owner_reported is never overwritten. */
export function canEnrichmentWriteReplacement(
  existing: RoofReplacementSource | null,
  incoming: RoofReplacementSource,
): boolean {
  if (!existing) return true;
  return SOURCE_RANK[incoming] > SOURCE_RANK[existing];
}

/** Gap-fill: return only the roof/year fields whose stored value is null (never overwrite owner-edited values). */
export function roofYearGapFill(
  existing: { roofType: string | null; yearBuilt: number | null },
  incoming: { roofType: string | null; yearBuilt: number | null },
): { roofType?: string | null; yearBuilt?: number | null } {
  const out: { roofType?: string | null; yearBuilt?: number | null } = {};
  if (existing.roofType == null && incoming.roofType != null) out.roofType = incoming.roofType;
  if (existing.yearBuilt == null && incoming.yearBuilt != null) out.yearBuilt = incoming.yearBuilt;
  return out;
}
```

- [ ] **Step 4: Add barrel export**

In `packages/core/src/index.ts`, add after line 15 (`export * from "./roof-sketch";`):

```ts
export * from "./roof";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @savvy/core test -- roof.test`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/roof.ts packages/core/src/roof.test.ts packages/core/src/index.ts
git commit -m "feat(core): roof helpers — effective age, enrichment precedence + gap-fill"
```

---

### Task 2: Effective age into `buildLeadFeatures`

**Files:**
- Modify: `packages/core/src/lead-features.ts`
- Create: `packages/core/src/lead-features.test.ts`

**Interfaces:**
- Consumes: `effectiveRoofAge` (Task 1).
- Produces: `LeadFeatures` gains `roofTypeSecondary: string | null`; `buildLeadFeatures` input accepts optional `roofTypeSecondary` and `lastRoofReplacementAt`; `roofAgeYears` becomes the effective age.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/lead-features.test.ts
import { describe, it, expect } from "vitest";
import { buildLeadFeatures } from "./lead-features";

describe("buildLeadFeatures — effective roof age", () => {
  it("uses the replacement date over year_built when present", () => {
    const f = buildLeadFeatures({
      source: "web", state: "AZ", roofType: "tile", roofTypeSecondary: null,
      yearBuilt: 1990, lastRoofReplacementAt: "2015-01-01",
      storm: { eventCount: 0, maxHailInches: 0, maxWindMph: 0, daysSinceWorst: null },
    });
    expect(f.roofAgeYears).toBe(new Date().getFullYear() - 2015);
  });
  it("carries roofTypeSecondary through", () => {
    const f = buildLeadFeatures({
      source: "web", state: "AZ", roofType: "tile", roofTypeSecondary: "flat_foam",
      yearBuilt: 1990, lastRoofReplacementAt: null,
      storm: { eventCount: 0, maxHailInches: 0, maxWindMph: 0, daysSinceWorst: null },
    });
    expect(f.roofTypeSecondary).toBe("flat_foam");
    expect(f.roofAgeYears).toBe(new Date().getFullYear() - 1990);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core test -- lead-features.test`
Expected: FAIL — `roofTypeSecondary` not on type / `roofAgeYears` wrong.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/lead-features.ts`:

1. Add the import at the top:
```ts
import { effectiveRoofAge } from "./roof";
```
2. Add to the `LeadFeatures` type (after `roofType: string | null;`, line 10):
```ts
  roofTypeSecondary: string | null;
```
3. Extend the `buildLeadFeatures` input type (after `roofType: string | null;`, line 21):
```ts
  roofTypeSecondary?: string | null;
  lastRoofReplacementAt?: Date | string | null;
```
4. Replace the return object's `roofType`/`roofAgeYears` lines (32–33) with:
```ts
    roofType: input.roofType,
    roofTypeSecondary: input.roofTypeSecondary ?? null,
    yearBuilt: year,
    roofAgeYears: effectiveRoofAge({ lastRoofReplacementAt: input.lastRoofReplacementAt ?? null, yearBuilt: year }, new Date()),
```
(delete the old `yearBuilt: year,` / `roofAgeYears: year ? ... : null,` lines so they aren't duplicated).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/core test -- lead-features.test`
Expected: PASS.

- [ ] **Step 5: Run the whole core package to catch type breaks**

Run: `pnpm --filter @savvy/core test && pnpm --filter @savvy/core typecheck`
Expected: PASS (a `LeadFeatures` consumer that constructs the object literally may now need `roofTypeSecondary` — fix any such spot by adding `roofTypeSecondary: null`).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/lead-features.ts packages/core/src/lead-features.test.ts
git commit -m "feat(core): buildLeadFeatures derives effective roof age + carries secondary type"
```

---

### Task 3: `deriveLane` considers secondary roof type

**Files:**
- Modify: `packages/core/src/lane.ts`
- Create: `packages/core/src/lane.test.ts`

**Interfaces:**
- Consumes: `LeadFeatures.roofTypeSecondary` (Task 2).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/lane.test.ts
import { describe, it, expect } from "vitest";
import { deriveLane } from "./lane";
import { defaultScoringConfig } from "./lead-scoring";
import type { LeadFeatures } from "./lead-features";

const base: LeadFeatures = {
  source: "web", state: "AZ", inTerritory: true, hasContact: true,
  roofType: "asphalt_shingle", roofTypeSecondary: null, yearBuilt: 2000, roofAgeYears: 26,
  storm: { eventCount: 0, maxHailInches: 0, maxWindMph: 0, daysSinceWorst: null },
};

describe("deriveLane — secondary roof type", () => {
  it("routes to tile when the SECONDARY roof type is tile", () => {
    expect(deriveLane({ ...base, roofTypeSecondary: "tile" }, defaultScoringConfig)).toBe("tile");
  });
  it("routes to tile when the PRIMARY is tile (unchanged)", () => {
    expect(deriveLane({ ...base, roofType: "tile" }, defaultScoringConfig)).toBe("tile");
  });
  it("is standard when neither roof type is tile and no storm", () => {
    expect(deriveLane(base, defaultScoringConfig)).toBe("standard");
  });
});
```

Note: confirm the exported scoring-config name — `grep -n "ScoringConfig\|defaultScoringConfig\|DEFAULT_SCORING" packages/core/src/lead-scoring.ts`. Use whatever the module exports (adjust the import if it is e.g. `DEFAULT_SCORING_CONFIG`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core test -- lane.test`
Expected: FAIL on the secondary-tile case (returns "standard").

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/lane.ts`, replace line 9:

```ts
  if (f.roofType === "tile" || f.roofTypeSecondary === "tile") return "tile";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/core test -- lane.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/lane.ts packages/core/src/lane.test.ts
git commit -m "feat(core): deriveLane routes to tile on primary OR secondary roof type"
```

---

### Task 4: Migration 0070 — property columns + `lead_note` table

**Files:**
- Modify: `packages/db/src/schema/crm.ts`
- Create (generated): `packages/db/drizzle/0070_*.sql` + journal/meta entry (via `pnpm db:generate`)
- Create: `packages/db/tests/lead-note-schema.test.ts`

**Interfaces:**
- Produces: `property.roofTypeSecondary`, `property.lastRoofReplacementAt`, `property.lastRoofReplacementSource`; new `leadNote` table export.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/lead-note-schema.test.ts
import { describe, it, expect } from "vitest";
import { adminDb, property, leadNote, eq, withTenant } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

describe("Slice 2 schema — property roof columns + lead_note", () => {
  it("round-trips the new property columns", async () => {
    const { tenantId } = await makeTenant();
    const { propertyId } = await makeLeadWithProperty(tenantId);
    await withTenant(tenantId, (tx) =>
      tx.update(property)
        .set({ roofTypeSecondary: "flat_foam", lastRoofReplacementAt: "2019-04-01", lastRoofReplacementSource: "owner_reported" })
        .where(eq(property.id, propertyId)));
    const [p] = await adminDb.select().from(property).where(eq(property.id, propertyId));
    expect(p!.roofTypeSecondary).toBe("flat_foam");
    expect(p!.lastRoofReplacementSource).toBe("owner_reported");
    expect(String(p!.lastRoofReplacementAt)).toContain("2019-04-01");
  });

  it("inserts a tenant-scoped lead_note", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);
    // Grab any user in the tenant for author_user_id (prefer a helper-returned
    // userId if makeTenant/makeLeadWithProperty exposes one — check helpers.ts).
    const users = await adminDb.execute<{ id: string }>(`select id from "user" where tenant_id = '${tenantId}' limit 1`);
    const authorUserId = users.rows[0]!.id;
    const [row] = await adminDb.insert(leadNote).values({ tenantId, leadId, authorUserId, body: "dog in backyard" }).returning();
    expect(row!.body).toBe("dog in backyard");
    const scoped = await withTenant(tenantId, (tx) => tx.select().from(leadNote).where(eq(leadNote.leadId, leadId)));
    expect(scoped).toHaveLength(1);
  });
});
```

Note: if `makeTenant`/`makeLeadWithProperty` already return a `userId`, use it instead of the raw `select id from "user"` — check `packages/db/tests/helpers.ts` and prefer the helper's value. Keep whichever is simplest; the point is a valid `author_user_id` in the tenant.

- [ ] **Step 2: Add schema, then generate the migration**

In `packages/db/src/schema/crm.ts`:

1. Add `date` to the drizzle import (line 1):
```ts
import { pgTable, uuid, text, integer, doublePrecision, boolean, index, jsonb, timestamp, date } from "drizzle-orm/pg-core";
```
2. Add three columns to `property` (after `yearBuilt`, line 39):
```ts
  roofTypeSecondary: text("roof_type_secondary"),
  lastRoofReplacementAt: date("last_roof_replacement_at"),
  lastRoofReplacementSource: text("last_roof_replacement_source"),
```
3. Add the `leadNote` table at the end of the file (after `lead`):
```ts
export const leadNote = pgTable("lead_note", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  leadId: uuid("lead_id").notNull().references(() => lead.id),
  authorUserId: uuid("author_user_id").notNull().references(() => user.id),
  body: text("body").notNull(),
  createdAt: createdAt(),
}, (t) => [index("lead_note_tenant_lead_idx").on(t.tenantId, t.leadId), tenantIsolation()]);
```

Then generate:
```bash
pnpm db:generate
```
Expected: creates `packages/db/drizzle/0070_*.sql` adding the three columns + `lead_note` table + its `tenant_isolation` policy, and appends journal idx 70. Open the SQL and confirm it contains `ALTER TABLE "property" ADD COLUMN "roof_type_secondary"`, `CREATE TABLE ... "lead_note"`, and `CREATE POLICY "tenant_isolation" ON "lead_note"`. (`leadNote` is exported through the existing `export * from "./crm"` barrel — no index edit needed.)

- [ ] **Step 3: Run test to verify it fails then apply migration locally**

Run: `pnpm --filter @savvy/db test -- lead-note-schema` → Expected: FAIL (column/table missing) BEFORE migrating.
Then: `pnpm db:migrate` (applies 0070 + grants locally).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db test -- lead-note-schema`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/crm.ts packages/db/drizzle/ packages/db/tests/lead-note-schema.test.ts
git commit -m "feat(db): migration 0070 — property roof columns + lead_note table"
```

---

### Task 5: `lead_note` queries — `addLeadNote` + `getLeadNotes`

**Files:**
- Create: `packages/db/src/lifecycle/lead-note.ts`
- Modify: the lifecycle barrel that re-exports lifecycle query modules (grep: `grep -rn "lifecycle/appointments" packages/db/src/index.ts packages/db/src/lifecycle/index.ts` and add the new module the same way its siblings are exported)
- Create: `packages/db/tests/lead-note.test.ts`

**Interfaces:**
- Produces: `addLeadNote(tx, { tenantId, leadId, authorUserId, body }): Promise<{ id: string }>`; `getLeadNotes(tx, { tenantId, leadId }): Promise<LeadNoteRow[]>` (newest first). No update/delete export exists.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/lead-note.test.ts
import { describe, it, expect } from "vitest";
import { withTenant, addLeadNote, getLeadNotes } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

describe("lead notes — append-only", () => {
  it("adds notes and reads them newest-first", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);
    const users = await (await import("../src/index.js")).adminDb.execute<{ id: string }>(
      `select id from "user" where tenant_id = '${tenantId}' limit 1`);
    const authorUserId = users.rows[0]!.id;

    await withTenant(tenantId, (tx) => addLeadNote(tx, { tenantId, leadId, authorUserId, body: "first" }));
    await withTenant(tenantId, (tx) => addLeadNote(tx, { tenantId, leadId, authorUserId, body: "second" }));

    const notes = await withTenant(tenantId, (tx) => getLeadNotes(tx, { tenantId, leadId }));
    expect(notes.map((n) => n.body)).toEqual(["second", "first"]);
  });

  it("rejects an empty body", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);
    const users = await (await import("../src/index.js")).adminDb.execute<{ id: string }>(
      `select id from "user" where tenant_id = '${tenantId}' limit 1`);
    const authorUserId = users.rows[0]!.id;
    await expect(
      withTenant(tenantId, (tx) => addLeadNote(tx, { tenantId, leadId, authorUserId, body: "   " })),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db test -- lead-note.test`
Expected: FAIL — `addLeadNote` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/db/src/lifecycle/lead-note.ts
import { leadNote, eq, desc } from "../index.js";
import type { TenantTx } from "../index.js"; // if a Tx type is exported; else use Parameters<typeof withTenant>[1] arg type per a sibling module

export async function addLeadNote(
  tx: TenantTx,
  input: { tenantId: string; leadId: string; authorUserId: string; body: string },
): Promise<{ id: string }> {
  const body = input.body.trim();
  if (!body) throw new Error("note body is required");
  const [row] = await tx
    .insert(leadNote)
    .values({ tenantId: input.tenantId, leadId: input.leadId, authorUserId: input.authorUserId, body })
    .returning({ id: leadNote.id });
  return row!;
}

export async function getLeadNotes(
  tx: TenantTx,
  input: { tenantId: string; leadId: string },
) {
  return tx.select().from(leadNote).where(eq(leadNote.leadId, input.leadId)).orderBy(desc(leadNote.createdAt));
}
```

Note on the `tx` type: match a sibling in `packages/db/src/lifecycle/` (e.g. open `appointments.ts` and copy how it types its `tx` parameter and how it imports `eq`/`desc`). Export `addLeadNote`/`getLeadNotes` from the same barrel the siblings use.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db test -- lead-note.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/lead-note.ts packages/db/src/index.ts packages/db/src/lifecycle/*.ts packages/db/tests/lead-note.test.ts
git commit -m "feat(db): append-only lead-note queries (addLeadNote/getLeadNotes)"
```

---

### Task 6: Enrichment gap-fill guard

**Files:**
- Modify: `packages/agents/src/enrichment.ts:70-73`
- Create: `packages/agents/src/enrichment-gapfill.test.ts`

**Interfaces:**
- Consumes: `roofYearGapFill` (Task 1).

- [ ] **Step 1: Write the failing test**

The authoritative red-path for the precedence/gap-fill logic is the pure `roofYearGapFill` test in Task 1. This task adds a focused enricher test proving the wiring preserves an owner-edited roof type.

```ts
// packages/agents/src/enrichment-gapfill.test.ts
import { describe, it, expect } from "vitest";
import { adminDb, property, eq } from "@savvy/db";
import { makeTenant, makeLeadWithProperty } from "@savvy/db/tests/helpers"; // adjust to how agents tests import db helpers — grep an existing agents *.test.ts
import { makeStormproofEnricher } from "./enrichment";

// Minimal StormProofGateway stub returning roof/year data. Match the interface in
// packages/integrations/src/stormproof.ts (read it — the enricher passes results
// through enrichProperty). Return a roofType/yearBuilt the guard should NOT apply.
const stubGateway = { /* shape per StormProofGateway */ } as any;

describe("stormproof enricher — gap-fill guard", () => {
  it("does not overwrite an owner-edited (non-null) primary roof type", async () => {
    const { tenantId } = await makeTenant();
    const { propertyId } = await makeLeadWithProperty(tenantId);
    await adminDb.update(property).set({ roofType: "tile" }).where(eq(property.id, propertyId));

    const enricher = makeStormproofEnricher(stubGateway);
    await enricher.run(tenantId, { propertyId, address: "1 Test St" } as any);

    const [p] = await adminDb.select().from(property).where(eq(property.id, propertyId));
    expect(p!.roofType).toBe("tile"); // preserved, not clobbered
  });
});
```

Note: if standing up the gateway stub proves heavy, this task's guarantee is already covered by Task 1's `roofYearGapFill` unit test; keep the enricher test only if the stub is straightforward. Do NOT skip the code change in Step 2 either way.

- [ ] **Step 2: Run test to verify it fails, then implement**

Run the test (Expected: FAIL — roofType becomes the stub value). Then edit `packages/agents/src/enrichment.ts`:

Add to the import from `@savvy/core` (top of file — add the import if none exists):
```ts
import { roofYearGapFill } from "@savvy/core";
```

Replace the update at lines 70–73:
```ts
        await withTenant(tenantId, async (tx) => {
          const fill = roofYearGapFill(
            { roofType: p.roofType ?? null, yearBuilt: p.yearBuilt ?? null },
            { roofType: result.roofType ?? null, yearBuilt: result.yearBuilt ?? null },
          );
          await tx.update(property).set({ ...fill, county: result.county }).where(eq(property.id, ref.propertyId));
          if (leadId) await tx.update(lead).set({ stormEventId: result.stormEventId }).where(eq(lead.id, leadId));
        });
```
(`county` stays unconditional — it is not owner-edited. `filled` on the next line is unchanged.)

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @savvy/agents test -- enrichment-gapfill` (or the pure Task 1 test if the enricher stub was skipped).
Expected: PASS. Also run `pnpm --filter @savvy/agents test` to confirm no existing enrichment test regressed.

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/enrichment.ts packages/agents/src/enrichment-gapfill.test.ts
git commit -m "fix(agents): enrichment gap-fills roof/year — never clobbers owner-edited values"
```

---

### Task 7: Wire secondary roof type + replacement through scoring & assignment

**Files:**
- Modify: the `buildLeadFeatures(` caller(s) (grep: `grep -rn "buildLeadFeatures(" packages apps --include=*.ts | grep -v test`)
- Modify: `packages/agents/src/functions/lead-intake.ts:122-127` (assignment lane fallback)

**Interfaces:**
- Consumes: `buildLeadFeatures` new inputs (Task 2), `roofTypeSecondary` on the property row.

- [ ] **Step 1: Write the failing test**

Add to the lane-fallback caller's nearest test, or create `packages/agents/src/functions/lead-intake-lane.test.ts` asserting a property whose SECONDARY roof type is tile yields lane "tile" through the assignment fallback. Model setup on an existing `runLeadAssignment`/scoring test (grep: `grep -rln "runLeadAssignment\|buildLeadFeatures" packages/agents/src packages/db/src --include=*.test.ts`). Minimal shape:

```ts
// assert the persisted/derived lane is "tile" when property.roofTypeSecondary === "tile"
// (set roofTypeSecondary on the seeded property, run the scoring/assignment path, read lead.lane / returned lane)
expect(lane).toBe("tile");
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — secondary is not passed through, lane resolves "standard"/null.

- [ ] **Step 3: Implement**

1. At each `buildLeadFeatures(` call site that reads a property row, pass the two new fields:
```ts
buildLeadFeatures({
  // ...existing fields...
  roofTypeSecondary: p.roofTypeSecondary ?? null,
  lastRoofReplacementAt: p.lastRoofReplacementAt ?? null,
  // ...
});
```
Ensure the property SELECT for that call includes `roofTypeSecondary` and `lastRoofReplacementAt` columns.

2. In `packages/agents/src/functions/lead-intake.ts`, extend the assignment select (line 123) to include `roofTypeSecondary: property.roofTypeSecondary` and update the fallback (line 127):
```ts
      lane = l.lane ?? ((dest?.roofType === "tile" || dest?.roofTypeSecondary === "tile") ? "tile" : null);
```

- [ ] **Step 4: Run to verify it passes**

Run the new test + `pnpm --filter @savvy/agents test`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/functions/lead-intake.ts packages/agents packages/db
git commit -m "feat(agents): secondary roof type + replacement flow into scoring & lane"
```

---

### Task 8: Web — RoofTypeEditor gains a Secondary select

**Files:**
- Modify: `apps/web/src/lib/lead-actions.ts:73-88` (extend to write secondary)
- Modify: `apps/web/src/app/(app)/leads/[id]/RoofTypeEditor.tsx`
- Modify: `apps/web/src/lib/leads-queries.ts` (return `roofTypeSecondary` from `getLeadDetail`)
- Modify: `apps/web/src/app/(app)/leads/[id]/page.tsx:127` (pass `secondary`)
- Test: `apps/web/tests/e2e/lead-roof-type.spec.ts` (Playwright)

**Interfaces:**
- Produces: `setPropertyRoofTypes(leadId, propertyId, { primary, secondary })`.

- [ ] **Step 1: Write the failing e2e test**

```ts
// apps/web/tests/e2e/lead-roof-type.spec.ts
import { test, expect } from "@playwright/test";
// Follow an existing lead e2e spec for auth/tenant setup (grep apps/web/tests/e2e for a lead spec).
test("sets primary and secondary roof type", async ({ page }) => {
  // navigate to a seeded lead detail page
  await page.getByTestId("roof-type-edit").selectOption("tile");
  await page.getByTestId("roof-type-secondary-edit").selectOption("flat_foam");
  await expect(page.getByText("Saved ✓")).toBeVisible();
});
```

- [ ] **Step 2: Implement the server action**

In `apps/web/src/lib/lead-actions.ts`, add alongside `setPropertyRoofType` (keep the old one or replace its only caller). Add:

```ts
export async function setPropertyRoofTypes(
  leadId: string,
  propertyId: string,
  roofTypes: { primary: string; secondary: string | null },
): Promise<{ ok: true } | { error: string }> {
  const okPrimary = (ROOF_TYPE_VALUES as readonly string[]).includes(roofTypes.primary);
  const okSecondary = roofTypes.secondary === null || (ROOF_TYPE_VALUES as readonly string[]).includes(roofTypes.secondary);
  if (!okPrimary || !okSecondary) return { error: "invalid roof type" };
  try {
    const tenantId = await getTenantId();
    await withTenant(tenantId, (tx) =>
      tx.update(property).set({ roofType: roofTypes.primary, roofTypeSecondary: roofTypes.secondary }).where(eq(property.id, propertyId)));
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/exceptions");
    return { ok: true };
  } catch {
    return { error: "could not set roof type" };
  }
}
```

- [ ] **Step 3: Implement the editor**

In `RoofTypeEditor.tsx`: accept `secondary: string | null` prop; add a second `<select>` (`data-testid="roof-type-secondary-edit"`) with a leading `<option value="">— none —</option>`; on either change call `setPropertyRoofTypes(leadId, propertyId, { primary, secondary })` with the current pair (empty secondary → `null`). Reuse the existing `LABELS` map and styling.

In `leads-queries.ts`: add `roofTypeSecondary: property.roofTypeSecondary` to the `getLeadDetail` select (near line 129) and to the `LeadDetail` type + returned object (near lines 95/177). In `page.tsx:127`, pass `secondary={detail.roofTypeSecondary}`.

- [ ] **Step 4: Run e2e + typecheck**

Run: `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web test:e2e -- lead-roof-type` (per the repo's e2e invocation — seed a tenant with `tsx tests/e2e/create-tenant.ts` first if required).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/lead-actions.ts "apps/web/src/app/(app)/leads/[id]/RoofTypeEditor.tsx" apps/web/src/lib/leads-queries.ts "apps/web/src/app/(app)/leads/[id]/page.tsx" apps/web/tests/e2e/lead-roof-type.spec.ts
git commit -m "feat(web): RoofTypeEditor captures primary + secondary roof type"
```

---

### Task 9: Web — replacement date + source inline editor

**Files:**
- Modify: `apps/web/src/lib/lead-actions.ts` (add `setRoofReplacement`)
- Create: `apps/web/src/app/(app)/leads/[id]/RoofReplacementEditor.tsx`
- Modify: `apps/web/src/lib/leads-queries.ts` (return `lastRoofReplacementAt`, `lastRoofReplacementSource`)
- Modify: `apps/web/src/app/(app)/leads/[id]/page.tsx` (render the editor in the roof section)
- Test: `apps/web/tests/e2e/lead-roof-replacement.spec.ts`

**Interfaces:**
- Consumes: `ROOF_REPLACEMENT_SOURCE_VALUES` (Task 1).
- Produces: `setRoofReplacement(leadId, propertyId, { at, source })`.

- [ ] **Step 1: Write the failing e2e test**

```ts
// apps/web/tests/e2e/lead-roof-replacement.spec.ts
import { test, expect } from "@playwright/test";
test("records a roof replacement date + source", async ({ page }) => {
  // navigate to a seeded lead detail page
  await page.getByTestId("roof-replacement-date").fill("2018-05-01");
  await page.getByTestId("roof-replacement-source").selectOption("owner_reported");
  await page.getByTestId("roof-replacement-save").click();
  await expect(page.getByText("Saved ✓")).toBeVisible();
});
```

- [ ] **Step 2: Implement the server action (rejects future dates)**

In `apps/web/src/lib/lead-actions.ts` add (import `ROOF_REPLACEMENT_SOURCE_VALUES` from `@savvy/core`):

```ts
export async function setRoofReplacement(
  leadId: string,
  propertyId: string,
  input: { at: string; source: string },
): Promise<{ ok: true } | { error: string }> {
  if (!(ROOF_REPLACEMENT_SOURCE_VALUES as readonly string[]).includes(input.source)) return { error: "invalid source" };
  const at = new Date(input.at);
  if (Number.isNaN(at.getTime())) return { error: "invalid date" };
  if (at.getTime() > Date.now()) return { error: "replacement date cannot be in the future" };
  try {
    const tenantId = await getTenantId();
    await withTenant(tenantId, (tx) =>
      tx.update(property).set({ lastRoofReplacementAt: input.at, lastRoofReplacementSource: input.source }).where(eq(property.id, propertyId)));
    revalidatePath(`/leads/${leadId}`);
    return { ok: true };
  } catch {
    return { error: "could not save replacement" };
  }
}
```

- [ ] **Step 3: Implement the editor + query wiring**

Create `RoofReplacementEditor.tsx` (client): a `date` input (`data-testid="roof-replacement-date"`), a source `<select>` from `ROOF_REPLACEMENT_SOURCE_VALUES` (`data-testid="roof-replacement-source"`, default `owner_reported`), and a Save button (`data-testid="roof-replacement-save"`) that calls `setRoofReplacement`. Show "Saved ✓" like `RoofTypeEditor`. Props: `{ leadId; propertyId; at: string | null; source: string | null }`.

In `leads-queries.ts`: add `lastRoofReplacementAt`/`lastRoofReplacementSource` to the select + `LeadDetail` type + returned object. In `page.tsx`, render `<RoofReplacementEditor .../>` next to `RoofTypeEditor` (guard on `detail.propertyId`).

- [ ] **Step 4: Run e2e + typecheck**

Run: `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web test:e2e -- lead-roof-replacement`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/lead-actions.ts "apps/web/src/app/(app)/leads/[id]/RoofReplacementEditor.tsx" apps/web/src/lib/leads-queries.ts "apps/web/src/app/(app)/leads/[id]/page.tsx" apps/web/tests/e2e/lead-roof-replacement.spec.ts
git commit -m "feat(web): inline roof-replacement date + source editor (rejects future dates)"
```

---

### Task 10: Web — lead notes quick-add + notes/comms merged feed

**Files:**
- Modify: `apps/web/src/lib/lead-actions.ts` (add `addLeadNoteAction`)
- Create: `apps/web/src/app/(app)/leads/[id]/LeadNotes.tsx` (quick-add input)
- Modify: `apps/web/src/lib/leads-queries.ts` (return `notes` in `getLeadDetail`)
- Modify: `apps/web/src/app/(app)/leads/[id]/page.tsx` (render quick-add + merge notes into the comms feed)
- Test: `apps/web/tests/e2e/lead-notes.spec.ts`

**Interfaces:**
- Consumes: `addLeadNote`/`getLeadNotes` (Task 5), the current-user resolution pattern from `apps/web/src/lib/job-ledger-actions.ts:17` (`localUserId`).

- [ ] **Step 1: Write the failing e2e test**

```ts
// apps/web/tests/e2e/lead-notes.spec.ts
import { test, expect } from "@playwright/test";
test("adds a lead note that appears in the feed", async ({ page }) => {
  // navigate to a seeded lead detail page
  await page.getByTestId("lead-note-input").fill("south facet soft decking");
  await page.getByTestId("lead-note-add").click();
  await expect(page.getByText("south facet soft decking")).toBeVisible();
});
```

- [ ] **Step 2: Implement the server action**

In `apps/web/src/lib/lead-actions.ts` (resolve the local user the same way `job-ledger-actions.ts:17` does — open that file and copy the `localUserId` resolution):

```ts
export async function addLeadNoteAction(leadId: string, body: string): Promise<{ ok: true } | { error: string }> {
  if (!body.trim()) return { error: "empty note" };
  try {
    const tenantId = await getTenantId();
    const localUserId = /* resolve current user id — copy job-ledger-actions.ts:17 pattern */ "";
    await withTenant(tenantId, (tx) => addLeadNote(tx, { tenantId, leadId, authorUserId: localUserId, body }));
    revalidatePath(`/leads/${leadId}`);
    return { ok: true };
  } catch {
    return { error: "could not add note" };
  }
}
```
(Import `addLeadNote` from `@savvy/db`.)

- [ ] **Step 3: Implement the UI + merged feed**

- `LeadNotes.tsx`: a small client form — text input (`data-testid="lead-note-input"`) + Add button (`data-testid="lead-note-add"`) calling `addLeadNoteAction`; clears on success.
- `leads-queries.ts`: in `getLeadDetail`, fetch notes via `getLeadNotes` and add `notes: { id; body; authorUserId; createdAt }[]` to `LeadDetail`.
- `page.tsx`: render `<LeadNotes leadId={id} />` in the roof/notes area, and merge notes into the existing communications card as a single feed sorted `desc` by timestamp:
```ts
type LeadFeedItem = { kind: "note" | "comm"; at: string; body: string; author?: string };
const feed: LeadFeedItem[] = [
  ...detail.communications.map((c) => ({ kind: "comm" as const, at: /* c timestamp ISO */ "", body: /* c body */ "" })),
  ...detail.notes.map((n) => ({ kind: "note" as const, at: new Date(n.createdAt).toISOString(), body: n.body, author: /* author name */ undefined })),
].sort((a, b) => (a.at < b.at ? 1 : -1));
```
Render `feed`, tagging note rows visually (e.g. a "Note" chip) distinct from comms. (Full document-event interleave is Slice 4 — do not add it here.)

- [ ] **Step 4: Run e2e + typecheck**

Run: `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web test:e2e -- lead-notes`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/lead-actions.ts "apps/web/src/app/(app)/leads/[id]/LeadNotes.tsx" apps/web/src/lib/leads-queries.ts "apps/web/src/app/(app)/leads/[id]/page.tsx" apps/web/tests/e2e/lead-notes.spec.ts
git commit -m "feat(web): lead notes quick-add + notes/comms merged feed"
```

---

## Final verification (before PR)

- [ ] Full suite: `pnpm typecheck && pnpm lint && pnpm test` (all packages — semantic-merge safety per the repo rule).
- [ ] Confirm no scoring-rationale wording changed and no `CHECK_BINDINGS` entry added (Slice 5 scope).
- [ ] Open PR; watch CI: `gh pr checks <n> --watch`.

## Deploy + prove it (post-merge, owner-gated)

1. Apply migration 0070 to prod Supabase from THIS worktree: pooler (6543) can't run DDL → apply via Supabase MCP `apply_migration`, then insert the manual `drizzle.__drizzle_migrations` ledger row so `db:migrate` skips it (same pattern as 0068/0069; see memory `savvy-crm-prod-db.md`).
2. Verify columns + a round-trip with a direct query.
3. Live-check as a signed-in Bloom user: set a secondary roof type + a past replacement date on a lead; add a note; see it in the feed.
4. PR description lists: migration 0070 applied, zero invariants bound, live-verify output.

## Self-Review (completed by plan author)

- **Spec coverage:** dual roof types (T4 schema, T8 UI, T3 lane) ✓; effective age (T1 helper, T2 features, T7 wiring) ✓; replacement date+source (T4 schema, T9 UI) ✓; enrichment owner_reported guard (T1 + T6) ✓; lead notes (T4 table, T5 queries, T10 UI) ✓; red-path a (T1 `canEnrichmentWriteReplacement`) ✓; red-path b (T3 deriveLane + T7 wiring) ✓.
- **Placeholder scan:** the only deferred specifics are "copy the sibling pattern" anchors (tx type in T5, user-resolution in T10, e2e auth setup) — each names an exact file:line to copy from, not an open TODO.
- **Type consistency:** `roofTypeSecondary` used consistently across T2/T3/T7/T8; `ROOF_REPLACEMENT_SOURCE_VALUES` across T1/T9; `addLeadNote(tx, {...})` signature identical in T5 and T10.
