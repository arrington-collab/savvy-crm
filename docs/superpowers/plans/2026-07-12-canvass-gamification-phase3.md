# Canvass Gamification Phase 3 — Spiffs & Payouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a money-ledger layer on top of Phase 2 challenges — wagers (loser owes winner), contest prize pools (manager funds, distributed to winner), and manual spiffs — surfaced on a manager Spiffs screen with a mark-paid action. Ledger only, no payment processing.

**Architecture:** One new table `canvass_spiff`. Wager/prize spiffs are created *inside* the Phase 2 `settleDueChallenges` settlement path (same transaction that stamps the winner), derived by a pure `@savvy/core` function from the settled standings + the challenge's `meta.wagerCents` / `meta.prizePoolCents`. Manual spiffs + mark-paid are direct lifecycle calls behind manager-only endpoints. The field app gets a manager Spiffs screen and a wager input on h2h challenge creation.

**Tech Stack:** TypeScript, Drizzle + Postgres (RLS), Next.js App Router route handlers, Vitest, vanilla-JS PWA (`~/Sites/savvy-canvass`).

## Global Constraints

- **Money is integer cents.** Every amount column and field is `*_cents` (integer). No floats, no dollars in the data layer. The field app converts dollars→cents on input and cents→dollars on display.
- **Tenant isolation on every table and query.** `canvass_spiff` has `tenant_id` + the standard `tenantIsolation()` RLS policy scoped to `savvy_app`. All DB access goes through `withTenant(tenantId, tx => …)`. Lifecycle functions take a `tenantId` param for signature parity even though RLS does the scoping (house convention — see Phase 2).
- **Spiff kinds:** `wager` | `contest_prize` | `manual`. **Spiff statuses:** `owed` | `paid` | `void`. Use these exact strings.
- **No payment processing.** Spiffs are a ledger reps settle in real life; mark-paid only flips `status` to `paid` and stamps `settled_at`.
- **Manager-only writes.** `POST /spiff` (manual) and `POST /spiff/:id/paid` require `isCanvassManager`. `GET /spiffs?scope=mine` is any rep (their own); `scope=all` is manager-only.
- **Bearer session + rate limit** on every endpoint, matching the Phase 2 challenge routes exactly (`verifyCanvassToken(bearerToken(req.headers))`, `checkRateLimit`, `canvassCors`).
- **Additive only.** Do not modify Phase 1/2 behavior except the two documented settlement hook points in `settleDueChallenges` and the field-app version bumps.

---

## File Structure

- `packages/core/src/canvass-spiff.ts` — **new.** `SPIFF_KINDS`, `SPIFF_STATUSES`, types, and pure `settlementSpiffs(ch, standings, winnerRepId)` → array of spiff descriptors from a settled challenge's wager/prize meta.
- `packages/core/src/index.ts` — **modify.** Re-export the new module.
- `packages/core/tests/canvass-spiff.test.ts` — **new.** Table-driven tests for `settlementSpiffs`.
- `packages/db/src/schema/canvass.ts` — **modify.** Append `canvassSpiff` table + RLS.
- `packages/db/src/schema/index.ts` — already `export * from "./canvass"`; no change needed (verify).
- `packages/db/drizzle/NNNN_*.sql` — **generated** by `pnpm db:generate`.
- `packages/db/src/lifecycle/canvass-spiff.ts` — **new.** `createManualSpiff`, `listSpiffs`, `markSpiffPaid`, `createSettlementSpiffs`.
- `packages/db/src/lifecycle/canvass-challenge.ts` — **modify.** In `settleDueChallenges`, after stamping the winner, call `createSettlementSpiffs`.
- `packages/db/tests/canvass-spiff.test.ts` — **new.** DB-backed: manual create, list scoping, owed→paid, wager-on-settle, prize-on-settle.
- `apps/web/src/app/api/canvass/spiffs/route.ts` — **new.** `GET` list (scope mine|all).
- `apps/web/src/app/api/canvass/spiff/route.ts` — **new.** `POST` manual spiff (manager).
- `apps/web/src/app/api/canvass/spiff/[id]/route.ts` — **new.** `POST ?action=paid` (manager).
- `apps/web/src/middleware.ts` — **modify.** Extend the canvass allowlist for `spiffs`, `spiff`, and `/spiff/:id`.
- `~/Sites/savvy-canvass/index.html` — **modify.** Spiffs card in `#view-compete` (manager), wager input on challenge create, `renderSpiffs()`, `window.spiffPaid`. `APP_VERSION` → `1.15.0-beta`.
- `~/Sites/savvy-canvass/sw.js` — **modify.** `V` → `canvass-v1.15.0`.

---

### Task 1: Core — pure settlement-spiff derivation

**Files:**
- Create: `packages/core/src/canvass-spiff.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/canvass-spiff.test.ts`

