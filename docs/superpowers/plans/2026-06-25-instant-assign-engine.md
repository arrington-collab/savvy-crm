# Instant Assignment + Live Scheduling — Engine Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing assignment + scheduling engine with the primitives the live-booking front-ends need: zip-code territory assignment (round-robin tiebreak), today-first slot ranking, rep availability blocks, and an "is a rep free at this exact time?" check.

**Architecture:** Pure additive extensions to `packages/core` (assignment + ranking + availability logic) and `packages/db` (one new tenant-scoped table + one lifecycle reader). No front-end, no shared-service wiring — those are separate follow-on plans (Step 2: shared service; Step 3: quick-book screen). Every change is backward-compatible so the build/tests stay green without touching consumers yet.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres + RLS), Vitest, pnpm + Turborepo.

## Global Constraints

- **Source of truth is `origin/main`, NOT this working tree.** Execute this plan in a FRESH checkout of `origin/main` (`git fetch origin main && git checkout origin/main` into a clean worktree). The pre-existing local tree is stale and lacks Phase B–D code.
- **Import-extension rule (strict, differs by package):** files under `packages/db/src/schema/*` use **no** extension on relative imports (`from "./_rls"`); files under `packages/db/src/lifecycle/*` and all `packages/db` test files use **`.js`** extensions (`from "../tenant.js"`); `packages/core` files use **no** extension (`from "./lead-assignment"`). Match the file you are editing.
- **Tenant isolation on every new table** via `tenantIsolation()` + RLS; every DB integration test must assert cross-tenant reads return nothing.
- **Single zod instance:** import `z` from `@savvy/core` (re-exported), never from `"zod"` directly in cross-package schema code. Within `packages/core` itself, import `z` from `"./schemas"`.
- **No new global defaults flipped in this plan.** `parseAssignmentConfig` still defaults to `strategy: "off"`. The default → `territory` flip belongs to the settings/service plan (Step 2), not here.
- **DB tests prerequisite:** local Postgres up + migrated — `pnpm db:up && pnpm db:migrate` before running any `packages/db` test.

---

## File Structure

| File | Responsibility | New/Modified |
|---|---|---|
| `packages/core/src/lead-assignment.ts` | Add `zip` to `territoryRules` type + zod schema | Modify |
| `packages/core/src/pick-assignee.ts` | Zip-first territory match + round-robin tiebreak; `zip` on lead param | Modify |
| `packages/core/src/pick-assignee.test.ts` | Tests for zip match + round-robin tiebreak | Modify |
| `packages/core/src/scheduling.ts` | `rankSlots` gains optional `todayCutoff` (today-first bonus) | Modify |
| `packages/core/src/scheduling.test.ts` | Test today-first ranking | Modify (or create if absent) |
| `packages/core/src/availability.ts` | Pure `repsFreeAt` overlap check | Create |
| `packages/core/src/availability.test.ts` | Tests for `repsFreeAt` | Create |
| `packages/core/src/index.ts` | Export `availability` | Modify |
| `packages/db/src/schema/scheduling.ts` | `rep_availability_block` table | Create |
| `packages/db/src/schema/index.ts` | Re-export `scheduling` | Modify |
| `packages/db/drizzle/00NN_*.sql` | Generated migration for the new table | Create (generated) |
| `packages/db/src/lifecycle/availability.ts` | `getRepBlocks` reader | Create |
| `packages/db/src/lifecycle/availability.test.ts` | Integration test (insert + RLS isolation) | Create |
| `packages/db/src/index.ts` | Export `getRepBlocks` | Modify |

---

### Task 1: Zip-code territories + round-robin tiebreak (`packages/core`)

**Files:**
- Modify: `packages/core/src/lead-assignment.ts`
- Modify: `packages/core/src/pick-assignee.ts`
- Test: `packages/core/src/pick-assignee.test.ts`

**Interfaces:**
- Consumes: existing `AssignmentCandidate`, `roundRobin`, `inPool` helpers in `pick-assignee.ts`.
- Produces:
  - `AssignmentConfig.territoryRules: { zip?: string; state?: string; city?: string; userId: string }[]`
  - `pickAssignee(opts: { strategy; config; candidates; lead: { state: string|null; city: string|null; zip?: string|null; score: number|null; lane?: string|null } }): string | null` — territory branch matches **zip first**, then city/state, with **round-robin** tiebreak.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/pick-assignee.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { pickAssignee } from "./pick-assignee";
