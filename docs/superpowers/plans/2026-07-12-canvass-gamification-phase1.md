# Canvass Gamification Phase 1 (Scoreboard & Recognition) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-computed scoreboard (points, levels, streaks), unlockable achievement badges, a leaderboard endpoint, and a field-app Compete tab — the foundation the challenge and spiff phases read from.

**Architecture:** Derive-from-knocks (Approach A). `canvass_knock` stays the source of truth; points/levels/streaks are pure functions in `@savvy/core`. Only unlocked achievements persist (one new table). One read endpoint (`/scoreboard`), achievement evaluation hooked into the existing knock POST, and a new Compete tab in the single-file field app.

**Tech Stack:** TypeScript, Next.js App Router (route handlers), Drizzle ORM + Postgres (RLS), Vitest, pnpm + Turborepo. Field app is one static `index.html` (vanilla JS + Leaflet) deployed to Cloudflare Pages.

## Global Constraints

- Tenant isolation on every query: all DB access via `withTenant(sess.tenantId, tx => …)`; new tables carry `tenant_id` + `tenantIsolation()` RLS policy. Copied verbatim from the spec.
- Every new endpoint: `export const runtime = "nodejs"`; auth via `verifyCanvassToken(bearerToken(req.headers))` → 401 if missing; tenant from `sess.tenantId` only, never a client key; `canvassCors(req, "GET, OPTIONS")` + `OPTIONS` handler; added to the Clerk public allowlist regex in `apps/web/src/middleware.ts`.
- Read endpoints use `checkRateLimit("canvass-read", \`${sess.tenantId}:${sess.repId}\`)`.
- All day-bucketing uses `dateKeyInTimeZone(now, tenant.timezone)` — never UTC.
- Points weight defaults (tenant-configurable later via `tenant.settings.canvassPoints`, not in this phase): door 1, contact +2, callback +3, appt +10, sale +25 + `min(25, floor(amount/1000))`.
- Level thresholds: Rookie 0, Runner 500, Closer 2000, Veteran 6000, Legend 15000.
- Migrations: `pnpm db:generate` writes `packages/db/drizzle/NNNN_*.sql`; apply locally with `pnpm db:migrate`. Prod applies via Supabase MCP `apply_migration` (prod numbering is one ahead of local). Local Postgres must be up: `pnpm db:up`.
- Before any DB-backed test run, clear stale synthetic task-registry rows: `docker exec savvy_db psql -U postgres -d savvy -c "DELETE FROM task_exception WHERE task_id>=9000; DELETE FROM verification_run WHERE task_id>=9000; DELETE FROM task_health WHERE task_id>=9000; DELETE FROM tenant_task_config WHERE task_id>=9000; DELETE FROM job_task WHERE task_id>=9000; DELETE FROM lead_task WHERE task_id>=9000; DELETE FROM task_registry WHERE id>=9000;"` and run the full suite with `--no-file-parallelism`.
- Ignore the pre-existing `@savvy/integrations` `vapi.ts` typecheck error; introduce no new ones.

---

### Task 1: Points scoring (pure core)

**Files:**
- Create: `packages/core/src/canvass-points.ts`
- Create: `packages/core/src/canvass-points.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./canvass-points";` after line 94 `export * from "./canvass-dossier";`)

**Interfaces:**
- Produces: `CanvassPointWeights`, `DEFAULT_POINT_WEIGHTS`, `ScoredKnockLike`, `scoreKnock(k, w?)→number`, `scoreRep(knocks, w?)→number`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/canvass-points.test.ts
import { describe, expect, it } from "vitest";
import { scoreKnock, scoreRep, DEFAULT_POINT_WEIGHTS } from "./canvass-points";

describe("scoreKnock", () => {
  it("scores each outcome cumulatively with the default weights", () => {
    expect(scoreKnock({ outcome: "noanswer" })).toBe(1); // door only
    expect(scoreKnock({ outcome: "notint" })).toBe(3); // door + contact
    expect(scoreKnock({ outcome: "callback" })).toBe(6); // door + contact + callback
    expect(scoreKnock({ outcome: "appt" })).toBe(13); // door + contact + appt
    expect(scoreKnock({ outcome: "sale", amount: 0 })).toBe(28); // door + contact + sale
  });
  it("adds a revenue bonus of 1 per $1000, capped at 25", () => {
    expect(scoreKnock({ outcome: "sale", amount: 12000 })).toBe(28 + 12);
    expect(scoreKnock({ outcome: "sale", amount: 999 })).toBe(28 + 0);
    expect(scoreKnock({ outcome: "sale", amount: 999999 })).toBe(28 + 25); // capped
  });
});