**Interfaces:**
- Consumes: `Standing` from `@savvy/core` (`{ repId: string; score: number; rank: number }` — from Phase 2 `canvass-challenge.ts`). A settled challenge shape `{ kind: string; meta: Record<string, unknown> }`.
- Produces: `SPIFF_KINDS`, `SPIFF_STATUSES`, `SpiffKind`, `SpiffDescriptor`, `settlementSpiffs(ch, standings, winnerRepId)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/canvass-spiff.test.ts
import { describe, expect, it } from "vitest";
import { settlementSpiffs, SPIFF_KINDS, SPIFF_STATUSES } from "../src/canvass-spiff";

const st = (repId: string, score: number, rank: number) => ({ repId, score, rank });

describe("SPIFF constants", () => {
  it("exposes kinds and statuses", () => {
    expect(SPIFF_KINDS).toEqual(["wager", "contest_prize", "manual"]);
    expect(SPIFF_STATUSES).toEqual(["owed", "paid", "void"]);
  });
});

describe("settlementSpiffs — wager (h2h/koth)", () => {
  it("loser owes winner the wager amount", () => {
    const ch = { kind: "h2h", meta: { wagerCents: 2000 } };
    const standings = [st("A", 30, 1), st("B", 10, 2)];
    const out = settlementSpiffs(ch, standings, "A");
    expect(out).toEqual([
      { kind: "wager", amountCents: 2000, winnerRepId: "A", fromRepId: "B" },
    ]);
  });

  it("emits one wager row per loser in a koth (all losers owe the winner)", () => {
    const ch = { kind: "koth", meta: { wagerCents: 500 } };
    const standings = [st("A", 30, 1), st("B", 20, 2), st("C", 10, 3)];
    const out = settlementSpiffs(ch, standings, "A");
    expect(out).toEqual([
      { kind: "wager", amountCents: 500, winnerRepId: "A", fromRepId: "B" },
      { kind: "wager", amountCents: 500, winnerRepId: "A", fromRepId: "C" },
    ]);
  });

  it("no spiffs when wager is absent, zero, or there is no winner (tie)", () => {
    expect(settlementSpiffs({ kind: "h2h", meta: {} }, [st("A", 1, 1), st("B", 1, 1)], "A")).toEqual([]);
    expect(settlementSpiffs({ kind: "h2h", meta: { wagerCents: 0 } }, [st("A", 3, 1), st("B", 1, 2)], "A")).toEqual([]);
    expect(settlementSpiffs({ kind: "h2h", meta: { wagerCents: 2000 } }, [st("A", 1, 1), st("B", 1, 1)], null)).toEqual([]);
  });
});

describe("settlementSpiffs — contest prize", () => {
  it("whole pool goes to the single winner, from_rep null", () => {
    const ch = { kind: "contest", meta: { prizePoolCents: 10000 } };
    const standings = [st("A", 50, 1), st("B", 20, 2), st("C", 10, 3)];
    const out = settlementSpiffs(ch, standings, "A");
    expect(out).toEqual([
      { kind: "contest_prize", amountCents: 10000, winnerRepId: "A", fromRepId: null },
    ]);
  });

  it("no prize spiff without a pool or without a winner", () => {
    expect(settlementSpiffs({ kind: "contest", meta: {} }, [st("A", 5, 1)], "A")).toEqual([]);
    expect(settlementSpiffs({ kind: "contest", meta: { prizePoolCents: 5000 } }, [], null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Sites/savvy-crm && npx vitest run packages/core/tests/canvass-spiff.test.ts`
Expected: FAIL — cannot find module `../src/canvass-spiff`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/canvass-spiff.ts
import type { Standing } from "./canvass-challenge";

export const SPIFF_KINDS = ["wager", "contest_prize", "manual"] as const;
export type SpiffKind = (typeof SPIFF_KINDS)[number];

export const SPIFF_STATUSES = ["owed", "paid", "void"] as const;
export type SpiffStatus = (typeof SPIFF_STATUSES)[number];

export interface SpiffDescriptor {
  kind: SpiffKind;
  amountCents: number;
  winnerRepId: string;
  fromRepId: string | null;
}

interface SettledChallenge {
  kind: string;
  meta: Record<string, unknown>;
}

function posInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

