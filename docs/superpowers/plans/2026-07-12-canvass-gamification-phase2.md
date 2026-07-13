# Canvass Gamification Phase 2 (Challenges) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add rep-vs-rep and manager-run competitions on top of the Phase 1 scoreboard: daily head-to-head (W/L records), king-of-the-hill thrones, and manager contests — with live standings derived from knocks and automatic settlement.

**Architecture:** Derive-from-knocks (same as Phase 1). Standings are computed from `canvass_knock` by a shared pure `metricValue`; only the challenge instances, participants, and settled winners persist (two new tables). Settlement is a pure function, driven by a daily Inngest cron plus opportunistic settle-on-read.

**Tech Stack:** TypeScript, Next.js route handlers, Drizzle + Postgres (RLS), Inngest cron, Vitest, pnpm + Turborepo. Field app = one static `index.html`.

## Global Constraints

- Tenant isolation on every query via `withTenant(sess.tenantId, …)`; new tables carry `tenant_id` + `tenantIsolation()`.
- Every new endpoint: `export const runtime = "nodejs"`; auth `verifyCanvassToken(bearerToken(req.headers))` → 401; tenant from `sess.tenantId`; `canvassCors` + `OPTIONS`; added to the Clerk public allowlist in `apps/web/src/middleware.ts`. Mutations re-check `isCanvassRepActive`; contest-create is manager-only via `canvassManagerTenantId`.
- Metrics enum EXACT: `points | doors | contacts | appts | sales | revenue`. Kinds EXACT: `h2h | koth | contest`. Statuses EXACT: `pending | active | settled | declined | cancelled`.
- Points reuse Phase 1 `scoreRep`/`DEFAULT_POINT_WEIGHTS`; a "contact" = outcome ≠ `noanswer`; `appts` = outcome `appt`; `sales` = outcome `sale`; `revenue` = sum of sale `amount`. All day/window bucketing uses tenant `tenant.timezone` via `dateKeyInTimeZone` — never UTC.
- Migrations: `pnpm db:generate` → `packages/db/drizzle/NNNN_*.sql`; `pnpm db:up && pnpm db:migrate` locally. Prod via Supabase MCP `apply_migration` (prod numbering one ahead of local). Local is 0075; this phase generates 0076 locally = prod 0077.
- Before any DB test run: `docker exec savvy_db psql -U postgres -d savvy -c "DELETE FROM job_task WHERE task_id>=9000; DELETE FROM task_registry WHERE id>=9000" >/dev/null`; full suite uses `--no-file-parallelism`.
- Ignore the pre-existing `@savvy/integrations` vapi.ts typecheck error; add no new ones.

---

### Task 1: `metricValue` (pure core)

**Files:**
- Create: `packages/core/src/canvass-metric.ts`
- Create: `packages/core/src/canvass-metric.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./canvass-metric";` after `export * from "./canvass-points";`)

**Interfaces:**
- Consumes: `scoreRep`, `DEFAULT_POINT_WEIGHTS`, `ScoredKnockLike`, `CanvassPointWeights` from `./canvass-points`.
- Produces: `CHALLENGE_METRICS` (readonly tuple), `ChallengeMetric` type, `metricValue(knocks, metric, w?)→number`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/canvass-metric.test.ts
import { describe, expect, it } from "vitest";
import { metricValue } from "./canvass-metric";

const knocks = [
  { outcome: "noanswer" },
  { outcome: "notint" },
  { outcome: "appt" },
  { outcome: "sale", amount: 8000 },
  { outcome: "sale", amount: 2000 },
];