describe("scoreRep", () => {
  it("sums points across a rep's knocks", () => {
    const knocks = [{ outcome: "noanswer" }, { outcome: "appt" }, { outcome: "sale", amount: 5000 }];
    expect(scoreRep(knocks)).toBe(1 + 13 + (28 + 5));
  });
  it("is 0 for no knocks", () => {
    expect(scoreRep([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Sites/savvy-crm && npx vitest run packages/core/src/canvass-points.test.ts`
Expected: FAIL — `Cannot find module './canvass-points'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/canvass-points.ts
// Points derived from a knock's outcome (Approach A: knocks are the source of
// truth). Cumulative: a sale also earns the door + contact points.
export interface CanvassPointWeights {
  door: number;
  contact: number; // any answer (outcome !== "noanswer")
  callback: number;
  appt: number;
  sale: number;
  revenuePer: number; // dollars per bonus point
  revenueCap: number; // max revenue bonus points
}

export const DEFAULT_POINT_WEIGHTS: CanvassPointWeights = {
  door: 1,
  contact: 2,
  callback: 3,
  appt: 10,
  sale: 25,
  revenuePer: 1000,
  revenueCap: 25,
};

export interface ScoredKnockLike {
  outcome: string;
  amount?: number | null;
}

export function scoreKnock(k: ScoredKnockLike, w: CanvassPointWeights = DEFAULT_POINT_WEIGHTS): number {
  let p = w.door;
  if (k.outcome !== "noanswer") p += w.contact;
  if (k.outcome === "callback") p += w.callback;
  if (k.outcome === "appt") p += w.appt;
  if (k.outcome === "sale") {
    p += w.sale;
    p += Math.min(w.revenueCap, Math.floor((k.amount ?? 0) / w.revenuePer));
  }
  return p;
}

export function scoreRep(knocks: ScoredKnockLike[], w: CanvassPointWeights = DEFAULT_POINT_WEIGHTS): number {
  return knocks.reduce((sum, k) => sum + scoreKnock(k, w), 0);
}
```

Then add to `packages/core/src/index.ts` after the `canvass-dossier` export:

```ts
export * from "./canvass-dossier";
export * from "./canvass-points";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Sites/savvy-crm && npx vitest run packages/core/src/canvass-points.test.ts`
Expected: PASS (2 files, all tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/canvass-points.ts packages/core/src/canvass-points.test.ts packages/core/src/index.ts
git commit -m "feat(core): canvass point scoring (scoreKnock/scoreRep)"
```

---

### Task 2: Levels/tiers (pure core)

**Files:**
- Modify: `packages/core/src/canvass-points.ts` (append level logic)
- Modify: `packages/core/src/canvass-points.test.ts` (append level tests)

**Interfaces:**
- Consumes: nothing new.
- Produces: `LEVEL_TIERS` (readonly `{tier, min}[]`), `RepLevel` (`{tier, next, pointsToNext, progressPct}`), `levelFor(points)→RepLevel`.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/core/src/canvass-points.test.ts
import { levelFor } from "./canvass-points";

describe("levelFor", () => {
  it("returns the tier for a point total and progress to the next", () => {
    const rookie = levelFor(0);
    expect(rookie.tier).toBe("Rookie");
    expect(rookie.next).toBe("Runner");
    expect(rookie.pointsToNext).toBe(500);
    expect(rookie.progressPct).toBe(0);

    const mid = levelFor(1250); // between Runner (500) and Closer (2000)
    expect(mid.tier).toBe("Runner");
    expect(mid.next).toBe("Closer");
    expect(mid.pointsToNext).toBe(750);
    expect(mid.progressPct).toBe(50); // (1250-500)/(2000-500) = 50%
  });
  it("caps at the top tier with no next", () => {
    const top = levelFor(20000);
    expect(top.tier).toBe("Legend");
    expect(top.next).toBeNull();
    expect(top.pointsToNext).toBeNull();
    expect(top.progressPct).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Sites/savvy-crm && npx vitest run packages/core/src/canvass-points.test.ts`
Expected: FAIL — `levelFor is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to packages/core/src/canvass-points.ts
export const LEVEL_TIERS = [
  { tier: "Rookie", min: 0 },
  { tier: "Runner", min: 500 },
  { tier: "Closer", min: 2000 },
  { tier: "Veteran", min: 6000 },
  { tier: "Legend", min: 15000 },
] as const;

export interface RepLevel {
  tier: string;
  next: string | null;
  pointsToNext: number | null;
  progressPct: number;
}

export function levelFor(points: number): RepLevel {
  let idx = 0;
  for (let i = 0; i < LEVEL_TIERS.length; i++) {
    if (points >= LEVEL_TIERS[i]!.min) idx = i;
  }
  const cur = LEVEL_TIERS[idx]!;
  const nextTier = LEVEL_TIERS[idx + 1];
  if (!nextTier) return { tier: cur.tier, next: null, pointsToNext: null, progressPct: 100 };
  const span = nextTier.min - cur.min;
  const into = points - cur.min;
  return {
    tier: cur.tier,
    next: nextTier.tier,
    pointsToNext: nextTier.min - points,
    progressPct: Math.max(0, Math.min(100, Math.round((into / span) * 100))),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Sites/savvy-crm && npx vitest run packages/core/src/canvass-points.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/canvass-points.ts packages/core/src/canvass-points.test.ts
git commit -m "feat(core): canvass rep levels/tiers (levelFor)"
```

---

### Task 3: Streaks (pure core, tenant-tz)

**Files:**
- Create: `packages/core/src/canvass-streak.ts`
- Create: `packages/core/src/canvass-streak.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./canvass-streak";`)

**Interfaces:**
- Consumes: `dateKeyInTimeZone(now, tz)` from `./tz` (already exported).
- Produces: `currentStreak(times, tz, now?)→number`, `bestStreak(times, tz)→number` where `times: Date[]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/canvass-streak.test.ts
import { describe, expect, it } from "vitest";
import { currentStreak, bestStreak } from "./canvass-streak";

// Phoenix = UTC-7. A knock at 15:00Z is 08:00 local same day.
const at = (isoLocalDate: string) => new Date(`${isoLocalDate}T15:00:00Z`);
const TZ = "America/Phoenix";
const NOW = new Date("2026-07-12T15:00:00Z"); // local 2026-07-12

describe("currentStreak", () => {
  it("counts consecutive local days ending today", () => {
    expect(currentStreak([at("2026-07-12"), at("2026-07-11"), at("2026-07-10")], TZ, NOW)).toBe(3);
  });
  it("still counts if the last knock was yesterday (grace, not yet knocked today)", () => {
    expect(currentStreak([at("2026-07-11"), at("2026-07-10")], TZ, NOW)).toBe(2);
  });
  it("is 0 when the last knock is older than yesterday", () => {
    expect(currentStreak([at("2026-07-09")], TZ, NOW)).toBe(0);
  });
  it("is 0 for no knocks", () => {
    expect(currentStreak([], TZ, NOW)).toBe(0);
  });
});

describe("bestStreak", () => {
  it("returns the longest run of consecutive local days", () => {
    const times = [at("2026-07-01"), at("2026-07-02"), at("2026-07-03"), at("2026-07-06"), at("2026-07-07")];
    expect(bestStreak(times, TZ)).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Sites/savvy-crm && npx vitest run packages/core/src/canvass-streak.test.ts`
Expected: FAIL — `Cannot find module './canvass-streak'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/canvass-streak.ts
import { dateKeyInTimeZone } from "./tz";

// Streaks in the tenant's local calendar days, not UTC.
function dayKeySet(times: Date[], tz: string): Set<string> {
  return new Set(times.map((t) => dateKeyInTimeZone(t, tz)));
}
function addDays(key: string, delta: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + delta));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** Consecutive local days with ≥1 knock, ending today or (grace) yesterday. */
export function currentStreak(times: Date[], tz: string, now: Date = new Date()): number {
  if (times.length === 0) return 0;
  const days = dayKeySet(times, tz);
  const today = dateKeyInTimeZone(now, tz);
  let cursor = days.has(today) ? today : addDays(today, -1);
  if (!days.has(cursor)) return 0;
  let n = 0;
  while (days.has(cursor)) {
    n++;
    cursor = addDays(cursor, -1);
  }
  return n;
}

/** Longest run of consecutive local days across all history. */
export function bestStreak(times: Date[], tz: string): number {
  if (times.length === 0) return 0;
  const keys = [...dayKeySet(times, tz)].sort();
  let best = 1;
  let run = 1;
  for (let i = 1; i < keys.length; i++) {
    run = keys[i] === addDays(keys[i - 1]!, 1) ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}
```

Add to `packages/core/src/index.ts`:

```ts
export * from "./canvass-points";
export * from "./canvass-streak";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Sites/savvy-crm && npx vitest run packages/core/src/canvass-streak.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/canvass-streak.ts packages/core/src/canvass-streak.test.ts packages/core/src/index.ts
git commit -m "feat(core): canvass streaks (currentStreak/bestStreak, tenant-tz)"
```

---

### Task 4: Achievements evaluation (pure core)

**Files:**
- Create: `packages/core/src/canvass-achievements.ts`
- Create: `packages/core/src/canvass-achievements.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./canvass-achievements";`)

**Interfaces:**
- Consumes: `bestStreak` from `./canvass-streak`; `dateKeyInTimeZone` from `./tz`.
- Produces: `BadgeDef` (`{key, name}`), `CANVASS_BADGES` (`BadgeDef[]`), `AchievementKnock` (`{outcome, amount?, at: Date}`), `evaluateAchievements({knocks, tz, now?})→string[]` (all earned badge keys; caller diffs against already-unlocked).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/canvass-achievements.test.ts
import { describe, expect, it } from "vitest";
import { evaluateAchievements } from "./canvass-achievements";

const TZ = "America/Phoenix";
const NOW = new Date("2026-07-12T20:00:00Z");
const mk = (over: Partial<{ outcome: string; amount: number; at: Date }> = {}) => ({
  outcome: "noanswer",
  at: new Date("2026-07-10T18:00:00Z"),
  ...over,
});

describe("evaluateAchievements", () => {
  it("awards first_sale on the first sale", () => {
    expect(evaluateAchievements({ knocks: [mk(), mk({ outcome: "sale", amount: 1000 })], tz: TZ, now: NOW })).toContain("first_sale");
    expect(evaluateAchievements({ knocks: [mk()], tz: TZ, now: NOW })).not.toContain("first_sale");
  });
  it("awards doors_100 at 100 lifetime doors", () => {
    const knocks = Array.from({ length: 100 }, () => mk());
    expect(evaluateAchievements({ knocks, tz: TZ, now: NOW })).toContain("doors_100");
    expect(evaluateAchievements({ knocks: knocks.slice(0, 99), tz: TZ, now: NOW })).not.toContain("doors_100");
  });
  it("awards hot_hand for 10 doors within a 60-minute window", () => {
    const base = Date.parse("2026-07-10T18:00:00Z");
    const knocks = Array.from({ length: 10 }, (_, i) => mk({ at: new Date(base + i * 5 * 60000) })); // 5 min apart = 45 min span
    expect(evaluateAchievements({ knocks, tz: TZ, now: NOW })).toContain("hot_hand");
  });
  it("awards early_bird for a knock before 8am local", () => {
    // 14:00Z = 07:00 Phoenix
    expect(evaluateAchievements({ knocks: [mk({ at: new Date("2026-07-10T14:00:00Z") })], tz: TZ, now: NOW })).toContain("early_bird");
    // 16:00Z = 09:00 Phoenix
    expect(evaluateAchievements({ knocks: [mk({ at: new Date("2026-07-10T16:00:00Z") })], tz: TZ, now: NOW })).not.toContain("early_bird");
  });
  it("awards rainmaker for >= $25k sales in one local day", () => {
    const knocks = [mk({ outcome: "sale", amount: 15000, at: new Date("2026-07-10T18:00:00Z") }), mk({ outcome: "sale", amount: 12000, at: new Date("2026-07-10T20:00:00Z") })];
    expect(evaluateAchievements({ knocks, tz: TZ, now: NOW })).toContain("rainmaker");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Sites/savvy-crm && npx vitest run packages/core/src/canvass-achievements.test.ts`
Expected: FAIL — `Cannot find module './canvass-achievements'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/canvass-achievements.ts
import { bestStreak } from "./canvass-streak";
import { dateKeyInTimeZone, hourInTimeZone } from "./tz";

export interface BadgeDef {
  key: string;
  name: string;
}

export const CANVASS_BADGES: BadgeDef[] = [
  { key: "first_sale", name: "First Blood" },
  { key: "doors_100", name: "Century" },
  { key: "doors_1000", name: "Grand" },
  { key: "hot_hand", name: "Hot Hand" },
  { key: "streak_5", name: "Iron Streak 5" },
  { key: "streak_10", name: "Iron Streak 10" },
  { key: "streak_30", name: "Iron Streak 30" },
  { key: "rainmaker", name: "Rainmaker" },
  { key: "early_bird", name: "Early Bird" },
];

export interface AchievementKnock {
  outcome: string;
  amount?: number | null;
  at: Date;
}

export interface AchievementInput {
  knocks: AchievementKnock[];
  tz: string;
  now?: Date;
}

function hotHand(times: number[]): boolean {
  const sorted = [...times].sort((a, b) => a - b);
  for (let i = 0; i + 9 < sorted.length; i++) {
    if (sorted[i + 9]! - sorted[i]! <= 60 * 60000) return true; // 10 within 60 min
  }
  return false;
}

/** All badge keys this rep has EARNED given their full knock history. The
 *  caller diffs against already-unlocked and inserts the new ones. */
export function evaluateAchievements({ knocks, tz }: AchievementInput): string[] {
  const earned: string[] = [];
  const doors = knocks.length;
  const sales = knocks.filter((k) => k.outcome === "sale");
  const times = knocks.map((k) => k.at);

  if (sales.length > 0) earned.push("first_sale");
  if (doors >= 100) earned.push("doors_100");
  if (doors >= 1000) earned.push("doors_1000");
  if (hotHand(times.map((t) => t.getTime()))) earned.push("hot_hand");

  const streak = bestStreak(times, tz);
  if (streak >= 5) earned.push("streak_5");
  if (streak >= 10) earned.push("streak_10");
  if (streak >= 30) earned.push("streak_30");

  // rainmaker: >= $25k sales in any single local day
  const byDay = new Map<string, number>();
  for (const s of sales) {
    const key = dateKeyInTimeZone(s.at, tz);
    byDay.set(key, (byDay.get(key) ?? 0) + (s.amount ?? 0));
  }
  if ([...byDay.values()].some((v) => v >= 25000)) earned.push("rainmaker");

  // early_bird: any knock before 8am local
  if (times.some((t) => hourInTimeZone(t, tz) < 8)) earned.push("early_bird");

  return earned;
}
```

Add to `packages/core/src/index.ts`:

```ts
export * from "./canvass-streak";
export * from "./canvass-achievements";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Sites/savvy-crm && npx vitest run packages/core/src/canvass-achievements.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/canvass-achievements.ts packages/core/src/canvass-achievements.test.ts packages/core/src/index.ts
git commit -m "feat(core): canvass achievement evaluation (knock-derived badges)"
```

---

### Task 5: `canvass_achievement` table + migration

**Files:**
- Modify: `packages/db/src/schema/canvass.ts` (append table; `jsonb`/`uniqueIndex` already imported)
- Create (generated): `packages/db/drizzle/0075_*.sql`

**Interfaces:**
- Produces: `canvassAchievement` Drizzle table, re-exported from `@savvy/db` via the existing `export * from "./schema/index"`.

- [ ] **Step 1: Append the table to `packages/db/src/schema/canvass.ts`**

```ts
// Unlocked achievement badges per rep (Approach A: everything else is derived
// from canvass_knock; only badge unlocks persist). Idempotent via the unique
// (tenant, rep, badge_key) index.
export const canvassAchievement = pgTable("canvass_achievement", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  repId: uuid("rep_id").notNull().references(() => canvassRep.id),
  badgeKey: text("badge_key").notNull(),
  meta: jsonb("meta").$type<Record<string, unknown>>().default({}).notNull(),
  unlockedAt: createdAt(),
}, (t) => [
  uniqueIndex("canvass_achievement_uniq").on(t.tenantId, t.repId, t.badgeKey),
  index("canvass_achievement_tenant_idx").on(t.tenantId),
  tenantIsolation(),
]);
```

- [ ] **Step 2: Generate the migration**

Run: `cd ~/Sites/savvy-crm && pnpm db:generate`
Expected: prints `canvass_achievement …` and writes `packages/db/drizzle/0075_<name>.sql`. Open it and confirm it `CREATE TABLE`s `canvass_achievement`, `ENABLE ROW LEVEL SECURITY`, the unique index, and a `tenant_isolation` policy.

- [ ] **Step 3: Apply locally**

Run: `cd ~/Sites/savvy-crm && pnpm db:up && pnpm db:migrate`
Expected: `migrations + grants applied`.

- [ ] **Step 4: Typecheck**

Run: `cd ~/Sites/savvy-crm && pnpm typecheck`
Expected: 7/7 packages, no new errors.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/canvass.ts packages/db/drizzle/
git commit -m "feat(db): canvass_achievement table (badge unlocks)"
```

---

### Task 6: Achievement persistence lifecycle (DB)

**Files:**
- Create: `packages/db/src/lifecycle/canvass-achievement.ts`
- Create: `packages/db/tests/canvass-achievement.test.ts`
- Modify: `packages/db/src/index.ts` (add export after the `canvass-knock` line)

**Interfaces:**
- Consumes: `canvassAchievement` table, `Tx`.
- Produces: `unlockAchievements(tx, tenantId, repId, keys)→Promise<string[]>` (newly-inserted keys, idempotent); `listAchievementKeys(tx, tenantId, repId)→Promise<string[]>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/canvass-achievement.test.ts
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { adminDb, adminPool, pool, eq, tenant, canvassRep, canvassAchievement } from "../src/index";
import { withTenant } from "../src/tenant";
import { unlockAchievements, listAchievementKeys } from "../src/lifecycle/canvass-achievement";

let tId: string, repId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "AchCo", publicKey: `ach-${Date.now()}`, clerkOrgId: `org_ach_${Date.now()}` }).returning();
  tId = t!.id;
  const [r] = await adminDb.insert(canvassRep).values({ tenantId: tId, name: "Rep", pinHash: "x" }).returning();
  repId = r!.id;
});
afterAll(async () => {
  await adminDb.delete(canvassAchievement).where(eq(canvassAchievement.tenantId, tId));
  await adminDb.delete(canvassRep).where(eq(canvassRep.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

describe("unlockAchievements", () => {
  it("inserts new keys and returns only the newly-unlocked ones", async () => {
    const first = await withTenant(tId, (tx) => unlockAchievements(tx, tId, repId, ["first_sale", "doors_100"]));
    expect(first.sort()).toEqual(["doors_100", "first_sale"]);
    const second = await withTenant(tId, (tx) => unlockAchievements(tx, tId, repId, ["first_sale", "hot_hand"]));
    expect(second).toEqual(["hot_hand"]); // first_sale already unlocked
    const keys = await withTenant(tId, (tx) => listAchievementKeys(tx, tId, repId));
    expect(keys.sort()).toEqual(["doors_100", "first_sale", "hot_hand"]);
  });
  it("returns [] for an empty key list", async () => {
    expect(await withTenant(tId, (tx) => unlockAchievements(tx, tId, repId, []))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Sites/savvy-crm && docker exec savvy_db psql -U postgres -d savvy -c "DELETE FROM task_registry WHERE id>=9000" >/dev/null; npx vitest run packages/db/tests/canvass-achievement.test.ts`
Expected: FAIL — `Cannot find module '../src/lifecycle/canvass-achievement'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/db/src/lifecycle/canvass-achievement.ts
import { and, eq } from "drizzle-orm";
import type { Tx } from "../tenant";
import { canvassAchievement } from "../schema/index";

// Insert the earned badge keys the rep doesn't already have; returns the keys
// that were actually newly inserted (for the "badge unlocked!" toast). Idempotent
// via the (tenant, rep, badge_key) unique index.
export async function unlockAchievements(tx: Tx, tenantId: string, repId: string, keys: string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await tx
    .insert(canvassAchievement)
    .values(keys.map((badgeKey) => ({ tenantId, repId, badgeKey })))
    .onConflictDoNothing({ target: [canvassAchievement.tenantId, canvassAchievement.repId, canvassAchievement.badgeKey] })
    .returning({ badgeKey: canvassAchievement.badgeKey });
  return rows.map((r) => r.badgeKey);
}

export async function listAchievementKeys(tx: Tx, tenantId: string, repId: string): Promise<string[]> {
  const rows = await tx
    .select({ badgeKey: canvassAchievement.badgeKey })
    .from(canvassAchievement)
    .where(and(eq(canvassAchievement.tenantId, tenantId), eq(canvassAchievement.repId, repId)));
  return rows.map((r) => r.badgeKey);
}
```

Add to `packages/db/src/index.ts` after the `upsertCanvassKnock` export line:

```ts
export { unlockAchievements, listAchievementKeys } from "./lifecycle/canvass-achievement";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Sites/savvy-crm && npx vitest run packages/db/tests/canvass-achievement.test.ts`
Expected: PASS (5 assertions).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/canvass-achievement.ts packages/db/tests/canvass-achievement.test.ts packages/db/src/index.ts
git commit -m "feat(db): unlockAchievements/listAchievementKeys (idempotent)"
```

---

### Task 7: Scoreboard endpoint

**Files:**
- Create: `apps/web/src/app/api/canvass/scoreboard/route.ts`
- Modify: `apps/web/src/middleware.ts` (add `scoreboard` to the canvass allowlist regex)

**Interfaces:**
- Consumes: `scoreRep`, `levelFor`, `currentStreak`, `DEFAULT_POINT_WEIGHTS` from `@savvy/core`; `dateKeyInTimeZone`; `withTenant`, `tenant`, `canvassRep`, `canvassKnock`, `eq`, `and`, `gte` from `@savvy/db`; `verifyCanvassToken`, `bearerToken`, `canvassCors`, `checkRateLimit`.
- Produces: `GET /api/canvass/scoreboard?period=day|week|month|all` → `{ period, leaders: [{repId, name, points, rank, tier, streak, doors, appts, sales, revenue}] }`.

- [ ] **Step 1: Add `scoreboard` to the middleware allowlist**

In `apps/web/src/middleware.ts`, extend the canvass regex (currently ends `…|company)$/`):

```ts
/^\/api\/canvass\/(login|contract|reps|knocks|eod|territories|dossier|geocode|storms|certificate|company|scoreboard)$/
```

- [ ] **Step 2: Write the route**

```ts
// apps/web/src/app/api/canvass/scoreboard/route.ts
import { NextResponse } from "next/server";
import { scoreRep, levelFor, currentStreak, dateKeyInTimeZone, DEFAULT_POINT_WEIGHTS } from "@savvy/core";
import { withTenant, tenant, canvassRep, canvassKnock, eq, and, gte } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

// GET — team scoreboard: per-rep points/rank/tier/streak for a period, derived
// from canvass_knock. Points/period windowing use the tenant's timezone; streak
// uses the rep's full history (last 120 days pulled). Bearer session only.
export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, OPTIONS") });
}

const PERIODS = new Set(["day", "week", "month", "all"]);

export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass-read", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  const url = new URL(req.url);
  const period = url.searchParams.get("period") || "week";
  if (!PERIODS.has(period)) return reply({ error: "bad period" }, 400);

  const result = await withTenant(sess.tenantId, async (tx) => {
    const [tRow] = await tx.select({ timezone: tenant.timezone }).from(tenant).where(eq(tenant.id, sess.tenantId));
    const tz = tRow?.timezone ?? "UTC";
    const reps = await tx.select({ id: canvassRep.id, name: canvassRep.name }).from(canvassRep).where(eq(canvassRep.active, true));

    // Pull the last 120 days of knocks once; window for points in JS by tz-day.
    const since = new Date(Date.now() - 120 * 86_400_000);
    const knocks = await tx
      .select({ repId: canvassKnock.repId, outcome: canvassKnock.outcome, amount: canvassKnock.amount, createdAt: canvassKnock.createdAt })
      .from(canvassKnock)
      .where(gte(canvassKnock.createdAt, since));

    const now = new Date();
    const startKey =
      period === "day" ? dateKeyInTimeZone(now, tz)
      : period === "week" ? dateKeyInTimeZone(new Date(now.getTime() - 6 * 86_400_000), tz)
      : period === "month" ? dateKeyInTimeZone(new Date(now.getTime() - 29 * 86_400_000), tz)
      : "0000-00-00";

    const byRep = new Map(reps.map((r) => [r.id, { repId: r.id, name: r.name, times: [] as Date[], windowed: [] as { outcome: string; amount: number | null }[] }]));
    for (const k of knocks) {
      const b = byRep.get(k.repId);
      if (!b) continue;
      b.times.push(k.createdAt);
      if (dateKeyInTimeZone(k.createdAt, tz) >= startKey) b.windowed.push({ outcome: k.outcome, amount: k.amount });
    }

    const leaders = [...byRep.values()].map((b) => {
      const points = scoreRep(b.windowed, DEFAULT_POINT_WEIGHTS);
      const doors = b.windowed.length;
      const appts = b.windowed.filter((k) => k.outcome === "appt").length;
      const sales = b.windowed.filter((k) => k.outcome === "sale");
      return {
        repId: b.repId,
        name: b.name,
        points,
        tier: levelFor(scoreRep(b.windowed)).tier, // period tier from period points
        streak: currentStreak(b.times, tz, now), // streak from full history
        doors,
        appts,
        sales: sales.length,
        revenue: sales.reduce((s, k) => s + (k.amount ?? 0), 0),
      };
    });
    leaders.sort((x, y) => y.points - x.points || y.sales - x.sales);
    return leaders.map((l, i) => ({ ...l, rank: i + 1 }));
  });

  return reply({ period, leaders: result }, 200);
}
```

- [ ] **Step 3: Typecheck**

Run: `cd ~/Sites/savvy-crm && pnpm typecheck`
Expected: no new errors.

- [ ] **Step 4: Smoke the auth gate (no live session needed)**

Run: `cd ~/Sites/savvy-crm && pnpm --filter @savvy/web build 2>&1 | tail -5` (or rely on typecheck + the deploy verify below). Confirm no build error for the new route.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/api/canvass/scoreboard/route.ts apps/web/src/middleware.ts
git commit -m "feat(canvass): GET /scoreboard (points/tier/streak leaderboard)"
```

---

### Task 8: Evaluate achievements on knock sync

**Files:**
- Modify: `apps/web/src/app/api/canvass/knocks/route.ts` (after a successful upsert, evaluate + unlock, return `newBadges`)

**Interfaces:**
- Consumes: `evaluateAchievements` from `@savvy/core`; `unlockAchievements`, `listAchievementKeys` from `@savvy/db`; `tenant` for tz.
- Produces: POST `/knocks` response gains `newBadges: string[]` (badge keys unlocked by this knock).

- [ ] **Step 1: Modify the POST handler**

In `apps/web/src/app/api/canvass/knocks/route.ts`, add imports:

```ts
import { canvassKnockObject, canvassHaversineMeters, CANVASS_GPS_FLAG_METERS, evaluateAchievements } from "@savvy/core";
import { withTenant, upsertCanvassKnock, isCanvassRepActive, unlockAchievements, listAchievementKeys, tenant, canvassKnock, canvassRep, eq, gt, desc } from "@savvy/db";
```

Replace the block from `if ("denied" in result) …` through the final `return reply(...)` with:

```ts
  if ("denied" in result) return reply({ error: "unauthorized" }, 401);
  if (gpsFlagged) log.warn("canvass gps-flagged knock", { route: "/api/canvass/knocks", tenantId: sess.tenantId, repId: sess.repId, m: gpsDistanceM });

  // Re-evaluate this rep's badges from their full history; unlock any new ones.
  let newBadges: string[] = [];
  try {
    newBadges = await withTenant(sess.tenantId, async (tx) => {
      const [tRow] = await tx.select({ timezone: tenant.timezone }).from(tenant).where(eq(tenant.id, sess.tenantId));
      const tz = tRow?.timezone ?? "UTC";
      const rows = await tx
        .select({ outcome: canvassKnock.outcome, amount: canvassKnock.amount, createdAt: canvassKnock.createdAt })
        .from(canvassKnock)
        .where(eq(canvassKnock.repId, sess.repId));
      const earned = evaluateAchievements({ knocks: rows.map((r) => ({ outcome: r.outcome, amount: r.amount, at: r.createdAt })), tz });
      const already = new Set(await listAchievementKeys(tx, sess.tenantId, sess.repId));
      const toUnlock = earned.filter((k) => !already.has(k));
      return unlockAchievements(tx, sess.tenantId, sess.repId, toUnlock);
    });
  } catch {
    newBadges = []; // never fail a knock over gamification
  }
  return reply({ ok: true, id: result.id, gpsFlagged, gpsDistanceM, newBadges }, 201);
```

- [ ] **Step 2: Typecheck**

Run: `cd ~/Sites/savvy-crm && pnpm typecheck`
Expected: no new errors.

- [ ] **Step 3: Extend the knock-upsert DB test to assert badges**

Append to `packages/db/tests/canvass-knock-upsert.test.ts` a test that inserts a `sale` knock via the lifecycle + evaluates:

```ts
import { evaluateAchievements } from "@savvy/core";
import { unlockAchievements } from "../src/lifecycle/canvass-achievement";

describe("achievements on knock", () => {
  it("first_sale unlocks once a sale exists", async () => {
    await withTenant(tId, (tx) => upsertCanvassKnock(tx, { ...base(repA), clientId: "ach-1", outcome: "sale", amount: 1000 }));
    const earned = await withTenant(tId, async (tx) => {
      const earnedKeys = evaluateAchievements({ knocks: [{ outcome: "sale", amount: 1000, at: new Date() }], tz: "America/Phoenix" });
      return unlockAchievements(tx, tId, repA, earnedKeys);
    });
    expect(earned).toContain("first_sale");
  });
});
```

- [ ] **Step 4: Run the DB test**

Run: `cd ~/Sites/savvy-crm && docker exec savvy_db psql -U postgres -d savvy -c "DELETE FROM task_registry WHERE id>=9000" >/dev/null; npx vitest run packages/db/tests/canvass-knock-upsert.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/api/canvass/knocks/route.ts packages/db/tests/canvass-knock-upsert.test.ts
git commit -m "feat(canvass): evaluate + unlock badges on knock sync (newBadges in response)"
```

---

### Task 9: Full suite green + deploy backend

**Files:** none (verification + deploy)

- [ ] **Step 1: Clear synthetic debris and run the full suite serially**

Run:
```bash
cd ~/Sites/savvy-crm && docker exec savvy_db psql -U postgres -d savvy -c "DELETE FROM task_exception WHERE task_id>=9000; DELETE FROM verification_run WHERE task_id>=9000; DELETE FROM task_health WHERE task_id>=9000; DELETE FROM tenant_task_config WHERE task_id>=9000; DELETE FROM job_task WHERE task_id>=9000; DELETE FROM lead_task WHERE task_id>=9000; DELETE FROM task_registry WHERE id>=9000;" >/dev/null
pnpm typecheck && pnpm lint && npx vitest run --no-file-parallelism
```
Expected: typecheck 7/7, lint clean, all tests pass.

- [ ] **Step 2: Apply the migration to prod Supabase**

Use the Supabase MCP `apply_migration` (project ref `ngczjltbcuvrjosxgqrm`, name `0075_canvass_achievement`) with the SQL from the generated local `0075_*.sql` (CREATE TABLE + RLS enable + unique index + policy + `GRANT SELECT, INSERT, UPDATE, DELETE ON "canvass_achievement" TO savvy_app;`).

- [ ] **Step 3: Deploy**

Run: `cd ~/Sites/savvy-crm && npx vercel --prod --archive=tgz --force --scope advosy`
Expected: Production alias `savvy-crm.vercel.app` ready.

- [ ] **Step 4: Verify the route is live (JSON 401, not 404 HTML)**

Run: `curl -s -o /dev/null -w "%{http_code}\n" "https://savvy-crm.vercel.app/api/canvass/scoreboard?period=week"`
Expected: `401`.

- [ ] **Step 5: Commit (tag the deploy in memory — no code)**

No commit; note the deploy hash in the session summary.

---

### Task 10: Field app — Compete tab, crown, badge toast

**Files:**
- Modify: `~/Sites/savvy-canvass/index.html` (nav, view, fetch/render, crown, toast, `APP_VERSION`)
- Modify: `~/Sites/savvy-canvass/sw.js` (`V` bump)
- Mirror: copy both to `~/Sites/savvy-canvass-deploy/`

**Interfaces:**
- Consumes: `GET /api/canvass/scoreboard`; `pushKnock` response `newBadges`; helpers `canvassBase()`, `authHeaders()`, `esc()`, `avatar()`, `flash()`, `isMgr()`.
- Produces: a `compete` view + nav item; crown on the leader's map avatar; a badge-unlock toast.

- [ ] **Step 1: Add the nav item + view section**

In `navItems()` (line ~511), add `['compete','Compete']` to both the manager and rep arrays. Add a view section in the `<main>` block:

```html
<section class="view" id="view-compete">
  <h2 class="vtitle">Compete</h2>
  <div class="seg" id="compSeg">
    <button data-p="day" class="on">Today</button><button data-p="week">Week</button><button data-p="month">Month</button>
  </div>
  <div id="compMe" class="card"></div>
  <div class="card"><h3>Leaderboard</h3><div id="compBoard"></div></div>
</section>
```

Add `if(v==='compete')renderCompete();` to the `show(v)` dispatcher.

- [ ] **Step 2: Add the render logic (near the stats section)**

```js
let compPeriod='day',compLeaders=[];
document.getElementById('compSeg').querySelectorAll('button').forEach(b=>b.onclick=()=>{
  compPeriod=b.dataset.p;
  document.getElementById('compSeg').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));
  renderCompete();
});
const BADGE_NAMES={first_sale:'First Blood',doors_100:'Century',doors_1000:'Grand',hot_hand:'Hot Hand',streak_5:'Iron Streak 5',streak_10:'Iron Streak 10',streak_30:'Iron Streak 30',rainmaker:'Rainmaker',early_bird:'Early Bird'};
async function renderCompete(){
  const h=authHeaders();if(!h){document.getElementById('compBoard').innerHTML='<div class="empty">Sign in to compete.</div>';return}
  try{
    const r=await fetch(canvassBase()+'/scoreboard?period='+compPeriod,{headers:h});
    if(!r.ok)return;
    compLeaders=(await r.json()).leaders||[];
  }catch(e){return}
  const me=compLeaders.find(l=>String(l.repId)===String(cur));
  document.getElementById('compMe').innerHTML=me
    ?`<h3>${esc(me.name)} · ${esc(me.tier)}</h3><div style="font-size:13px;color:var(--mut)">${me.points} pts · rank #${me.rank} · 🔥 ${me.streak}-day streak</div>`
    :'<div class="empty">Log knocks to get on the board.</div>';
  document.getElementById('compBoard').innerHTML=compLeaders.length
    ?compLeaders.map((l,i)=>`<div class="teamrow"><div style="width:26px;font-weight:700">${['🥇','🥈','🥉'][i]||('#'+(i+1))}</div><div style="flex:1"><div class="nm">${i===0?'👑 ':''}${esc(l.name)}</div><div class="sb">${esc(l.tier)} · 🔥${l.streak}</div></div><div style="text-align:right"><div class="nm">${l.points} pts</div><div class="sb">${l.sales} sales</div></div></div>`).join('')
    :'<div class="empty">No activity yet.</div>';
}
```

- [ ] **Step 3: Crown the leader on the map**

In `refreshMarkers()`, inside the manager avatar-marker block, after computing `latest`, add a crown when the rep is the current all-period leader. First, populate `compLeaders` for `day` on load by calling `renderCompete` once from `afterAuth`. In the avatar loop, change the avatar HTML to prepend a crown for the top leader:

```js
const isLeader=compLeaders[0]&&String(compLeaders[0].repId)===String(u.id);
const html=isLeader?`<div style="position:relative">${avatar(u,40)}<div style="position:absolute;top:-10px;left:50%;transform:translateX(-50%);font-size:16px">👑</div></div>`:avatar(u,40);
```

and use `html` in the `divIcon`. (If `compLeaders` is empty the map is unchanged.)

- [ ] **Step 4: Toast on badge unlock**

In `pushKnock`, after `const j=await r.json().catch(()=>({}))`, add:

```js
if(Array.isArray(j.newBadges)&&j.newBadges.length){
  j.newBadges.forEach(k=>flash('🏅 Badge unlocked: '+(BADGE_NAMES[k]||k)));
}
```

- [ ] **Step 5: Bump version, mirror, deploy, commit**

```bash
cd ~/Sites/savvy-canvass
# bump APP_VERSION to 1.13.0-beta in index.html and V to canvass-v1.13.0 in sw.js
node -e "const h=require('fs').readFileSync('index.html','utf8');for(const [,s] of h.matchAll(/<script>([\s\S]*?)<\/script>/g)){new Function(s)};console.log('JS parses OK')"
cp index.html sw.js ~/Sites/savvy-canvass-deploy/
git add index.html sw.js && git commit -m "feat: Compete tab — leaderboard, tier, streak, crown, badge toasts (v1.13.0-beta)"
npx wrangler pages deploy . --project-name=savvy-canvass
```
Expected: deploy completes; `curl -s https://savvy-canvass.pages.dev | grep -o "APP_VERSION='[^']*'"` → `1.13.0-beta`.

---

## Self-Review

**Spec coverage (Phase 1 sections):**
- Points model → Task 1 ✓
- Levels/tiers → Task 2 ✓
- Streaks → Task 3 ✓
- Achievements (eval + set) → Task 4; persistence → Task 6; hooked into sync → Task 8 ✓
- Leaderboard endpoint → Task 7 ✓
- Recognition surfaces (Compete tab, crown, toast) → Task 10 ✓
- `canvass_achievement` table → Task 5 ✓
- Deferred per spec Open Questions: `pitch_perfect` badge and pitch-based points — intentionally NOT in this plan (fast-follow).

**Type consistency:** `scoreRep`/`scoreKnock`/`levelFor`/`currentStreak`/`bestStreak`/`evaluateAchievements`/`unlockAchievements`/`listAchievementKeys` names match across producer and consumer tasks. `evaluateAchievements` takes `{knocks, tz, now?}` with `AchievementKnock{outcome, amount?, at}` in Tasks 4 and 8. Scoreboard `leaders[]` shape matches the field-app render in Task 10.

**Placeholder scan:** every code step contains complete code; no TBD/TODO. Migration filename `0075_*` is generated (name auto-assigned) — Task 5 Step 2 instructs confirming its contents rather than hardcoding the suffix.