// Given a just-settled challenge, its final standings, and the winner, derive
// the money-ledger rows to write. Pure — no DB, no side effects. Returns [] when
// there is no winner (tie) or no wager/prize configured.
export function settlementSpiffs(
  ch: SettledChallenge,
  standings: Standing[],
  winnerRepId: string | null,
): SpiffDescriptor[] {
  if (!winnerRepId) return [];

  if (ch.kind === "contest") {
    const pool = posInt(ch.meta.prizePoolCents);
    if (pool === 0) return [];
    return [{ kind: "contest_prize", amountCents: pool, winnerRepId, fromRepId: null }];
  }

  // h2h / koth wager: every non-winner owes the winner the wager amount.
  const wager = posInt(ch.meta.wagerCents);
  if (wager === 0) return [];
  return standings
    .filter((s) => s.repId !== winnerRepId)
    .map((s) => ({ kind: "wager" as const, amountCents: wager, winnerRepId, fromRepId: s.repId }));
}
```

- [ ] **Step 4: Add the re-export**

In `packages/core/src/index.ts`, add alongside the other canvass re-exports:

```ts
export * from "./canvass-spiff";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/Sites/savvy-crm && npx vitest run packages/core/tests/canvass-spiff.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/canvass-spiff.ts packages/core/src/index.ts packages/core/tests/canvass-spiff.test.ts
git commit -m "feat(canvass): pure settlement-spiff derivation (wager/prize)"
```

---

### Task 2: DB — canvass_spiff table + migration

**Files:**
- Modify: `packages/db/src/schema/canvass.ts` (append at end)
- Generate: `packages/db/drizzle/NNNN_*.sql`

**Interfaces:**
- Consumes: existing `tenant`, `canvassRep`, `canvassChallenge` tables + the `tenantIsolation` helper and `createdAt`/id-column conventions used by `canvassChallenge` (read the top of `canvass.ts` and the `canvassChallenge` definition to copy the exact column helpers, `pgTable` import style, and how RLS is attached).
- Produces: `canvassSpiff` table export.

- [ ] **Step 1: Read the existing conventions**

Open `packages/db/src/schema/canvass.ts` and study how `canvassChallenge` / `canvassChallengeParticipant` were defined at the end of the file: the id column helper, `tenantId` column + FK to `tenant`, `createdAt` helper, `.enableRLS()` / `tenantIsolation(...)` call, and index style. Match them exactly — do not introduce a new pattern.

- [ ] **Step 2: Append the table**

Add at the end of `packages/db/src/schema/canvass.ts` (adjust the exact column helpers to match the file's conventions — this is the intended shape):

```ts
export const canvassSpiff = pgTable(
  "canvass_spiff",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
    challengeId: uuid("challenge_id").references(() => canvassChallenge.id, { onDelete: "set null" }),
    kind: text("kind").notNull(), // wager | contest_prize | manual
    amountCents: integer("amount_cents").notNull(),
    winnerRepId: uuid("winner_rep_id").notNull().references(() => canvassRep.id, { onDelete: "cascade" }),
    fromRepId: uuid("from_rep_id").references(() => canvassRep.id, { onDelete: "set null" }),
    status: text("status").notNull().default("owed"), // owed | paid | void
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => [
    index("canvass_spiff_tenant_idx").on(t.tenantId),
    index("canvass_spiff_winner_idx").on(t.winnerRepId),
    tenantIsolation(t),
  ],
).enableRLS();
```

> Match the actual import names in the file. If the file imports `integer`, `text`, `uuid`, `timestamp`, `index`, `pgTable`, `tenantIsolation` — reuse them; add any missing import to the existing import block. If `canvassChallenge`'s columns use a shared `createdAt()` helper instead of an inline `timestamp(...)`, use that helper for `createdAt` and `settledAt` for consistency.

- [ ] **Step 3: Generate the migration**

Run: `cd ~/Sites/savvy-crm && pnpm db:generate`
Expected: a new `packages/db/drizzle/NNNN_*.sql` creating `canvass_spiff` with the RLS policy. Open it and confirm: table columns match, `ENABLE ROW LEVEL SECURITY`, and a `tenant_isolation`-style policy scoped to `savvy_app` are present (same shape as the Phase 2 `canvass_challenge` migration).

- [ ] **Step 4: Apply locally and confirm it loads**

Run: `cd ~/Sites/savvy-crm && pnpm db:up && pnpm db:migrate`
Expected: migration applies with no error.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/canvass.ts packages/db/drizzle
git commit -m "feat(canvass): add canvass_spiff ledger table + migration"
```

---

### Task 3: DB — spiff lifecycle + settlement hook

**Files:**
- Create: `packages/db/src/lifecycle/canvass-spiff.ts`
- Modify: `packages/db/src/lifecycle/canvass-challenge.ts` (`settleDueChallenges` only)
- Test: `packages/db/tests/canvass-spiff.test.ts`

**Interfaces:**
- Consumes: `Tx` from `../tenant`; `canvassSpiff` from `../schema/index`; `settlementSpiffs` from `@savvy/core`; the Phase 2 `standingsFor` result + `settleWinner` already computed inside `settleDueChallenges`.
- Produces: `createManualSpiff`, `listSpiffs`, `markSpiffPaid`, `createSettlementSpiffs`.

- [ ] **Step 1: Write the lifecycle module**