describe("metricValue", () => {
  it("computes each metric from a knock set", () => {
    expect(metricValue(knocks, "doors")).toBe(5);
    expect(metricValue(knocks, "contacts")).toBe(4); // all except the noanswer
    expect(metricValue(knocks, "appts")).toBe(1);
    expect(metricValue(knocks, "sales")).toBe(2);
    expect(metricValue(knocks, "revenue")).toBe(10000);
    // points: door1*5 + contact2*4 + appt10 + sale(25+8)+ sale(25+2) = 5+8+10+33+27 = 83
    expect(metricValue(knocks, "points")).toBe(83);
  });
  it("is 0 for an empty set", () => {
    expect(metricValue([], "points")).toBe(0);
    expect(metricValue([], "revenue")).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Sites/savvy-crm && npx vitest run packages/core/src/canvass-metric.test.ts`
Expected: FAIL — `Cannot find module './canvass-metric'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/canvass-metric.ts
import { scoreRep, DEFAULT_POINT_WEIGHTS, type ScoredKnockLike, type CanvassPointWeights } from "./canvass-points";

// The metrics a challenge/leaderboard can compete on. One function so standings,
// leaderboards, and challenges all agree.
export const CHALLENGE_METRICS = ["points", "doors", "contacts", "appts", "sales", "revenue"] as const;
export type ChallengeMetric = (typeof CHALLENGE_METRICS)[number];

export function metricValue(
  knocks: ScoredKnockLike[],
  metric: ChallengeMetric,
  w: CanvassPointWeights = DEFAULT_POINT_WEIGHTS,
): number {
  switch (metric) {
    case "points":
      return scoreRep(knocks, w);
    case "doors":
      return knocks.length;
    case "contacts":
      return knocks.filter((k) => k.outcome !== "noanswer").length;
    case "appts":
      return knocks.filter((k) => k.outcome === "appt").length;
    case "sales":
      return knocks.filter((k) => k.outcome === "sale").length;
    case "revenue":
      return knocks.filter((k) => k.outcome === "sale").reduce((s, k) => s + (k.amount ?? 0), 0);
  }
}
```

Add to `packages/core/src/index.ts` after `export * from "./canvass-points";`:

```ts
export * from "./canvass-metric";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Sites/savvy-crm && npx vitest run packages/core/src/canvass-metric.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/canvass-metric.ts packages/core/src/canvass-metric.test.ts packages/core/src/index.ts
git commit -m "feat(core): metricValue — any challenge metric from a knock set"
```

---

### Task 2: Challenge settlement + records (pure core)

**Files:**
- Create: `packages/core/src/canvass-challenge.ts`
- Create: `packages/core/src/canvass-challenge.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./canvass-challenge";`)

**Interfaces:**
- Produces: `CHALLENGE_KINDS` / `ChallengeKind`, `CHALLENGE_STATUSES` / `ChallengeStatus`, `Standing` (`{repId, score, rank}`), `rankStandings(scores)→Standing[]`, `settleWinner(scores)→string|null` (highest score; null on tie or empty), `h2hRecord(results, repId)→{wins, losses}`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/canvass-challenge.test.ts
import { describe, expect, it } from "vitest";
import { rankStandings, settleWinner, h2hRecord } from "./canvass-challenge";

describe("rankStandings", () => {
  it("sorts by score desc and assigns 1-based rank", () => {
    const r = rankStandings([{ repId: "a", score: 5 }, { repId: "b", score: 9 }, { repId: "c", score: 5 }]);
    expect(r.map((x) => x.repId)).toEqual(["b", "a", "c"]);
    expect(r.map((x) => x.rank)).toEqual([1, 2, 3]);
  });
});

describe("settleWinner", () => {
  it("returns the unique top scorer, or null on a tie/empty", () => {
    expect(settleWinner([{ repId: "a", score: 5 }, { repId: "b", score: 9 }])).toBe("b");
    expect(settleWinner([{ repId: "a", score: 5 }, { repId: "b", score: 5 }])).toBeNull(); // tie
    expect(settleWinner([])).toBeNull();
  });
});

describe("h2hRecord", () => {
  it("counts wins/losses for a rep across settled h2h results", () => {
    const results = [
      { winnerRepId: "a", participantIds: ["a", "b"] },
      { winnerRepId: "b", participantIds: ["a", "b"] },
      { winnerRepId: null, participantIds: ["a", "b"] }, // draw
      { winnerRepId: "a", participantIds: ["a", "c"] },
    ];
    expect(h2hRecord(results, "a")).toEqual({ wins: 2, losses: 1 }); // won 2, lost 1, 1 draw ignored
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Sites/savvy-crm && npx vitest run packages/core/src/canvass-challenge.test.ts`
Expected: FAIL — `Cannot find module './canvass-challenge'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/canvass-challenge.ts
export const CHALLENGE_KINDS = ["h2h", "koth", "contest"] as const;
export type ChallengeKind = (typeof CHALLENGE_KINDS)[number];

export const CHALLENGE_STATUSES = ["pending", "active", "settled", "declined", "cancelled"] as const;
export type ChallengeStatus = (typeof CHALLENGE_STATUSES)[number];

export interface Standing {
  repId: string;
  score: number;
  rank: number;
}

/** Sort participants by score desc; 1-based rank (ties share order but get distinct ranks by input order). */
export function rankStandings(scores: { repId: string; score: number }[]): Standing[] {
  return [...scores]
    .sort((a, b) => b.score - a.score)
    .map((s, i) => ({ repId: s.repId, score: s.score, rank: i + 1 }));
}

/** The unique top scorer, or null if the top score is tied or there are no scores. */
export function settleWinner(scores: { repId: string; score: number }[]): string | null {
  if (scores.length === 0) return null;
  const ranked = rankStandings(scores);
  if (ranked.length >= 2 && ranked[0]!.score === ranked[1]!.score) return null; // tie at the top
  return ranked[0]!.repId;
}

/** W/L for a rep across settled h2h results (draws — winnerRepId null — ignored). */
export function h2hRecord(
  results: { winnerRepId: string | null; participantIds: string[] }[],
  repId: string,
): { wins: number; losses: number } {
  let wins = 0;
  let losses = 0;
  for (const r of results) {
    if (!r.participantIds.includes(repId) || r.winnerRepId == null) continue;
    if (r.winnerRepId === repId) wins++;
    else losses++;
  }
  return { wins, losses };
}
```

Add to `packages/core/src/index.ts`:

```ts
export * from "./canvass-metric";
export * from "./canvass-challenge";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Sites/savvy-crm && npx vitest run packages/core/src/canvass-challenge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/canvass-challenge.ts packages/core/src/canvass-challenge.test.ts packages/core/src/index.ts
git commit -m "feat(core): challenge settlement + h2h W/L (rankStandings/settleWinner/h2hRecord)"
```

---

### Task 3: Challenge tables + migration

**Files:**
- Modify: `packages/db/src/schema/canvass.ts` (append two tables; `timestamp` already imported)
- Create (generated): `packages/db/drizzle/0076_*.sql`

**Interfaces:**
- Produces: `canvassChallenge`, `canvassChallengeParticipant` Drizzle tables, re-exported via `export * from "./schema/index"`.

- [ ] **Step 1: Append the tables to `packages/db/src/schema/canvass.ts`**

```ts
// A gamification challenge/contest. Standings are DERIVED from participants'
// knocks within [windowStart, windowEnd); only the instance + settled winner
// persist. kind h2h|koth|contest, metric points|doors|contacts|appts|sales|
// revenue, status pending|active|settled|declined|cancelled.
export const canvassChallenge = pgTable("canvass_challenge", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  kind: text("kind").notNull(),
  metric: text("metric").notNull(),
  status: text("status").notNull().default("pending"),
  createdByRepId: uuid("created_by_rep_id").notNull().references(() => canvassRep.id),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
  winnerRepId: uuid("winner_rep_id").references(() => canvassRep.id),
  meta: jsonb("meta").$type<Record<string, unknown>>().default({}).notNull(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index("canvass_challenge_tenant_idx").on(t.tenantId),
  index("canvass_challenge_tenant_status_idx").on(t.tenantId, t.status),
  tenantIsolation(),
]);

// A participant in a challenge; final_score is stamped at settlement. The unique
// (challenge, rep) index keeps a rep from joining a challenge twice.
export const canvassChallengeParticipant = pgTable("canvass_challenge_participant", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  challengeId: uuid("challenge_id").notNull().references(() => canvassChallenge.id),
  repId: uuid("rep_id").notNull().references(() => canvassRep.id),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  finalScore: doublePrecision("final_score"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("canvass_challenge_participant_uniq").on(t.challengeId, t.repId),
  index("canvass_challenge_participant_tenant_idx").on(t.tenantId),
  tenantIsolation(),
]);
```

- [ ] **Step 2: Generate the migration**

Run: `cd ~/Sites/savvy-crm && pnpm db:generate`
Expected: prints both tables and writes `packages/db/drizzle/0076_<name>.sql`. Confirm it CREATEs both tables, ENABLEs RLS on each, the unique index on `(challenge_id, rep_id)`, both `tenant_isolation` policies, and the FKs.

- [ ] **Step 3: Apply locally**

Run: `cd ~/Sites/savvy-crm && pnpm db:up && pnpm db:migrate`
Expected: `migrations + grants applied`.

- [ ] **Step 4: Typecheck**

Run: `cd ~/Sites/savvy-crm && pnpm typecheck`
Expected: 7/7, no new errors.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/canvass.ts packages/db/drizzle/
git commit -m "feat(db): canvass_challenge + canvass_challenge_participant tables"
```

---

### Task 4: Challenge lifecycle (DB)

**Files:**
- Create: `packages/db/src/lifecycle/canvass-challenge.ts`
- Create: `packages/db/tests/canvass-challenge.test.ts`
- Modify: `packages/db/src/index.ts` (add export after the `unlockAchievements` line)

**Interfaces:**
- Consumes: `canvassChallenge`, `canvassChallengeParticipant`, `canvassKnock`, `Tx`; `metricValue`, `rankStandings`, `settleWinner` from `@savvy/core`.
- Produces:
  - `createChallenge(tx, args)→Promise<{id}>` where args = `{tenantId, createdByRepId, kind, metric, windowStart, windowEnd, participantRepIds, meta?}`. Inserts the challenge (status: `active` for contest/koth, `pending` for h2h) and one participant row per rep (creator auto-accepted; others accepted only if not h2h).
  - `acceptChallenge(tx, tenantId, challengeId, repId)→Promise<boolean>` — stamps `acceptedAt`, flips a `pending` challenge to `active`; false if not a participant.
  - `setChallengeStatus(tx, tenantId, challengeId, status)→Promise<void>` — for decline/cancel.
  - `listChallenges(tx, tenantId)→Promise<ChallengeRow[]>` — challenges + their participant repIds.
  - `standingsFor(tx, tenantId, challenge)→Promise<Standing[]>` — live standings from participants' knocks within the window.
  - `settleDueChallenges(tx, tenantId, now)→Promise<number>` — for each `active` challenge past `windowEnd`: compute standings, write each participant's `final_score`, set `winner_rep_id` + `status='settled'` + `settled_at`. Returns count settled.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/canvass-challenge.test.ts
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { adminDb, adminPool, pool, eq, tenant, canvassRep, canvassKnock, canvassChallenge, canvassChallengeParticipant } from "../src/index";
import { withTenant } from "../src/tenant";
import { createChallenge, acceptChallenge, standingsFor, settleDueChallenges, listChallenges } from "../src/lifecycle/canvass-challenge";

let tId: string, repA: string, repB: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "CH", publicKey: `ch-${Date.now()}`, clerkOrgId: `org_ch_${Date.now()}` }).returning();
  tId = t!.id;
  const reps = await adminDb.insert(canvassRep).values([
    { tenantId: tId, name: "A", pinHash: "x" },
    { tenantId: tId, name: "B", pinHash: "x" },
  ]).returning();
  repA = reps[0]!.id; repB = reps[1]!.id;
  // A: 2 sales; B: 1 sale — within the window
  const now = new Date();
  await adminDb.insert(canvassKnock).values([
    { tenantId: tId, repId: repA, clientId: "a1", lat: 1, lng: 1, outcome: "sale", amount: 1000, createdAt: now },
    { tenantId: tId, repId: repA, clientId: "a2", lat: 1, lng: 1, outcome: "sale", amount: 1000, createdAt: now },
    { tenantId: tId, repId: repB, clientId: "b1", lat: 1, lng: 1, outcome: "sale", amount: 1000, createdAt: now },
  ]);
});

afterAll(async () => {
  await adminDb.delete(canvassChallengeParticipant).where(eq(canvassChallengeParticipant.tenantId, tId));
  await adminDb.delete(canvassChallenge).where(eq(canvassChallenge.tenantId, tId));
  await adminDb.delete(canvassKnock).where(eq(canvassKnock.tenantId, tId));
  await adminDb.delete(canvassRep).where(eq(canvassRep.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end(); await adminPool.end();
});

describe("challenge lifecycle", () => {
  it("creates an h2h (pending until accepted), accepts it, computes live standings, and settles the winner", async () => {
    const winStart = new Date(Date.now() - 3600_000);
    const winEnd = new Date(Date.now() - 1000); // already past → settleable once active
    const { id } = await withTenant(tId, (tx) => createChallenge(tx, {
      tenantId: tId, createdByRepId: repA, kind: "h2h", metric: "sales",
      windowStart: winStart, windowEnd: winEnd, participantRepIds: [repA, repB],
    }));
    expect(id).toBeTruthy();

    // pending until B accepts
    let list = await withTenant(tId, (tx) => listChallenges(tx, tId));
    expect(list[0]!.status).toBe("pending");
    const ok = await withTenant(tId, (tx) => acceptChallenge(tx, tId, id, repB));
    expect(ok).toBe(true);
    list = await withTenant(tId, (tx) => listChallenges(tx, tId));
    expect(list[0]!.status).toBe("active");

    // live standings: A (2 sales) over B (1 sale)
    const standings = await withTenant(tId, (tx) => standingsFor(tx, tId, list[0]!));
    expect(standings[0]!.repId).toBe(repA);
    expect(standings[0]!.score).toBe(2);

    // settle (window already ended)
    const n = await withTenant(tId, (tx) => settleDueChallenges(tx, tId, new Date()));
    expect(n).toBe(1);
    const settled = await withTenant(tId, (tx) => listChallenges(tx, tId));
    expect(settled[0]!.status).toBe("settled");
    expect(settled[0]!.winnerRepId).toBe(repA);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Sites/savvy-crm && docker exec savvy_db psql -U postgres -d savvy -c "DELETE FROM job_task WHERE task_id>=9000; DELETE FROM task_registry WHERE id>=9000" >/dev/null; npx vitest run packages/db/tests/canvass-challenge.test.ts`
Expected: FAIL — `Cannot find module '../src/lifecycle/canvass-challenge'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/db/src/lifecycle/canvass-challenge.ts
import { and, eq, inArray, gte, lt, lte } from "drizzle-orm";
import { metricValue, rankStandings, settleWinner, type ChallengeMetric, type Standing } from "@savvy/core";
import type { Tx } from "../tenant";
import { canvassChallenge, canvassChallengeParticipant, canvassKnock } from "../schema/index";

export interface CreateChallengeArgs {
  tenantId: string;
  createdByRepId: string;
  kind: "h2h" | "koth" | "contest";
  metric: ChallengeMetric;
  windowStart: Date;
  windowEnd: Date;
  participantRepIds: string[];
  meta?: Record<string, unknown>;
}

export interface ChallengeRow {
  id: string;
  kind: string;
  metric: string;
  status: string;
  createdByRepId: string;
  windowStart: Date;
  windowEnd: Date;
  winnerRepId: string | null;
  meta: Record<string, unknown>;
  participantIds: string[];
}

// h2h waits for the opponent to accept; koth/contest start active.
export async function createChallenge(tx: Tx, a: CreateChallengeArgs): Promise<{ id: string }> {
  const status = a.kind === "h2h" ? "pending" : "active";
  const [ch] = await tx
    .insert(canvassChallenge)
    .values({
      tenantId: a.tenantId, kind: a.kind, metric: a.metric, status,
      createdByRepId: a.createdByRepId, windowStart: a.windowStart, windowEnd: a.windowEnd,
      meta: a.meta ?? {},
    })
    .returning({ id: canvassChallenge.id });
  const id = ch!.id;
  // creator auto-accepts; for koth/contest everyone is in immediately, for h2h
  // the opponent's acceptedAt stays null until they accept.
  const now = new Date();
  await tx.insert(canvassChallengeParticipant).values(
    a.participantRepIds.map((repId) => ({
      tenantId: a.tenantId,
      challengeId: id,
      repId,
      acceptedAt: repId === a.createdByRepId || a.kind !== "h2h" ? now : null,
    })),
  );
  return { id };
}

export async function acceptChallenge(tx: Tx, tenantId: string, challengeId: string, repId: string): Promise<boolean> {
  const rows = await tx
    .update(canvassChallengeParticipant)
    .set({ acceptedAt: new Date() })
    .where(and(eq(canvassChallengeParticipant.challengeId, challengeId), eq(canvassChallengeParticipant.repId, repId)))
    .returning({ id: canvassChallengeParticipant.id });
  if (rows.length === 0) return false;
  await tx
    .update(canvassChallenge)
    .set({ status: "active" })
    .where(and(eq(canvassChallenge.id, challengeId), eq(canvassChallenge.status, "pending")));
  return true;
}

export async function setChallengeStatus(tx: Tx, tenantId: string, challengeId: string, status: string): Promise<void> {
  await tx.update(canvassChallenge).set({ status }).where(eq(canvassChallenge.id, challengeId));
}

export async function listChallenges(tx: Tx, tenantId: string): Promise<ChallengeRow[]> {
  const chs = await tx.select().from(canvassChallenge);
  if (chs.length === 0) return [];
  const parts = await tx.select().from(canvassChallengeParticipant);
  return chs.map((c) => ({
    id: c.id, kind: c.kind, metric: c.metric, status: c.status,
    createdByRepId: c.createdByRepId, windowStart: c.windowStart, windowEnd: c.windowEnd,
    winnerRepId: c.winnerRepId, meta: c.meta,
    participantIds: parts.filter((p) => p.challengeId === c.id).map((p) => p.repId),
  }));
}

// Live standings from each participant's knocks within the window.
export async function standingsFor(tx: Tx, tenantId: string, ch: ChallengeRow): Promise<Standing[]> {
  if (ch.participantIds.length === 0) return [];
  const rows = await tx
    .select({ repId: canvassKnock.repId, outcome: canvassKnock.outcome, amount: canvassKnock.amount })
    .from(canvassKnock)
    .where(and(
      inArray(canvassKnock.repId, ch.participantIds),
      gte(canvassKnock.createdAt, ch.windowStart),
      lt(canvassKnock.createdAt, ch.windowEnd),
    ));
  const scores = ch.participantIds.map((repId) => ({
    repId,
    score: metricValue(rows.filter((r) => r.repId === repId), ch.metric as ChallengeMetric),
  }));
  return rankStandings(scores);
}

// Settle every active challenge whose window has ended: stamp final scores,
// winner, status. Returns how many were settled.
export async function settleDueChallenges(tx: Tx, tenantId: string, now: Date): Promise<number> {
  const due = (await listChallenges(tx, tenantId)).filter((c) => c.status === "active" && c.windowEnd <= now);
  for (const ch of due) {
    const standings = await standingsFor(tx, tenantId, ch);
    for (const s of standings) {
      await tx
        .update(canvassChallengeParticipant)
        .set({ finalScore: s.score })
        .where(and(eq(canvassChallengeParticipant.challengeId, ch.id), eq(canvassChallengeParticipant.repId, s.repId)));
    }
    await tx
      .update(canvassChallenge)
      .set({ status: "settled", winnerRepId: settleWinner(standings), settledAt: now })
      .where(eq(canvassChallenge.id, ch.id));
  }
  return due.length;
}
```

Add to `packages/db/src/index.ts` after the `unlockAchievements` line:

```ts
export { createChallenge, acceptChallenge, setChallengeStatus, listChallenges, standingsFor, settleDueChallenges, type ChallengeRow, type CreateChallengeArgs } from "./lifecycle/canvass-challenge";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Sites/savvy-crm && docker exec savvy_db psql -U postgres -d savvy -c "DELETE FROM job_task WHERE task_id>=9000; DELETE FROM task_registry WHERE id>=9000" >/dev/null; npx vitest run packages/db/tests/canvass-challenge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/canvass-challenge.ts packages/db/tests/canvass-challenge.test.ts packages/db/src/index.ts
git commit -m "feat(db): challenge lifecycle (create/accept/standings/settle)"
```

---

### Task 5: Challenge endpoints

**Files:**
- Create: `apps/web/src/app/api/canvass/challenge/route.ts` (POST create)
- Create: `apps/web/src/app/api/canvass/challenge/[id]/route.ts` (POST accept/decline via `?action=`)
- Create: `apps/web/src/app/api/canvass/challenges/route.ts` (GET list, settle-on-read)
- Modify: `apps/web/src/middleware.ts` (allowlist: add `challenges`, `challenge`, and a pattern for `/challenge/<id>`)

**Interfaces:**
- Consumes: `createChallenge`, `acceptChallenge`, `setChallengeStatus`, `listChallenges`, `standingsFor`, `settleDueChallenges`, `isCanvassRepActive`, `isCanvassManager`, `withTenant`, `tenant`, `eq` from `@savvy/db`; `CHALLENGE_KINDS`, `CHALLENGE_METRICS`, `dateKeyInTimeZone` from `@savvy/core`; the canvass-session + cors + rate-limit libs.
- Produces: `POST /api/canvass/challenge`, `POST /api/canvass/challenge/:id?action=accept|decline|cancel`, `GET /api/canvass/challenges` (returns `{challenges:[{…, standings, participantIds}]}`).

- [ ] **Step 1: Update the middleware allowlist**

In `apps/web/src/middleware.ts`, the `PUBLIC` array: extend the canvass exact-match alternation to include `challenge` and `challenges`, and ADD one new regex to the array for the dynamic id route. Change the canvass entry to end `…|scoreboard|challenge|challenges)$/` and add, as a new array element right after it:

```ts
/^\/api\/canvass\/challenge\/[^/]+$/,
```

- [ ] **Step 2: Write the create route**

```ts
// apps/web/src/app/api/canvass/challenge/route.ts
import { NextResponse } from "next/server";
import { CHALLENGE_KINDS, CHALLENGE_METRICS, instantAtLocalHourOnDayOf, type ChallengeKind, type ChallengeMetric } from "@savvy/core";
import { withTenant, tenant, createChallenge, isCanvassRepActive, isCanvassManager, eq } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "POST, OPTIONS") });
}

// POST — create a challenge. Body: { kind, metric, targetRepId?, participantIds?,
// windowHours? }. h2h/koth need targetRepId (opponent / current throne holder);
// contest needs participantIds and is manager-only. Window = now → now+windowHours
// (default: end of the tenant-local day for h2h).
export async function POST(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  let body: { kind?: string; metric?: string; targetRepId?: string; participantIds?: string[]; windowHours?: number };
  try { body = (await req.json()) as typeof body; } catch { return reply({ error: "invalid json" }, 400); }

  const kind = body.kind as ChallengeKind;
  const metric = body.metric as ChallengeMetric;
  if (!CHALLENGE_KINDS.includes(kind)) return reply({ error: "bad kind" }, 400);
  if (!CHALLENGE_METRICS.includes(metric)) return reply({ error: "bad metric" }, 400);

  const result = await withTenant(sess.tenantId, async (tx) => {
    if (!(await isCanvassRepActive(tx, sess.tenantId, sess.repId))) return { error: "unauthorized" as const };
    let participantRepIds: string[];
    if (kind === "contest") {
      if (!(await isCanvassManager(tx, sess.tenantId, sess.repId))) return { error: "forbidden" as const };
      participantRepIds = Array.from(new Set([...(body.participantIds ?? [])]));
      if (participantRepIds.length < 2) return { error: "need participants" as const };
    } else {
      if (!body.targetRepId || body.targetRepId === sess.repId) return { error: "need opponent" as const };
      participantRepIds = [sess.repId, body.targetRepId];
    }
    const now = new Date();
    const [tRow] = await tx.select({ timezone: tenant.timezone }).from(tenant).where(eq(tenant.id, sess.tenantId));
    const tz = tRow?.timezone ?? "UTC";
    // default window: h2h = end of the tenant-LOCAL day (midnight local tomorrow,
    // DST-correct via instantAtLocalHourOnDayOf on a tomorrow anchor); else windowHours (24 default)
    let windowEnd: Date;
    if (body.windowHours) windowEnd = new Date(now.getTime() + body.windowHours * 3600_000);
    else if (kind === "h2h") windowEnd = instantAtLocalHourOnDayOf(new Date(now.getTime() + 24 * 3600_000), tz, 0);
    else windowEnd = new Date(now.getTime() + 24 * 3600_000);
    const { id } = await createChallenge(tx, {
      tenantId: sess.tenantId, createdByRepId: sess.repId, kind, metric,
      windowStart: now, windowEnd, participantRepIds,
    });
    return { id };
  });
  if ("error" in result) {
    const code = result.error === "forbidden" ? 403 : result.error === "unauthorized" ? 401 : 400;
    return reply({ error: result.error }, code);
  }
  return reply({ ok: true, id: result.id }, 201);
}
```

- [ ] **Step 3: Write the accept/decline route**

```ts
// apps/web/src/app/api/canvass/challenge/[id]/route.ts
import { NextResponse } from "next/server";
import { withTenant, acceptChallenge, setChallengeStatus, listChallenges, isCanvassRepActive } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "POST, OPTIONS") });
}

// POST /challenge/:id?action=accept|decline|cancel
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const headers = canvassCors(req, "POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  const { id } = await ctx.params;
  const action = new URL(req.url).searchParams.get("action") || "accept";

  const out = await withTenant(sess.tenantId, async (tx) => {
    if (!(await isCanvassRepActive(tx, sess.tenantId, sess.repId))) return { error: "unauthorized" as const };
    const ch = (await listChallenges(tx, sess.tenantId)).find((c) => c.id === id);
    if (!ch) return { error: "not found" as const };
    if (action === "accept") {
      const done = await acceptChallenge(tx, sess.tenantId, id, sess.repId);
      return done ? { ok: true } : { error: "not a participant" as const };
    }
    if (action === "decline" || action === "cancel") {
      // decline: opponent rejects; cancel: creator withdraws
      if (action === "cancel" && ch.createdByRepId !== sess.repId) return { error: "forbidden" as const };
      await setChallengeStatus(tx, sess.tenantId, id, action === "decline" ? "declined" : "cancelled");
      return { ok: true };
    }
    return { error: "bad action" as const };
  });
  if ("error" in out) {
    const code = out.error === "forbidden" ? 403 : out.error === "unauthorized" ? 401 : out.error === "not found" ? 404 : 400;
    return reply({ error: out.error }, code);
  }
  return reply(out, 200);
}
```

- [ ] **Step 4: Write the list route (settle-on-read)**

```ts
// apps/web/src/app/api/canvass/challenges/route.ts
import { NextResponse } from "next/server";
import { withTenant, listChallenges, standingsFor, settleDueChallenges } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, OPTIONS") });
}