import type { AssignmentCandidate } from "./pick-assignee";

const cand = (userId: string, over: Partial<AssignmentCandidate> = {}): AssignmentCandidate => ({
  userId, openLeadCount: 0, lastAssignedAt: null, ...over,
});

describe("pickAssignee — zip territory", () => {
  const candidates = [cand("a"), cand("b"), cand("c")];

  it("routes by exact zip when a zip rule matches", () => {
    const got = pickAssignee({
      strategy: "territory",
      config: { strategy: "territory", territoryRules: [{ zip: "85203", userId: "b" }] },
      candidates,
      lead: { state: "AZ", city: "Mesa", zip: "85203", score: null },
    });
    expect(got).toBe("b");
  });

  it("breaks a multi-rep zip tie by round-robin (least recently assigned)", () => {
    const got = pickAssignee({
      strategy: "territory",
      config: {
        strategy: "territory",
        territoryRules: [{ zip: "85203", userId: "a" }, { zip: "85203", userId: "b" }],
      },
      candidates: [
        cand("a", { lastAssignedAt: "2026-06-25T10:00:00Z" }),
        cand("b", { lastAssignedAt: null }), // never assigned -> wins round-robin
      ],
      lead: { state: "AZ", city: "Mesa", zip: "85203", score: null },
    });
    expect(got).toBe("b");
  });

  it("falls back to round-robin across all when no zip/state rule matches", () => {
    const got = pickAssignee({
      strategy: "territory",
      config: { strategy: "territory", territoryRules: [{ zip: "99999", userId: "a" }] },
      candidates: [
        cand("a", { lastAssignedAt: "2026-06-25T10:00:00Z" }),
        cand("b", { lastAssignedAt: "2026-06-24T10:00:00Z" }), // older -> wins
        cand("c", { lastAssignedAt: "2026-06-25T11:00:00Z" }),
      ],
      lead: { state: "CA", city: "LA", zip: "90001", score: null },
    });
    expect(got).toBe("b");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core test src/pick-assignee.test.ts`
Expected: FAIL — zip rules ignored / tiebreak still least-loaded.

- [ ] **Step 3: Update the type + schema in `lead-assignment.ts`**

Replace the `territoryRules` field in `AssignmentConfig` and `assignmentConfigSchema`:

```typescript
export type AssignmentConfig = {
  strategy: AssignmentStrategy;
  territoryRules?: { zip?: string; state?: string; city?: string; userId: string }[];
  scoreTiers?: { minScore: number; userIds: string[] }[];
};

export const assignmentConfigSchema = z.object({
  strategy: z.enum(ASSIGNMENT_STRATEGY),
  territoryRules: z
    .array(
      z
        .object({
          zip: z.string().min(1).max(12).optional(),
          state: z.string().min(1).max(40).optional(),
          city: z.string().max(120).optional(),
          userId: z.string().min(1),
        })
        .refine((r) => r.zip != null || r.state != null, {
          message: "territory rule needs a zip or a state",
        }),
    )
    .optional(),
  scoreTiers: z
    .array(z.object({ minScore: z.number().int().min(0).max(100), userIds: z.array(z.string().min(1)) }))
    .optional(),
});
```

- [ ] **Step 4: Update the territory branch + lead param in `pick-assignee.ts`**

Change the `lead` param type to include `zip`, and replace the `if (strategy === "territory")` block:

```typescript
export function pickAssignee(opts: {
  strategy: AssignmentConfig["strategy"];
  config: AssignmentConfig;
  candidates: AssignmentCandidate[];
  lead: { state: string | null; city: string | null; zip?: string | null; score: number | null; lane?: string | null };
}): string | null {
  const { strategy, config, candidates, lead } = opts;
  if (strategy === "off" || candidates.length === 0) return null;

  const byId = new Map(candidates.map((c) => [c.userId, c]));
  const inPool = (ids: string[]): AssignmentCandidate[] =>
    ids.map((id) => byId.get(id)).filter((c): c is AssignmentCandidate => Boolean(c));

  if (strategy === "round_robin") return roundRobin(candidates);
  if (strategy === "least_loaded") return leastLoaded(candidates);

  if (strategy === "territory") {
    const rules = config.territoryRules ?? [];
    // 1) exact zip match wins
    const zipRules = lead.zip ? rules.filter((r) => r.zip != null && r.zip === lead.zip) : [];
    if (zipRules.length > 0) {
      return roundRobin(inPool(zipRules.map((r) => r.userId))) ?? roundRobin(candidates);
    }
    // 2) state (+ optional city) rules
    const stateRules = rules.filter((r) => r.zip == null && r.state === lead.state && (r.city == null || r.city === lead.city));
    const cityRules = stateRules.filter((r) => r.city != null && r.city === lead.city);
    const chosen = cityRules.length > 0 ? cityRules : stateRules;
    // 3) round-robin tiebreak within the matched pool, else across everyone
    return roundRobin(inPool(chosen.map((r) => r.userId))) ?? roundRobin(candidates);
  }

  if (strategy === "score") {
    // ...unchanged...
```

Leave the `score` and `proximity` branches exactly as they are.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @savvy/core test src/pick-assignee.test.ts`
Expected: PASS. If a pre-existing territory test asserted a *least-loaded* tiebreak, update that expectation to the round-robin result (the engine now uses round-robin for territory ties).

- [ ] **Step 6: Typecheck the package**

Run: `pnpm --filter @savvy/core typecheck`
Expected: PASS. (The `zip` lead field is optional, so existing `pickAssignee` callers still compile.)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/lead-assignment.ts packages/core/src/pick-assignee.ts packages/core/src/pick-assignee.test.ts
git commit -m "feat(core): zip-code territory assignment with round-robin tiebreak"
```

---

### Task 2: Today-first slot ranking (`packages/core`)

**Files:**
- Modify: `packages/core/src/scheduling.ts`
- Test: `packages/core/src/scheduling.test.ts` (create if it does not exist)

**Interfaces:**
- Consumes: existing `Slot`, `RankedSlot` types and `rankSlots` in `scheduling.ts`.
- Produces: `rankSlots(args: { slots: Slot[]; driveMinutesBySlotIndex: (number|null)[]; weights: SchedulingConfig["driveTime"]; todayCutoff?: Date }): RankedSlot[]` — when `todayCutoff` is provided, any slot starting at/before it gets a dominant bonus so same-day slots rank first regardless of drive time.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/scheduling.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { rankSlots } from "./scheduling";

describe("rankSlots — today-first", () => {
  const slots = [
    { startsAt: new Date("2026-06-26T16:00:00Z"), endsAt: new Date("2026-06-26T17:00:00Z"), score: 0.9 }, // tomorrow, great cluster
    { startsAt: new Date("2026-06-25T22:00:00Z"), endsAt: new Date("2026-06-25T23:00:00Z"), score: 0.1 }, // today, poor cluster
  ];

  it("puts a same-day slot first even with a worse base score", () => {
    const ranked = rankSlots({
      slots,
      driveMinutesBySlotIndex: [5, 40],
      weights: { wSoon: 0.5, wDrive: 0.3, wCluster: 0.2, driveHalfMin: 20 },
      todayCutoff: new Date("2026-06-25T23:59:59Z"),
    });
    expect(ranked[0]!.startsAt.toISOString()).toBe("2026-06-25T22:00:00.000Z");
  });

  it("ranks normally when no cutoff is given", () => {
    const ranked = rankSlots({
      slots,
      driveMinutesBySlotIndex: [5, 40],
      weights: { wSoon: 0.5, wDrive: 0.3, wCluster: 0.2, driveHalfMin: 20 },
    });
    expect(ranked[0]!.startsAt.toISOString()).toBe("2026-06-26T16:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core test src/scheduling.test.ts`
Expected: FAIL — `todayCutoff` ignored, tomorrow ranks first in both cases.

- [ ] **Step 3: Add the today bonus to `rankSlots`**

In `scheduling.ts`, add the optional param and apply a dominant additive bonus to same-day slots. Add the constant near the top of the file:

```typescript
// A same-day slot must always outrank any future slot (speed-to-lead).
const TODAY_BONUS = 1000;
```

Update `rankSlots` to accept `todayCutoff` and fold the bonus into each slot's effective score used for sorting (keep the existing drive/soon/cluster math; just add the bonus when `todayCutoff` is set and `slot.startsAt <= todayCutoff`):

```typescript
export function rankSlots(args: {
  slots: Slot[];
  driveMinutesBySlotIndex: (number | null)[];
  weights: SchedulingConfig["driveTime"];
  todayCutoff?: Date;
}): RankedSlot[] {
  const { slots, driveMinutesBySlotIndex, weights, todayCutoff } = args;
  const scored = slots.map((s, i) => {
    const driveMinutes = driveMinutesBySlotIndex[i] ?? null;
    // ...keep the existing effective-score computation, store it as `base`...
    const base = /* existing wSoon/wDrive/wCluster computation for slot i */ 0;
    const todayBump = todayCutoff && s.startsAt.getTime() <= todayCutoff.getTime() ? TODAY_BONUS : 0;
    return { slot: s, driveMinutes, eff: base + todayBump };
  });
  scored.sort((a, b) => b.eff - a.eff);
  return scored.map((x) => ({ ...x.slot, driveMinutes: x.driveMinutes }));
}
```

> Implementer note: preserve the package's **existing** base-score formula — only add `todayBump`. If `rankSlots` currently computes the score inline during sort, refactor minimally so the bonus is added before sorting. Do not change the default (no-cutoff) ordering.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @savvy/core test src/scheduling.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @savvy/core typecheck`
Expected: PASS. (`todayCutoff` is optional; the existing `recommended-slots.ts` caller still compiles.)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/scheduling.ts packages/core/src/scheduling.test.ts
git commit -m "feat(core): today-first slot ranking via optional todayCutoff"
```

---

### Task 3: `rep_availability_block` table + migration (`packages/db`)

**Files:**
- Create: `packages/db/src/schema/scheduling.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create (generated): `packages/db/drizzle/00NN_*.sql`

**Interfaces:**
- Produces: Drizzle table `repAvailabilityBlock` with columns `id, tenantId, userId, startsAt, endsAt, reason, createdAt`, RLS-isolated by tenant.

- [ ] **Step 1: Create the schema file**

`packages/db/src/schema/scheduling.ts` (schema files use **no** import extensions):

```typescript
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";

export const repAvailabilityBlock = pgTable(
  "rep_availability_block",
  {
    id: idCol(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    userId: uuid("user_id").notNull().references(() => user.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [index("rep_block_tenant_user_idx").on(t.tenantId, t.userId, t.startsAt), tenantIsolation()],
);
```

- [ ] **Step 2: Re-export from the schema barrel**

Append to `packages/db/src/schema/index.ts`:

```typescript
export * from "./scheduling";
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm --filter @savvy/db db:generate`
Expected: a new `packages/db/drizzle/00NN_*.sql` creating `rep_availability_block`, its index, FKs, and the `tenant_isolation` policy; `drizzle/meta/_journal.json` updated.

- [ ] **Step 4: Inspect the generated SQL**

Open the new `00NN_*.sql`. Confirm it contains `CREATE TABLE "rep_availability_block"`, the FK references to `tenant` and `user`, the index, and a `CREATE POLICY "tenant_isolation"` statement. If the policy is missing, add it manually mirroring other tables:

```sql
ALTER TABLE "rep_availability_block" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "rep_availability_block" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
```

- [ ] **Step 5: Apply the migration locally**

Run: `pnpm db:up && pnpm --filter @savvy/db db:migrate`
Expected: `migrations + grants applied` — the `savvy_app` grants step covers the new table.

- [ ] **Step 6: Verify table + policy exist**

Run:
```bash
docker exec savvy_db psql -U postgres -d savvy -c "\d rep_availability_block"
docker exec savvy_db psql -U postgres -d savvy -c "select polname from pg_policies where tablename='rep_availability_block';"
```
Expected: table columns listed; policy `tenant_isolation` present.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/scheduling.ts packages/db/src/schema/index.ts packages/db/drizzle
git commit -m "feat(db): rep_availability_block table with tenant RLS"
```

---

### Task 4: `getRepBlocks` lifecycle reader (`packages/db`)

**Files:**
- Create: `packages/db/src/lifecycle/availability.ts`
- Create: `packages/db/src/lifecycle/availability.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Consumes: `repAvailabilityBlock` (Task 3), `withTenant`, `Tx`.
- Produces: `getRepBlocks(tx: Tx, args: { tenantId: string; userId: string; from: Date; to: Date }): Promise<{ startsAt: Date; endsAt: Date }[]>` — blocks for one rep overlapping `[from, to)`, ordered by `startsAt`.

- [ ] **Step 1: Write the failing integration test**

`packages/db/src/lifecycle/availability.test.ts` (lifecycle/tests use **`.js`** extensions):

```typescript
import { afterAll, describe, it, expect } from "vitest";
import { inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { withTenant } from "../tenant.js";
import { tenant, user, repAvailabilityBlock } from "../schema/index.js";
import { getRepBlocks } from "./availability.js";

const tenantIds: string[] = [];

async function seedTenantWithRep() {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "AvailTest", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` })
    .returning();
  tenantIds.push(t!.id);
  const [u] = await adminDb
    .insert(user)
    .values({ tenantId: t!.id, name: "Rep A", email: `rep-${crypto.randomUUID()}@x.com`, role: "rep" })
    .returning();
  return { tenantId: t!.id, userId: u!.id };
}

afterAll(async () => {
  if (tenantIds.length) {
    await adminDb.delete(repAvailabilityBlock).where(inArray(repAvailabilityBlock.tenantId, tenantIds));
    await adminDb.delete(user).where(inArray(user.tenantId, tenantIds));
    await adminDb.delete(tenant).where(inArray(tenant.id, tenantIds));
  }
  await pool.end();
  await adminPool.end();
});

describe("getRepBlocks", () => {
  it("returns a rep's blocks overlapping the window", async () => {
    const { tenantId, userId } = await seedTenantWithRep();
    await withTenant(tenantId, async (tx) => {
      await tx.insert(repAvailabilityBlock).values({
        tenantId, userId,
        startsAt: new Date("2026-06-26T20:00:00Z"),
        endsAt: new Date("2026-06-26T22:00:00Z"),
        reason: "PTO",
      });
    });
    const blocks = await withTenant(tenantId, (tx) =>
      getRepBlocks(tx, { tenantId, userId, from: new Date("2026-06-26T00:00:00Z"), to: new Date("2026-06-27T00:00:00Z") }),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.startsAt.toISOString()).toBe("2026-06-26T20:00:00.000Z");
  });

  it("does not leak blocks across tenants (RLS)", async () => {
    const a = await seedTenantWithRep();
    await withTenant(a.tenantId, async (tx) => {
      await tx.insert(repAvailabilityBlock).values({
        tenantId: a.tenantId, userId: a.userId,
        startsAt: new Date("2026-06-26T20:00:00Z"), endsAt: new Date("2026-06-26T22:00:00Z"),
      });
    });
    const b = await seedTenantWithRep();
    const leaked = await withTenant(b.tenantId, (tx) =>
      getRepBlocks(tx, { tenantId: b.tenantId, userId: a.userId, from: new Date("2026-06-26T00:00:00Z"), to: new Date("2026-06-27T00:00:00Z") }),
    );
    expect(leaked).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db test src/lifecycle/availability.test.ts`
Expected: FAIL — `getRepBlocks` not found.

- [ ] **Step 3: Implement `getRepBlocks`**

`packages/db/src/lifecycle/availability.ts`:

```typescript
import { and, eq, lt, gt, asc } from "drizzle-orm";
import type { Tx } from "../tenant.js";
import { repAvailabilityBlock } from "../schema/index.js";

/** Blocks for one rep that overlap [from, to), ordered by start. Tenant-scoped via RLS (tx). */
export async function getRepBlocks(
  tx: Tx,
  args: { tenantId: string; userId: string; from: Date; to: Date },
): Promise<{ startsAt: Date; endsAt: Date }[]> {
  const rows = await tx
    .select({ startsAt: repAvailabilityBlock.startsAt, endsAt: repAvailabilityBlock.endsAt })
    .from(repAvailabilityBlock)
    .where(
      and(
        eq(repAvailabilityBlock.tenantId, args.tenantId),
        eq(repAvailabilityBlock.userId, args.userId),
        lt(repAvailabilityBlock.startsAt, args.to),
        gt(repAvailabilityBlock.endsAt, args.from),
      ),
    )
    .orderBy(asc(repAvailabilityBlock.startsAt));
  return rows.map((r) => ({ startsAt: r.startsAt, endsAt: r.endsAt }));
}
```

> Implementer note: confirm `Tx` is exported from `../tenant.js`. If it is exported elsewhere (e.g. `../client.js`), import it from there — match how `assignment.ts` imports `Tx`.

- [ ] **Step 4: Export from the package barrel**

Add to `packages/db/src/index.ts` (match existing export style in that file — likely `export * from "./lifecycle/availability.js";` or a named re-export):

```typescript
export { getRepBlocks } from "./lifecycle/availability.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @savvy/db test src/lifecycle/availability.test.ts`
Expected: PASS (both cases, including RLS isolation).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @savvy/db typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/lifecycle/availability.ts packages/db/src/lifecycle/availability.test.ts packages/db/src/index.ts
git commit -m "feat(db): getRepBlocks reader for rep availability blocks"
```

---

### Task 5: `repsFreeAt` pure availability check (`packages/core`)

**Files:**
- Create: `packages/core/src/availability.ts`
- Create: `packages/core/src/availability.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `repsFreeAt(args: { requested: { startsAt: Date; endsAt: Date }; reps: { userId: string; busy: { startsAt: Date; endsAt: Date }[] }[] }): string[]` — the ids of reps whose `busy` intervals do **not** overlap the requested window. This is the pure core of "who's free at 4pm today?"; the DB-wired version (fetching appts + blocks per rep) lands in the Step 2 service plan.

- [ ] **Step 1: Write the failing test**

`packages/core/src/availability.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { repsFreeAt } from "./availability";

describe("repsFreeAt", () => {
  const requested = { startsAt: new Date("2026-06-25T23:00:00Z"), endsAt: new Date("2026-06-26T00:00:00Z") }; // "today 4pm" local

  it("returns reps with no overlapping busy interval", () => {
    const free = repsFreeAt({
      requested,
      reps: [
        { userId: "a", busy: [{ startsAt: new Date("2026-06-25T23:30:00Z"), endsAt: new Date("2026-06-26T00:30:00Z") }] }, // overlaps
        { userId: "b", busy: [{ startsAt: new Date("2026-06-25T20:00:00Z"), endsAt: new Date("2026-06-25T21:00:00Z") }] }, // clear
        { userId: "c", busy: [] }, // wide open
      ],
    });
    expect(free).toEqual(["b", "c"]);
  });

  it("treats edge-touching intervals as free (end == start)", () => {
    const free = repsFreeAt({
      requested,
      reps: [{ userId: "a", busy: [{ startsAt: new Date("2026-06-25T22:00:00Z"), endsAt: new Date("2026-06-25T23:00:00Z") }] }],
    });
    expect(free).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core test src/availability.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `repsFreeAt`**

`packages/core/src/availability.ts`:

```typescript
export type RepBusy = { userId: string; busy: { startsAt: Date; endsAt: Date }[] };

/**
 * Reps with no busy interval overlapping the requested window.
 * Overlap = busy.start < requested.end AND busy.end > requested.start
 * (edge-touching is NOT an overlap). Pure; the DB-fed version lives in the service layer.
 */
export function repsFreeAt(args: {
  requested: { startsAt: Date; endsAt: Date };
  reps: RepBusy[];
}): string[] {
  const rs = args.requested.startsAt.getTime();
  const re = args.requested.endsAt.getTime();
  return args.reps
    .filter((r) => !r.busy.some((b) => b.startsAt.getTime() < re && b.endsAt.getTime() > rs))
    .map((r) => r.userId);
}
```

- [ ] **Step 4: Export it**

Add to `packages/core/src/index.ts` (match existing export style):

```typescript
export * from "./availability";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @savvy/core test src/availability.test.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Typecheck the package**

Run: `pnpm --filter @savvy/core typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/availability.ts packages/core/src/availability.test.ts packages/core/src/index.ts
git commit -m "feat(core): repsFreeAt pure availability overlap check"
```

---

## Final verification

- [ ] **Run the full test suite + typecheck + lint**

```bash
pnpm db:up && pnpm --filter @savvy/db db:migrate
pnpm test
pnpm typecheck
pnpm lint
```
Expected: all green. No existing consumers were broken (every change is additive/optional).

---

## Self-Review (completed by plan author)

- **Spec coverage:** zip territories → Task 1; round-robin default tiebreak → Task 1; rep blocks table → Task 3 + reader Task 4; today-first ranking → Task 2; `repsAvailableAt` core → Task 5 (pure half; DB-wired half explicitly deferred to Step 2). The shared service (`recommendAssignee`, `slotsForRep`, `confirmIntakeBooking`), the quick-book screen, the AI wiring, the settings UI, and the `strategy` default flip are **out of scope for this plan** (Steps 2–3, separate plans) — called out so the boundary is explicit, not a gap.
- **Placeholder scan:** none. The one intentional "preserve existing formula" note in Task 2 Step 3 references the package's real base-score math rather than reprinting a formula that must match the current file verbatim.
- **Type consistency:** `pickAssignee` lead param adds `zip?: string|null` (Task 1) consistently; `rankSlots` adds `todayCutoff?: Date` (Task 2); `getRepBlocks` and `repsFreeAt` interval shapes (`{startsAt, endsAt}`) match between Tasks 4 and 5.