```ts
// packages/db/src/lifecycle/canvass-spiff.ts
import { and, desc, eq, or } from "drizzle-orm";
import { settlementSpiffs, type SpiffDescriptor, type Standing } from "@savvy/core";
import type { Tx } from "../tenant";
import { canvassSpiff } from "../schema/index";

export interface SpiffRow {
  id: string;
  challengeId: string | null;
  kind: string;
  amountCents: number;
  winnerRepId: string;
  fromRepId: string | null;
  status: string;
  note: string | null;
  createdAt: Date;
  settledAt: Date | null;
}

function toRow(r: typeof canvassSpiff.$inferSelect): SpiffRow {
  return {
    id: r.id, challengeId: r.challengeId, kind: r.kind, amountCents: r.amountCents,
    winnerRepId: r.winnerRepId, fromRepId: r.fromRepId, status: r.status,
    note: r.note, createdAt: r.createdAt, settledAt: r.settledAt,
  };
}

export interface ManualSpiffArgs {
  tenantId: string;
  winnerRepId: string;
  amountCents: number;
  note?: string;
}

// Manager awards a one-off spiff (kind manual, status owed).
export async function createManualSpiff(tx: Tx, a: ManualSpiffArgs): Promise<{ id: string }> {
  const [row] = await tx
    .insert(canvassSpiff)
    .values({
      tenantId: a.tenantId, kind: "manual", amountCents: Math.floor(a.amountCents),
      winnerRepId: a.winnerRepId, fromRepId: null, status: "owed", note: a.note ?? null,
    })
    .returning({ id: canvassSpiff.id });
  return { id: row!.id };
}

// scope "mine": rows where the rep is the winner OR the payer. scope "all": every row.
export async function listSpiffs(tx: Tx, tenantId: string, scope: "mine" | "all", repId?: string): Promise<SpiffRow[]> {
  const rows =
    scope === "mine" && repId
      ? await tx.select().from(canvassSpiff)
          .where(or(eq(canvassSpiff.winnerRepId, repId), eq(canvassSpiff.fromRepId, repId)))
          .orderBy(desc(canvassSpiff.createdAt))
      : await tx.select().from(canvassSpiff).orderBy(desc(canvassSpiff.createdAt));
  return rows.map(toRow);
}

// Flip owed → paid, stamp settled_at. Only affects an owed row (idempotent-ish:
// re-marking a paid row is a no-op). Returns whether a row changed.
export async function markSpiffPaid(tx: Tx, tenantId: string, spiffId: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(canvassSpiff)
    .set({ status: "paid", settledAt: now })
    .where(and(eq(canvassSpiff.id, spiffId), eq(canvassSpiff.status, "owed")))
    .returning({ id: canvassSpiff.id });
  return rows.length > 0;
}

// Called from settleDueChallenges the moment a challenge closes. Writes the
// wager/prize ledger rows derived from the final standings + winner.
export async function createSettlementSpiffs(
  tx: Tx,
  tenantId: string,
  challengeId: string,
  ch: { kind: string; meta: Record<string, unknown> },
  standings: Standing[],
  winnerRepId: string | null,
): Promise<number> {
  const descriptors: SpiffDescriptor[] = settlementSpiffs(ch, standings, winnerRepId);
  if (descriptors.length === 0) return 0;
  await tx.insert(canvassSpiff).values(
    descriptors.map((d) => ({
      tenantId, challengeId, kind: d.kind, amountCents: d.amountCents,
      winnerRepId: d.winnerRepId, fromRepId: d.fromRepId, status: "owed" as const,
    })),
  );
  return descriptors.length;
}
```

- [ ] **Step 2: Hook settlement in `canvass-challenge.ts`**

In `settleDueChallenges`, the loop currently computes `standings`, then stamps `finalScore` per participant, then updates the challenge with `winnerRepId: settleWinner(standings)`. Refactor so the winner is computed once and the settlement spiffs are written in the same iteration. Replace the loop body:

```ts
// at top of file, add:
import { createSettlementSpiffs } from "./canvass-spiff";

// inside settleDueChallenges, for each `ch` in `due`:
    const standings = await standingsFor(tx, tenantId, ch);
    for (const s of standings) {
      await tx
        .update(canvassChallengeParticipant)
        .set({ finalScore: s.score })
        .where(and(eq(canvassChallengeParticipant.challengeId, ch.id), eq(canvassChallengeParticipant.repId, s.repId)));
    }
    const winner = settleWinner(standings);
    await tx
      .update(canvassChallenge)
      .set({ status: "settled", winnerRepId: winner, settledAt: now })
      .where(eq(canvassChallenge.id, ch.id));
    await createSettlementSpiffs(tx, tenantId, ch.id, { kind: ch.kind, meta: ch.meta }, standings, winner);
```

> Confirm `settleWinner` is already imported in `canvass-challenge.ts` (it is, from `@savvy/core`). This change must be behavior-preserving for challenges without a wager/prize — `createSettlementSpiffs` returns 0 and writes nothing in that case.