// GET — all challenges with live standings. Settles any past-window active
// challenges first (opportunistic; the cron is the backstop).
export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass-read", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  const challenges = await withTenant(sess.tenantId, async (tx) => {
    await settleDueChallenges(tx, sess.tenantId, new Date());
    const list = await listChallenges(tx, sess.tenantId);
    return Promise.all(
      list.map(async (c) => ({
        ...c,
        standings: c.status === "settled" ? [] : await standingsFor(tx, sess.tenantId, c),
      })),
    );
  });
  return reply({ challenges }, 200);
}
```

- [ ] **Step 5: Typecheck + commit**

Run: `cd ~/Sites/savvy-crm && pnpm typecheck` → no new errors.

```bash
git add apps/web/src/app/api/canvass/challenge apps/web/src/app/api/canvass/challenges apps/web/src/middleware.ts
git commit -m "feat(canvass): challenge endpoints (create/accept/decline/list+settle-on-read)"
```

---

### Task 6: Settlement cron

**Files:**
- Create: `packages/agents/src/functions/challenge-settle.ts`
- Modify: `packages/agents/src/index.ts` (import + export + add to `functions` array)

**Interfaces:**
- Consumes: `adminDb`, `tenant`, `withTenant`, `settleDueChallenges` from `@savvy/db`; `inngest` from `../client`.
- Produces: `challengeSettleHourly` Inngest function (hourly cron) that settles due challenges for every tenant.

- [ ] **Step 1: Write the cron**

```ts
// packages/agents/src/functions/challenge-settle.ts
import { adminDb, tenant, withTenant, settleDueChallenges } from "@savvy/db";
import { inngest } from "../client";