- [ ] **Step 3: Write the DB-backed test**

```ts
// packages/db/tests/canvass-spiff.test.ts
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { adminDb, adminPool, pool, eq, tenant, canvassRep, canvassChallenge, canvassChallengeParticipant, canvassKnock, canvassSpiff } from "../src/index";
import { withTenant } from "../src/tenant";
import { createChallenge, settleDueChallenges } from "../src/lifecycle/canvass-challenge";
import { createManualSpiff, listSpiffs, markSpiffPaid } from "../src/lifecycle/canvass-spiff";

let tId: string, repA: string, repB: string, repC: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "Spiff Co", publicKey: `sp-${Date.now()}`, clerkOrgId: `org_sp_${Date.now()}` }).returning();
  tId = t!.id;
  const reps = await adminDb.insert(canvassRep).values([
    { tenantId: tId, name: "Rep A", pinHash: "x" },
    { tenantId: tId, name: "Rep B", pinHash: "x" },
    { tenantId: tId, name: "Rep C", pinHash: "x" },
  ]).returning();
  repA = reps[0]!.id; repB = reps[1]!.id; repC = reps[2]!.id;
});

afterAll(async () => {
  await adminDb.delete(canvassSpiff).where(eq(canvassSpiff.tenantId, tId));
  await adminDb.delete(canvassKnock).where(eq(canvassKnock.tenantId, tId));
  await adminDb.delete(canvassChallengeParticipant).where(eq(canvassChallengeParticipant.tenantId, tId));
  await adminDb.delete(canvassChallenge).where(eq(canvassChallenge.tenantId, tId));
  await adminDb.delete(canvassRep).where(eq(canvassRep.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

// window fully in the past so it settles immediately
const past = () => {
  const end = new Date(Date.now() - 3_600_000);
  const start = new Date(end.getTime() - 86_400_000);
  return { start, end, mid: new Date(start.getTime() + 43_200_000) };
};
const knock = (repId: string, outcome: string, at: Date) => ({
  tenantId: tId, repId, clientId: `k-${repId}-${at.getTime()}-${Math.round(at.getTime() % 1000)}`,
  lat: 33.4, lng: -111.8, outcome, gpsFlagged: false, createdAt: at,
});

describe("manual spiff + mark paid", () => {
  it("creates an owed manual spiff and flips it to paid", async () => {
    const { id } = await withTenant(tId, (tx) => createManualSpiff(tx, { tenantId: tId, winnerRepId: repA, amountCents: 5000, note: "Fastest 10 doors" }));
    const owed = await withTenant(tId, (tx) => listSpiffs(tx, tId, "all"));
    expect(owed.find((s) => s.id === id)?.status).toBe("owed");
    const flipped = await withTenant(tId, (tx) => markSpiffPaid(tx, tId, id, new Date()));
    expect(flipped).toBe(true);
    const after = await withTenant(tId, (tx) => listSpiffs(tx, tId, "all"));
    const row = after.find((s) => s.id === id)!;
    expect(row.status).toBe("paid");
    expect(row.settledAt).not.toBeNull();
    // re-marking a paid row is a no-op
    expect(await withTenant(tId, (tx) => markSpiffPaid(tx, tId, id, new Date()))).toBe(false);
  });
});

describe("wager spiff on h2h settlement", () => {
  it("loser owes winner the wager when the challenge settles", async () => {
    const { start, end, mid } = past();
    const { id: chId } = await withTenant(tId, (tx) => createChallenge(tx, {
      tenantId: tId, createdByRepId: repA, kind: "h2h", metric: "doors",
      windowStart: start, windowEnd: end, participantRepIds: [repA, repB], meta: { wagerCents: 2000 },
    }));
    // A gets 2 doors, B gets 1 — inside the window
    await withTenant(tId, async (tx) => {
      await tx.insert(canvassKnock).values([
        knock(repA, "noanswer", mid), knock(repA, "callback", new Date(mid.getTime() + 1000)),
        knock(repB, "noanswer", mid),
      ]);
    });
    const settled = await withTenant(tId, (tx) => settleDueChallenges(tx, tId, new Date()));
    expect(settled).toBeGreaterThanOrEqual(1);
    const spiffs = await withTenant(tId, (tx) => listSpiffs(tx, tId, "all"));
    const wager = spiffs.find((s) => s.challengeId === chId && s.kind === "wager");
    expect(wager).toBeTruthy();
    expect(wager!.amountCents).toBe(2000);
    expect(wager!.winnerRepId).toBe(repA);
    expect(wager!.fromRepId).toBe(repB);
    expect(wager!.status).toBe("owed");
  });
});

describe("contest prize spiff on settlement", () => {
  it("pool goes to the winner, from null", async () => {
    const { start, end, mid } = past();
    const { id: chId } = await withTenant(tId, (tx) => createChallenge(tx, {
      tenantId: tId, createdByRepId: repC, kind: "contest", metric: "doors",
      windowStart: start, windowEnd: end, participantRepIds: [repA, repB, repC], meta: { prizePoolCents: 10000 },
    }));
    await withTenant(tId, async (tx) => {
      await tx.insert(canvassKnock).values([
        knock(repC, "noanswer", mid), knock(repC, "noanswer", new Date(mid.getTime() + 1000)), knock(repC, "noanswer", new Date(mid.getTime() + 2000)),
        knock(repA, "noanswer", mid),
      ]);
    });
    await withTenant(tId, (tx) => settleDueChallenges(tx, tId, new Date()));
    const spiffs = await withTenant(tId, (tx) => listSpiffs(tx, tId, "all"));
    const prize = spiffs.find((s) => s.challengeId === chId && s.kind === "contest_prize");
    expect(prize).toBeTruthy();
    expect(prize!.amountCents).toBe(10000);
    expect(prize!.winnerRepId).toBe(repC);
    expect(prize!.fromRepId).toBeNull();
  });
});

describe("listSpiffs scope=mine", () => {
  it("returns only rows where the rep is winner or payer", async () => {
    const mine = await withTenant(tId, (tx) => listSpiffs(tx, tId, "mine", repB));
    // repB should see the h2h wager (as payer) but not repA's manual spiff
    expect(mine.every((s) => s.winnerRepId === repB || s.fromRepId === repB)).toBe(true);
    expect(mine.some((s) => s.kind === "wager" && s.fromRepId === repB)).toBe(true);
  });
});
```

- [ ] **Step 4: Run the DB tests (clear synthetic debris first)**

```bash
cd ~/Sites/savvy-crm
docker exec savvy_db psql -U postgres -d savvy -c "DELETE FROM job_task WHERE task_id>=9000; DELETE FROM task_registry WHERE id>=9000;" >/dev/null 2>&1
npx vitest run packages/db/tests/canvass-spiff.test.ts --no-file-parallelism
```
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/canvass-spiff.ts packages/db/src/lifecycle/canvass-challenge.ts packages/db/tests/canvass-spiff.test.ts
git commit -m "feat(canvass): spiff lifecycle + wager/prize creation on settlement"
```

---

### Task 4: Web — spiff endpoints + middleware allowlist

**Files:**
- Create: `apps/web/src/app/api/canvass/spiffs/route.ts`
- Create: `apps/web/src/app/api/canvass/spiff/route.ts`
- Create: `apps/web/src/app/api/canvass/spiff/[id]/route.ts`
- Modify: `apps/web/src/middleware.ts`

**Interfaces:**
- Consumes: `verifyCanvassToken`, `bearerToken`, `canvassCors`, `checkRateLimit`, `withTenant`, `isCanvassManager` (from `@savvy/db` lifecycle — same import the Phase 2 `challenge/route.ts` uses), `createManualSpiff`, `listSpiffs`, `markSpiffPaid`. Read `apps/web/src/app/api/canvass/challenge/route.ts` and `challenge/[id]/route.ts` first and mirror their exact structure (imports, `runtime`, `OPTIONS`, reply helper, auth+rate-limit order, `await ctx.params`).
- Produces: three route handlers.

- [ ] **Step 1: `GET /api/canvass/spiffs`**

```ts
// apps/web/src/app/api/canvass/spiffs/route.ts
import { NextResponse } from "next/server";
import { withTenant, listSpiffs, isCanvassManager } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, OPTIONS") });
}

export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass-read", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  const scope = new URL(req.url).searchParams.get("scope") === "all" ? "all" : "mine";

  const spiffs = await withTenant(sess.tenantId, async (tx) => {
    if (scope === "all" && !(await isCanvassManager(tx, sess.tenantId, sess.repId))) return null;
    return listSpiffs(tx, sess.tenantId, scope, sess.repId);
  });
  if (spiffs === null) return reply({ error: "forbidden" }, 403);
  return reply({ scope, spiffs }, 200);
}
```

- [ ] **Step 2: `POST /api/canvass/spiff` (manual, manager-only)**

```ts
// apps/web/src/app/api/canvass/spiff/route.ts
import { NextResponse } from "next/server";
import { withTenant, createManualSpiff, isCanvassManager } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "POST, OPTIONS") });
}