// Hourly: settle any challenge whose window has ended. GET /challenges also
// settles opportunistically; this is the backstop for challenges no one reads.
export const challengeSettleHourly = inngest.createFunction(
  { id: "challenge-settle-hourly" },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const tenants = await step.run("tenants", () => adminDb.select({ id: tenant.id }).from(tenant));
    let settled = 0;
    for (const t of tenants) {
      settled += await step.run(`settle:${t.id}`, () => withTenant(t.id, (tx) => settleDueChallenges(tx, t.id, new Date())));
    }
    return { settled };
  },
);
```

- [ ] **Step 2: Register the function**

In `packages/agents/src/index.ts`: add `import { challengeSettleHourly } from "./functions/challenge-settle";` near the other function imports, `export { challengeSettleHourly } from "./functions/challenge-settle";` near the exports, and append `challengeSettleHourly` to the `functions` array.

- [ ] **Step 3: Typecheck + commit**

Run: `cd ~/Sites/savvy-crm && pnpm typecheck` → no new errors.

```bash
git add packages/agents/src/functions/challenge-settle.ts packages/agents/src/index.ts
git commit -m "feat(agents): hourly challenge settlement cron (backstop)"
```

---

### Task 7: Field app — Challenges in the Compete tab

**Files:**
- Modify: `~/Sites/savvy-canvass/index.html` (challenges section in the Compete view, create/accept UI, render, `APP_VERSION`)
- Modify: `~/Sites/savvy-canvass/sw.js` (`V` bump)
- Mirror: copy both to `~/Sites/savvy-canvass-deploy/`

**Interfaces:**
- Consumes: `GET /api/canvass/challenges`, `POST /api/canvass/challenge`, `POST /api/canvass/challenge/:id?action=`; helpers `canvassBase()`, `authHeaders()`, `esc()`, `flash()`, `user(id)`, `cur`, `isMgr()`, `db.users`, `compLeaders` (from Phase 1).
- Produces: a Challenges block in the Compete view.

- [ ] **Step 1: Add the challenges block to the Compete view**

In the `#view-compete` section (added in Phase 1), after the leaderboard card, add:

```html
<div class="card"><h3>Challenges</h3>
  <button class="btn sec sm" id="compNewChallenge" style="margin-bottom:8px">⚔️ Challenge a teammate</button>
  <div id="compChallenges"></div>
</div>
```

- [ ] **Step 2: Add the render + create logic (near renderCompete)**

```js
const METRIC_LABELS={points:'Points',doors:'Doors',contacts:'Contacts',appts:'Appts',sales:'Sales',revenue:'Revenue'};
async function renderChallenges(){
  const el=document.getElementById('compChallenges');const h=authHeaders();if(!h){el.innerHTML='';return}
  let list=[];try{const r=await fetch(canvassBase()+'/challenges',{headers:h});if(r.ok)list=(await r.json()).challenges||[]}catch(e){return}
  const active=list.filter(c=>c.status==='active'||c.status==='pending');
  const mine=active.filter(c=>c.participantIds.includes(cur));
  el.innerHTML=mine.length?mine.map(c=>{
    const st=(c.standings||[]).map(s=>esc(user(s.repId).name)+' '+s.score).join(' · ');
    const pend=c.status==='pending';
    const iAmTarget=pend&&c.createdByRepId!==cur&&c.participantIds.includes(cur);
    return `<div class="list-item"><div class="t"><span>${esc(METRIC_LABELS[c.metric]||c.metric)} · ${esc(c.kind)}</span><span class="pill p-appt">${pend?'pending':'live'}</span></div>
      <div class="s">${st||'no activity yet'}</div>
      ${iAmTarget?`<div class="row" style="margin-top:6px"><button class="btn grn sm" onclick="challengeAct('${c.id}','accept')">Accept</button><button class="btn sec sm" onclick="challengeAct('${c.id}','decline')">Decline</button></div>`:''}</div>`;
  }).join(''):'<div class="empty">No active challenges. Challenge a teammate!</div>';
}
window.challengeAct=async(id,action)=>{
  const h=authHeaders();if(!h)return;
  try{const r=await fetch(canvassBase()+'/challenge/'+id+'?action='+action,{method:'POST',headers:h});
    if(r.ok){flash(action==='accept'?'Challenge accepted ⚔️':'Declined');renderChallenges()}else flash('Could not update challenge')}catch(e){flash('Network error')}
};
document.getElementById('compNewChallenge').onclick=()=>{
  const opps=db.users.filter(u=>u.role==='rep'&&u.active!==false&&u.id!==cur);
  if(!opps.length){flash('No teammates to challenge yet');return}
  const name=prompt('Challenge which teammate?\n'+opps.map((u,i)=>(i+1)+'. '+u.name).join('\n'));
  const idx=parseInt(name)-1;const opp=opps[idx];if(!opp){return}
  const metric=prompt('Metric? points / doors / contacts / appts / sales / revenue','doors');
  if(!['points','doors','contacts','appts','sales','revenue'].includes(metric)){flash('Unknown metric');return}
  fetch(canvassBase()+'/challenge',{method:'POST',headers:{'Content-Type':'application/json',...authHeaders()},
    body:JSON.stringify({kind:'h2h',metric,targetRepId:opp.id})})
    .then(r=>r.ok?r.json():null).then(j=>{if(j&&j.ok){flash('Challenge sent to '+opp.name+' ⚔️');renderChallenges()}else flash('Could not send challenge')}).catch(()=>flash('Network error'));
};
```