export async function POST(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass-write", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  const body = (await req.json().catch(() => null)) as { winnerRepId?: string; amountCents?: number; note?: string } | null;
  const winnerRepId = body?.winnerRepId;
  const amountCents = Math.floor(Number(body?.amountCents));
  if (!winnerRepId || !Number.isFinite(amountCents) || amountCents <= 0) return reply({ error: "bad_request" }, 400);

  const result = await withTenant(sess.tenantId, async (tx) => {
    if (!(await isCanvassManager(tx, sess.tenantId, sess.repId))) return null;
    return createManualSpiff(tx, { tenantId: sess.tenantId, winnerRepId, amountCents, note: body?.note });
  });
  if (result === null) return reply({ error: "forbidden" }, 403);
  return reply(result, 201);
}
```

- [ ] **Step 3: `POST /api/canvass/spiff/:id?action=paid` (manager-only)**

```ts
// apps/web/src/app/api/canvass/spiff/[id]/route.ts
import { NextResponse } from "next/server";
import { withTenant, markSpiffPaid, isCanvassManager } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "POST, OPTIONS") });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const headers = canvassCors(req, "POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass-write", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  const { id } = await ctx.params;
  const action = new URL(req.url).searchParams.get("action");
  if (action !== "paid") return reply({ error: "bad_action" }, 400);

  const changed = await withTenant(sess.tenantId, async (tx) => {
    if (!(await isCanvassManager(tx, sess.tenantId, sess.repId))) return null;
    return markSpiffPaid(tx, sess.tenantId, id, new Date());
  });
  if (changed === null) return reply({ error: "forbidden" }, 403);
  return reply({ ok: changed }, 200);
}
```

- [ ] **Step 4: Extend the middleware allowlist**

In `apps/web/src/middleware.ts`, the canvass public-route allowlist ends with a regex like `…|scoreboard|challenge|challenges)$/` plus a separate entry `/^\/api\/canvass\/challenge\/[^/]+$/`. Add `spiffs`, `spiff`, and the `/spiff/:id` pattern:
- Add `spiffs` and `spiff` to the alternation in the main canvass regex (so it reads `…|challenge|challenges|spiffs|spiff)$/`).
- Add a new array element mirroring the challenge one: `/^\/api\/canvass\/spiff\/[^/]+$/,`.

> Read the exact current form before editing — match it precisely so no existing route is dropped.

- [ ] **Step 5: Typecheck + lint**

Run: `cd ~/Sites/savvy-crm && pnpm typecheck 2>&1 | tail -3 && pnpm lint 2>&1 | tail -3`
Expected: clean (the pre-existing `@savvy/integrations` vapi.ts error, if any, is ignored per spec).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/api/canvass/spiffs apps/web/src/app/api/canvass/spiff apps/web/src/middleware.ts
git commit -m "feat(canvass): spiff endpoints (list/create/mark-paid) + middleware allowlist"
```

---

### Task 5: Field app — Spiffs screen + wager input

**Files:**
- Modify: `~/Sites/savvy-canvass/index.html`
- Modify: `~/Sites/savvy-canvass/sw.js`

**Interfaces:**
- Consumes: existing helpers in `index.html` — `canvassBase`, `authHeaders()`, `esc()`, `flash()`, `user(repId)`, `cur` (current rep id), `db.users`, `isManager` (or the existing manager check used to gate the contest UI; read how `#view-compete` decides manager-only), `renderCompete()`, `METRIC_LABELS`, `window.challengeAct`, the challenge-create onclick.
- Produces: `renderSpiffs()`, `window.spiffPaid`, a Spiffs card, and a wager prompt on challenge creation.

- [ ] **Step 1: Read the current Compete view**

Open `~/Sites/savvy-canvass/index.html` and locate: the `#view-compete` markup (Leaderboard card + the Phase 2 Challenges card `#compChallenges` / `#compNewChallenge`), `renderCompete()`, the manager gate, and the `#compNewChallenge` onclick handler. Note the exact dollar/cents display convention if one exists elsewhere (sales markers show `$`).

- [ ] **Step 2: Add the Spiffs card markup**

Inside `#view-compete`, after the Challenges card, add a manager-gated card:

```html
<div id="compSpiffsCard" class="card" style="display:none">
  <div class="card-h">
    <span>Spiffs</span>
    <button id="compNewSpiff" class="btn-sm">+ Award</button>
  </div>
  <div id="compSpiffs" class="list"></div>
</div>
```

- [ ] **Step 3: Add `renderSpiffs()` and wire it**

Add near `renderChallenges()`:

```js
async function renderSpiffs() {
  const card = document.getElementById('compSpiffsCard');
  if (!card) return;
  if (!isManager) { card.style.display = 'none'; return; }
  card.style.display = '';
  const box = document.getElementById('compSpiffs');
  try {
    const r = await fetch(canvassBase + '/api/canvass/spiffs?scope=all', { headers: authHeaders() });
    const { spiffs = [] } = await r.json();
    if (!spiffs.length) { box.innerHTML = '<div class="muted">No spiffs yet.</div>'; return; }
    box.innerHTML = spiffs.map(s => {
      const amt = '$' + (s.amountCents / 100).toFixed(2);
      const who = esc(user(s.winnerRepId).name);
      const from = s.fromRepId ? ' (from ' + esc(user(s.fromRepId).name) + ')' : '';
      const paid = s.status === 'paid';
      const btn = paid
        ? '<span class="chip chip-ok">Paid</span>'
        : '<button class="btn-sm" onclick="spiffPaid(\'' + s.id + '\')">Mark paid</button>';
      return '<div class="row"><div><b>' + amt + '</b> → ' + who + from +
        '<div class="muted sm">' + esc(s.kind) + (s.note ? ' · ' + esc(s.note) : '') + '</div></div>' + btn + '</div>';
    }).join('');
  } catch { box.innerHTML = '<div class="muted">Could not load spiffs.</div>'; }
}

window.spiffPaid = async function (id) {
  try {
    await fetch(canvassBase + '/api/canvass/spiff/' + id + '?action=paid', { method: 'POST', headers: authHeaders() });
    flash('Marked paid');
    renderSpiffs();
  } catch { flash('Could not mark paid'); }
};
```

Then at the end of `renderCompete()`, add a call: `renderSpiffs();` (right after the existing `renderChallenges();`).

- [ ] **Step 4: Wire the "+ Award" button (manual spiff)**

Add an onclick binding near where `#compNewChallenge` is wired:

```js
document.getElementById('compNewSpiff')?.addEventListener('click', async () => {
  const others = db.users.filter(u => u.id !== cur);
  const name = prompt('Award spiff to which teammate?\n' + others.map((u, i) => (i + 1) + '. ' + u.name).join('\n'));
  const pick = others[Number(name) - 1];
  if (!pick) return;
  const dollars = Number(prompt('Amount in dollars?'));
  if (!Number.isFinite(dollars) || dollars <= 0) return;
  const note = prompt('Note (optional)?') || undefined;
  try {
    await fetch(canvassBase + '/api/canvass/spiff', {
      method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ winnerRepId: pick.id, amountCents: Math.round(dollars * 100), note }),
    });
    flash('Spiff awarded to ' + pick.name);
    renderSpiffs();
  } catch { flash('Could not award spiff'); }
});
```

- [ ] **Step 5: Add an optional wager to challenge creation**

In the existing `#compNewChallenge` handler, after the metric is chosen and before the POST, prompt for an optional wager and include it in `meta`:

```js
  const wager = Number(prompt('Optional wager in dollars? (blank/0 = none)')) || 0;
  // …existing POST body, add: meta: wager > 0 ? { wagerCents: Math.round(wager * 100) } : undefined
```

Wire `meta` into the challenge POST body (the challenge route already passes `meta` through to `createChallenge`).

> Verify the Phase 2 `POST /api/canvass/challenge` route reads `meta` from the body and forwards it to `createChallenge`. If it does NOT (Phase 2 shipped h2h create without meta), add `meta` passthrough to that route as part of this task and note it in the report — it is required for wagers to reach the DB.

- [ ] **Step 6: Version bumps**

- In `index.html`: `APP_VERSION` → `'1.15.0-beta'`.
- In `sw.js`: `const V = 'canvass-v1.15.0';`.

- [ ] **Step 7: Parse-check the JS**

Run a quick validity check over the inline `<script>` blocks (same technique the Phase 2 implementer used — extract each script body and `new Function(body)` it in Node) to confirm no syntax errors.

- [ ] **Step 8: Commit + deploy**

```bash
cd ~/Sites/savvy-canvass
git add index.html sw.js
git commit -m "feat(canvass): Spiffs screen + optional wager on challenges (v1.15.0-beta)"
npx wrangler pages deploy . --project-name savvy-canvass --commit-dirty=true
```

> Confirm the deploy command matches how Phase 1/2 deployed the field app (check `~/Sites/savvy-canvass` git log / README for the exact `wrangler pages deploy` invocation and project name). Use that exact command.

---

## Post-execution (controller, after all tasks pass review)

1. Full suite green: clear synthetic debris, then `pnpm typecheck && pnpm lint && npx vitest run --no-file-parallelism`.
2. Final whole-branch review (most capable model) over `merge-base(main,HEAD)..HEAD`.
3. Merge to main.
4. Apply the `canvass_spiff` migration to prod Supabase via MCP `apply_migration` (project ref `ngczjltbcuvrjosxgqrm`; local drizzle number is one behind the prod migration number).
5. Deploy backend: `npx vercel --prod --archive=tgz --force --scope advosy`.
6. Verify `GET /api/canvass/spiffs` returns 401 unauthenticated.
7. Confirm the field app Spiffs screen loads for a manager on the deployed PWA (reload twice for the new SW).

## Non-goals (YAGNI)

- No real payment processing — mark-paid is a ledger flip only.
- No split/tiered prize distribution — v1 gives the whole contest pool to the single winner.
- No spiff editing/void UI in the field app v1 (the `void` status exists in the model for future use; not surfaced).
- No per-rep running-total analytics beyond the flat ledger list.