Add `renderChallenges();` to the end of `renderCompete()` so it loads with the tab.

- [ ] **Step 3: Bump version, verify, mirror, commit, deploy**

```bash
cd ~/Sites/savvy-canvass
# bump APP_VERSION 1.13.1-beta -> 1.14.0-beta ; sw.js V canvass-v1.13.1 -> canvass-v1.14.0
node -e "const h=require('fs').readFileSync('index.html','utf8');for(const [,s] of h.matchAll(/<script>([\s\S]*?)<\/script>/g)){new Function(s)};console.log('JS parses OK')"
cp index.html sw.js ~/Sites/savvy-canvass-deploy/
git add index.html sw.js && git commit -m "feat: challenges in Compete tab — create h2h, accept/decline, live standings (v1.14.0-beta)"
npx wrangler pages deploy . --project-name=savvy-canvass
```
Expected: `curl -s https://savvy-canvass.pages.dev | grep -o "APP_VERSION='[^']*'"` → `1.14.0-beta`.

---

## Self-Review

**Spec coverage (Phase 2):**
- `metricValue` shared fn → Task 1 ✓
- Challenge settlement + h2h W/L → Task 2 ✓
- `canvass_challenge` + `canvass_challenge_participant` tables → Task 3 ✓
- create/accept/decline/list + live standings + settle → Tasks 4 (lifecycle) + 5 (endpoints) ✓
- daily h2h (pending→accept→settle, W/L) → Tasks 4/5/7 ✓
- manager contest (participantIds, manager-only) → Task 5 ✓
- settlement cron + settle-on-read → Task 6 + Task 5 (list route) ✓
- field-app challenges UI → Task 7 ✓
- **Deferred within Phase 2 (documented, not a gap):** koth "throne takes badge" and the dedicated koth duel flow are represented at the data level (kind `koth` is accepted) but the field-app create UI ships **h2h only** in this plan; koth create + throne badge is a Phase 2 fast-follow. Wagers/prize pools are Phase 3.

**Type consistency:** `metricValue(knocks, metric, w?)`, `rankStandings`, `settleWinner`, `h2hRecord` names match producer/consumer. `ChallengeRow`/`Standing` shapes are consumed identically in the lifecycle, the list route, and the field-app render. `createChallenge` arg object matches Task 4 definition and Task 5 call. Status/kind/metric string literals match the enums in Task 2/Task 1.

**Placeholder scan:** every code step is complete. Migration filename `0076_*` is generated (Task 3 Step 2 confirms contents). The h2h end-of-day window uses a local-ish string (`${todayKey}T23:59:59`) — acceptable approximation for a daily duel; noted, not a placeholder.
