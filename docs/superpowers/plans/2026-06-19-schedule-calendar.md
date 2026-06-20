# Schedule Calendar + Filters (Slice A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/schedule` agenda list with a Week/Month/Crew calendar with four filters (crew, appointment type, job type, city), over existing appointments, with a click-to-act popover — read + existing actions only.

**Architecture:** All date math, view-model building, and address parsing are PURE functions in `@savvy/core` (unit-tested, timezone-aware via `Intl`). `apps/web` is the thin rendering layer (Playwright-only). A new nullable `property.city` column (auto-parsed from address) backs the city filter. No calendar library — hand-built grids fed by the core engine.

**Tech Stack:** Next.js 16 (App Router, Turbopack), React, Drizzle/Postgres (RLS), Tailwind v4 + espresso/gold tokens, vitest (core), Playwright (web).

---

## Conventions for every task

- **Repo root:** `~/Sites/savvy-crm`. **Branch:** `feat/schedule-calendar` (checked out, off `origin/main`).
- **Gate** (from repo root before each code commit):
  ```bash
  export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
  pnpm typecheck && pnpm lint
  ```
  Add `&& pnpm test` for tasks that touch `@savvy/core` (it has vitest). Expect typecheck 7/7, lint 0. (If a stale `.next` error appears in `@savvy/web`, `rm -rf apps/web/.next` and re-run.)
- **Single-instance imports:** in `apps/web`/`packages/*`, import `z` from `@savvy/core`, drizzle operators (`eq`, `and`, `isNull`, `sql`…) from `@savvy/db` — never from `zod`/`drizzle-orm` directly.
- **No `.js` extension** on relative imports in SOURCE files; `*.test.ts` in `@savvy/core` DO use `.js` (match sibling tests like `crew-pin.test.ts`).
- **apps/web is Playwright-only** — never add vitest there. All unit-tested logic goes in `@savvy/core`.
- **Tokens, not hex** — use `var(--...)` and existing utility classes.
- **Route-group parens:** files under `app/(app)/...` — quote paths in `git add` or use `git add -A`; check `git status` for stray `\(app\)` dirs after.

## File Structure

**New (`@savvy/core`):**
- `packages/core/src/address.ts` + `address.test.ts` — `parseCityFromAddress`.
- `packages/core/src/schedule-view.ts` + `schedule-view.test.ts` — the pure calendar engine + `ScheduleAppt` type.

**New (`@savvy/db`):**
- `packages/db/src/scripts/backfill-city.ts` — one-time city backfill.
- `packages/db/drizzle/0014_*.sql` (+ `meta/` journal) — generated migration.

**New (`apps/web`):**
- `apps/web/src/app/(app)/schedule/WeekGrid.tsx`, `MonthGrid.tsx`, `CrewBoard.tsx`, `AppointmentPopover.tsx`.
- `apps/web/tests/e2e/schedule.spec.ts`.

**Modified:**
- `packages/db/src/schema/crm.ts` (add `city`), `packages/core/src/index.ts` (exports).
- `apps/web/src/lib/intake.ts` (set city on create), `apps/web/src/lib/scheduling-queries.ts` (filters + options + tz).
- `apps/web/src/app/(app)/schedule/page.tsx`, `ScheduleClient.tsx` (rewrite to the calendar).

---

## Task 1: `parseCityFromAddress` (`@savvy/core`)

**Files:** Create `packages/core/src/address.ts` + `packages/core/src/address.test.ts`; modify `packages/core/src/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/address.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCityFromAddress } from "./address.js";

describe("parseCityFromAddress", () => {
  it("extracts the city before STATE ZIP", () => {
    expect(parseCityFromAddress("123 Main St, Mesa AZ 85201")).toBe("Mesa");
  });
  it("handles a comma between city and state", () => {
    expect(parseCityFromAddress("45 Oak Ave, Phoenix, AZ 85003")).toBe("Phoenix");
  });
  it("handles a multi-word city", () => {
    expect(parseCityFromAddress("9 Hill Rd, San Tan Valley AZ 85140")).toBe("San Tan Valley");
  });
  it("trims whitespace", () => {
    expect(parseCityFromAddress("1 A St,  Tempe  AZ 85281")).toBe("Tempe");
  });
  it("returns null when there is no comma", () => {
    expect(parseCityFromAddress("unknown")).toBeNull();
  });
  it("returns null for an empty string", () => {
    expect(parseCityFromAddress("")).toBeNull();
  });
  it("returns null when the segment has no state/zip tail", () => {
    expect(parseCityFromAddress("123 Main St, Apt 4")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it (fails — module missing)**

Run: `pnpm --filter @savvy/core test address`
Expected: FAIL (cannot find `./address.js`).

- [ ] **Step 3: Implement**

Create `packages/core/src/address.ts`:

```ts
/**
 * Best-effort city extraction from a free-text US address. Heuristic, NOT a geocoder.
 * Looks for the comma-segment that ends in "<STATE> <ZIP>" and returns the text before
 * the state token. Returns null when no city can be confidently identified.
 *
 *   "123 Main St, Mesa AZ 85201"        -> "Mesa"
 *   "45 Oak Ave, Phoenix, AZ 85003"     -> "Phoenix"
 *   "9 Hill Rd, San Tan Valley AZ 85140"-> "San Tan Valley"
 *   "unknown" / "123 Main St, Apt 4"    -> null
 */
export function parseCityFromAddress(address: string): string | null {
  if (!address) return null;
  const segments = address.split(",").map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) return null;
  // Walk segments right-to-left; find one that ends in "<2-letter STATE> <5-digit ZIP>".
  const stateZip = /\b[A-Za-z]{2}\s+\d{5}(?:-\d{4})?$/;
  for (let i = segments.length - 1; i >= 1; i--) {
    const seg = segments[i]!;
    if (stateZip.test(seg)) {
      const cityPart = seg.replace(stateZip, "").trim();
      if (cityPart) return cityPart.replace(/\s+/g, " "); // "Mesa AZ 85201" -> "Mesa"
      // City was its own segment just before the state/zip segment (comma style).
      const prev = segments[i - 1]?.trim();
      return prev ? prev.replace(/\s+/g, " ") : null;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run it (passes)**

Run: `pnpm --filter @savvy/core test address`
Expected: PASS (7 tests).

- [ ] **Step 5: Export + commit**

Add to `packages/core/src/index.ts`: `export * from "./address";`
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm --filter @savvy/core test
git add packages/core/src/address.ts packages/core/src/address.test.ts packages/core/src/index.ts
git commit -m "feat(core): parseCityFromAddress heuristic"
```

---

## Task 2: `property.city` column + populate at intake

**Files:** Modify `packages/db/src/schema/crm.ts`, `apps/web/src/lib/intake.ts`; generate `packages/db/drizzle/0014_*.sql`.

- [ ] **Step 1: Add the column to the schema**

In `packages/db/src/schema/crm.ts`, in the `property` table definition, add a `city` column after `address`:
```ts
  address: text("address").notNull(),
  city: text("city"),
```

- [ ] **Step 2: Generate the migration**

Run from repo root:
```bash
pnpm --filter @savvy/db db:generate
```
Expected: creates `packages/db/drizzle/0014_<name>.sql` containing `ALTER TABLE "property" ADD COLUMN "city" text;` and updates `packages/db/drizzle/meta/_journal.json` + a new `meta/0014_snapshot.json`. Open the `.sql` to confirm it's only the ADD COLUMN (no destructive ops).

- [ ] **Step 3: Apply it locally**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm --filter @savvy/db db:migrate
```
Expected: "migrations + grants applied". Verify: `docker exec savvy_db psql -U postgres -d savvy -c "\d property" | grep city` shows the column.

- [ ] **Step 4: Populate `city` on property creation**

In `apps/web/src/lib/intake.ts`, add `parseCityFromAddress` to the `@savvy/core` import, and at the `insert(property)` call (~line 22) set `city`:
```ts
const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: input.address, city: parseCityFromAddress(input.address) }).returning();
```

- [ ] **Step 5: Gate + commit**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint
git add packages/db/src/schema/crm.ts packages/db/drizzle apps/web/src/lib/intake.ts
git commit -m "feat(db): property.city column, parsed at intake (migration 0014)"
```
Confirm `git status` shows the new `.sql` AND the `meta/` journal changes are committed (the migrator reads `_journal.json`).

---

## Task 3: Backfill `city` for existing properties

**Files:** Create `packages/db/src/scripts/backfill-city.ts`.

- [ ] **Step 1: Write the backfill script**

Create `packages/db/src/scripts/backfill-city.ts`:

```ts
import { adminDb, property, eq, isNull, and } from "../index";
import { parseCityFromAddress } from "@savvy/core";

/** One-time: fill property.city for rows where it's null, parsing the address. Idempotent. */
async function main() {
  const rows = await adminDb.select({ id: property.id, address: property.address }).from(property).where(isNull(property.city));
  let updated = 0;
  for (const r of rows) {
    const city = parseCityFromAddress(r.address);
    if (city) {
      await adminDb.update(property).set({ city }).where(and(eq(property.id, r.id), isNull(property.city)));
      updated++;
    }
  }
  console.log(`backfill-city: scanned ${rows.length}, set ${updated}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```
(Verify `adminDb`, `property`, `eq`, `isNull`, `and` are all exported from `packages/db/src/index.ts`; they are used elsewhere. If `property.city` isn't yet recognized by types, you skipped Task 2 — do it first.)

- [ ] **Step 2: Run it**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm --filter @savvy/db exec tsx src/scripts/backfill-city.ts
```
Expected: prints `backfill-city: scanned N, set M`. (Seed addresses may lack ZIPs → M can be 0; that's fine — the column + parser are what matter. You can manually set a couple of cities for local testing: `docker exec savvy_db psql -U postgres -d savvy -c "UPDATE property SET city='Mesa' WHERE city IS NULL;"`.)

- [ ] **Step 3: Commit**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint
git add packages/db/src/scripts/backfill-city.ts
git commit -m "chore(db): one-time city backfill script"
```

---

## Task 4: Calendar engine part 1 — types, tz helpers, nav, week view (`@savvy/core`)

**Files:** Create `packages/core/src/schedule-view.ts` + `packages/core/src/schedule-view.test.ts`; modify `packages/core/src/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/schedule-view.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toCivilDate, addDays, addWeeks, addMonths, weekDays, buildWeekView, type ScheduleAppt } from "./schedule-view.js";

const TZ = "America/Phoenix"; // UTC-7, no DST

function appt(p: Partial<ScheduleAppt> & { id: string; startsAt: string; endsAt: string }): ScheduleAppt {
  return { type: "inspection", status: "scheduled", assigneeUserId: null, assigneeName: null, customerName: "C", address: "A", jobId: "j", jobType: "retail", city: "Mesa", ...p };
}

describe("toCivilDate", () => {
  it("converts a UTC instant to the civil date in the tz", () => {
    // 2026-06-19T03:00:00Z is 2026-06-18 20:00 in Phoenix (UTC-7)
    expect(toCivilDate("2026-06-19T03:00:00Z", TZ)).toBe("2026-06-18");
  });
});

describe("civil date nav", () => {
  it("addDays crosses month boundary", () => expect(addDays("2026-06-30", 1)).toBe("2026-07-01"));
  it("addWeeks", () => expect(addWeeks("2026-06-19", 1)).toBe("2026-06-26"));
  it("addMonths normalizes", () => expect(addMonths("2026-01-31", 1)).toBe("2026-03-03"));
});

describe("weekDays", () => {
  it("returns 7 Sunday-start dates for any anchor in the week", () => {
    // 2026-06-19 is a Friday; its Sunday-start week begins 2026-06-14
    expect(weekDays("2026-06-19")).toEqual([
      "2026-06-14","2026-06-15","2026-06-16","2026-06-17","2026-06-18","2026-06-19","2026-06-20",
    ]);
  });
});

describe("buildWeekView", () => {
  it("buckets an appt to its civil day and positions it within 6a-8p", () => {
    // 2026-06-17T16:00Z = 09:00 Phoenix (3h after 6a) of 7-day window; duration 1h
    const v = buildWeekView([appt({ id: "x", startsAt: "2026-06-17T16:00:00Z", endsAt: "2026-06-17T17:00:00Z" })], "2026-06-19", TZ);
    const wed = v.days.find((d) => d.date === "2026-06-17")!;
    expect(wed.blocks).toHaveLength(1);
    const b = wed.blocks[0]!;
    // 9:00 -> (540-360)/840 = 21.43%; 1h -> 60/840 = 7.14%
    expect(b.topPct).toBeCloseTo(21.4, 0);
    expect(b.heightPct).toBeCloseTo(7.1, 0);
    expect(b.tone).toBeTruthy();
  });
  it("clamps an appt that starts before 6am to the top", () => {
    const v = buildWeekView([appt({ id: "y", startsAt: "2026-06-17T11:00:00Z", endsAt: "2026-06-17T14:00:00Z" })], "2026-06-19", TZ);
    // 04:00 Phoenix start -> clamped to 6a -> topPct 0
    expect(v.days.find((d) => d.date === "2026-06-17")!.blocks[0]!.topPct).toBe(0);
  });
  it("splits two overlapping appts into lanes", () => {
    const v = buildWeekView([
      appt({ id: "a", startsAt: "2026-06-17T16:00:00Z", endsAt: "2026-06-17T18:00:00Z" }),
      appt({ id: "b", startsAt: "2026-06-17T17:00:00Z", endsAt: "2026-06-17T19:00:00Z" }),
    ], "2026-06-19", TZ);
    const blocks = v.days.find((d) => d.date === "2026-06-17")!.blocks;
    expect(blocks).toHaveLength(2);
    expect(Math.max(...blocks.map((b) => b.lanes))).toBe(2);
    expect(new Set(blocks.map((b) => b.lane)).size).toBe(2);
  });
});
```

- [ ] **Step 2: Run it (fails)**

Run: `pnpm --filter @savvy/core test schedule-view`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement part 1**

Create `packages/core/src/schedule-view.ts`:

```ts
export type ScheduleAppt = {
  id: string;
  type: string | null;
  status: string | null;
  startsAt: string; // ISO
  endsAt: string;   // ISO
  assigneeUserId: string | null;
  assigneeName: string | null;
  customerName: string | null;
  address: string | null;
  jobId: string | null;
  jobType: string | null;
  city: string | null;
};

const DAY_START_MIN = 6 * 60;   // 06:00
const DAY_END_MIN = 20 * 60;    // 20:00
const SPAN_MIN = DAY_END_MIN - DAY_START_MIN; // 840

// ---- timezone-aware instant -> wall-clock ---------------------------------
function partsInTz(iso: string, tz: string): { y: number; mo: number; d: number; minutes: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(iso))) if (p.type !== "literal") map[p.type] = Number(p.value);
  const hour = map.hour === 24 ? 0 : map.hour!; // en-US can render midnight as 24
  return { y: map.year!, mo: map.month!, d: map.day!, minutes: hour * 60 + map.minute! };
}

/** Civil date (YYYY-MM-DD) of a UTC instant in the given tz. */
export function toCivilDate(iso: string, tz: string): string {
  const { y, mo, d } = partsInTz(iso, tz);
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function minutesInTz(iso: string, tz: string): number {
  return partsInTz(iso, tz).minutes;
}

// ---- civil-date arithmetic (tz-independent) -------------------------------
function toNoonUTC(civil: string): Date {
  const [y, m, d] = civil.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12));
}
function fromUTC(dt: Date): string {
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}
export function addDays(civil: string, n: number): string {
  const dt = toNoonUTC(civil); dt.setUTCDate(dt.getUTCDate() + n); return fromUTC(dt);
}
export function addWeeks(civil: string, n: number): string { return addDays(civil, n * 7); }
export function addMonths(civil: string, n: number): string {
  const [y, m, d] = civil.split("-").map(Number);
  return fromUTC(new Date(Date.UTC(y!, m! - 1 + n, d!, 12)));
}
function weekday(civil: string): number { return toNoonUTC(civil).getUTCDay(); } // 0=Sun

/** Seven Sunday-start civil dates covering the week that contains `anchor`. */
export function weekDays(anchor: string): string[] {
  const start = addDays(anchor, -weekday(anchor));
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

// ---- tone -----------------------------------------------------------------
export function appointmentTypeTone(type: string | null): string {
  switch (type) {
    case "inspection": return "var(--agent-scout)";
    case "cm": return "var(--agent-vera)";
    case "crew": return "var(--agent-milo)";
    default: return "var(--text-faint)";
  }
}

// ---- week view ------------------------------------------------------------
export type PositionedAppt = ScheduleAppt & { topPct: number; heightPct: number; tone: string; lane: number; lanes: number };
export type WeekDay = { date: string; weekday: string; blocks: PositionedAppt[] };
export type WeekView = { days: WeekDay[]; hourLabels: string[] };

function position(startMin: number, endMin: number): { topPct: number; heightPct: number } {
  const s = Math.max(DAY_START_MIN, Math.min(startMin, DAY_END_MIN));
  const e = Math.max(s, Math.min(endMin, DAY_END_MIN));
  return { topPct: ((s - DAY_START_MIN) / SPAN_MIN) * 100, heightPct: Math.max(2, ((e - s) / SPAN_MIN) * 100) };
}

// Greedy lane assignment for overlapping intervals within one day.
function assignLanes(items: { startMin: number; endMin: number }[]): { lane: number; lanes: number }[] {
  const order = items.map((it, i) => ({ ...it, i })).sort((a, b) => a.startMin - b.startMin);
  const laneEnds: number[] = [];
  const lane = new Array(items.length).fill(0);
  for (const it of order) {
    let placed = -1;
    for (let l = 0; l < laneEnds.length; l++) if (laneEnds[l]! <= it.startMin) { placed = l; break; }
    if (placed === -1) { placed = laneEnds.length; laneEnds.push(it.endMin); } else laneEnds[placed] = it.endMin;
    lane[it.i] = placed;
  }
  const lanes = Math.max(1, laneEnds.length);
  return lane.map((l) => ({ lane: l, lanes }));
}

const WEEKDAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function buildWeekView(appts: ScheduleAppt[], anchor: string, tz: string): WeekView {
  const dates = weekDays(anchor);
  const hourLabels = Array.from({ length: (DAY_END_MIN - DAY_START_MIN) / 60 + 1 }, (_, i) => {
    const h = DAY_START_MIN / 60 + i; const ampm = h < 12 ? "a" : "p"; const hr = h % 12 === 0 ? 12 : h % 12;
    return `${hr}${ampm}`;
  });
  const days: WeekDay[] = dates.map((date) => {
    const dayAppts = appts.filter((a) => toCivilDate(a.startsAt, tz) === date);
    const mins = dayAppts.map((a) => ({ startMin: minutesInTz(a.startsAt, tz), endMin: minutesInTz(a.endsAt, tz) }));
    const lanes = assignLanes(mins);
    const blocks: PositionedAppt[] = dayAppts.map((a, i) => ({
      ...a, ...position(mins[i]!.startMin, mins[i]!.endMin), tone: appointmentTypeTone(a.type), ...lanes[i]!,
    }));
    return { date, weekday: WEEKDAY_LABEL[weekday(date)]!, blocks };
  });
  return { days, hourLabels };
}
```

- [ ] **Step 4: Run it (passes)**

Run: `pnpm --filter @savvy/core test schedule-view`
Expected: PASS (all part-1 tests).

- [ ] **Step 5: Export + commit**

Add to `packages/core/src/index.ts`: `export * from "./schedule-view";`
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm --filter @savvy/core test
git add packages/core/src/schedule-view.ts packages/core/src/schedule-view.test.ts packages/core/src/index.ts
git commit -m "feat(core): schedule engine part 1 — tz helpers, nav, week view"
```

---

## Task 5: Calendar engine part 2 — month + crew views (`@savvy/core`)

**Files:** Modify `packages/core/src/schedule-view.ts` + `packages/core/src/schedule-view.test.ts`.

- [ ] **Step 1: Add failing tests**

Append to `packages/core/src/schedule-view.test.ts`:

```ts
import { buildMonthView, buildCrewView } from "./schedule-view.js";

describe("buildMonthView", () => {
  it("returns a 6x7 grid covering the anchor month with outside-month flags", () => {
    const v = buildMonthView([], "2026-06-15", TZ);
    expect(v.weeks).toHaveLength(6);
    expect(v.weeks[0]).toHaveLength(7);
    const firstOfJune = v.weeks.flat().find((c) => c.date === "2026-06-01")!;
    expect(firstOfJune.outside).toBe(false);
    // 2026-06-01 is a Monday, so the grid's first cell (Sunday) is 2026-05-31 (outside)
    expect(v.weeks[0]![0]!.date).toBe("2026-05-31");
    expect(v.weeks[0]![0]!.outside).toBe(true);
  });
  it("places an appointment chip on its civil day", () => {
    const a = appt({ id: "m", startsAt: "2026-06-17T16:00:00Z", endsAt: "2026-06-17T17:00:00Z" });
    const v = buildMonthView([a], "2026-06-15", TZ);
    expect(v.weeks.flat().find((c) => c.date === "2026-06-17")!.chips.map((x) => x.id)).toContain("m");
  });
});

describe("buildCrewView", () => {
  it("groups the week's appts into one column per crew member + Unassigned", () => {
    const crew = [{ id: "u1", name: "Mike" }, { id: "u2", name: "Sara" }];
    const v = buildCrewView([
      appt({ id: "p", assigneeUserId: "u1", startsAt: "2026-06-17T16:00:00Z", endsAt: "2026-06-17T17:00:00Z" }),
      appt({ id: "q", assigneeUserId: null, startsAt: "2026-06-18T16:00:00Z", endsAt: "2026-06-18T17:00:00Z" }),
    ], "2026-06-19", TZ, crew);
    const mike = v.columns.find((c) => c.userId === "u1")!;
    expect(mike.appts.map((a) => a.id)).toContain("p");
    const unassigned = v.columns.find((c) => c.userId === null)!;
    expect(unassigned.appts.map((a) => a.id)).toContain("q");
  });
});
```

- [ ] **Step 2: Run (fails)** — `pnpm --filter @savvy/core test schedule-view` → FAIL (`buildMonthView`/`buildCrewView` missing).

- [ ] **Step 3: Implement part 2**

Append to `packages/core/src/schedule-view.ts`:

```ts
// ---- month view -----------------------------------------------------------
export type MonthChip = ScheduleAppt & { tone: string };
export type MonthCell = { date: string; day: number; outside: boolean; chips: MonthChip[] };
export type MonthView = { weeks: MonthCell[][] };

export function buildMonthView(appts: ScheduleAppt[], anchor: string, tz: string): MonthView {
  const [y, m] = anchor.split("-").map(Number);
  const firstOfMonth = `${y}-${String(m).padStart(2, "0")}-01`;
  const gridStart = addDays(firstOfMonth, -weekday(firstOfMonth)); // back up to Sunday
  const byDate = new Map<string, MonthChip[]>();
  for (const a of appts) {
    const d = toCivilDate(a.startsAt, tz);
    (byDate.get(d) ?? byDate.set(d, []).get(d)!).push({ ...a, tone: appointmentTypeTone(a.type) });
  }
  const weeks: MonthCell[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: MonthCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(gridStart, w * 7 + d);
      row.push({ date, day: Number(date.slice(8)), outside: Number(date.slice(5, 7)) !== m, chips: byDate.get(date) ?? [] });
    }
    weeks.push(row);
  }
  return { weeks };
}

// ---- crew view ------------------------------------------------------------
export type CrewColumn = { userId: string | null; name: string; days: { date: string; weekday: string; appts: ScheduleAppt[] }[]; appts: ScheduleAppt[] };
export type CrewView = { dates: string[]; columns: CrewColumn[] };

export function buildCrewView(appts: ScheduleAppt[], anchor: string, tz: string, crew: { id: string; name: string }[]): CrewView {
  const dates = weekDays(anchor);
  const inWeek = appts.filter((a) => dates.includes(toCivilDate(a.startsAt, tz)));
  const mkColumn = (userId: string | null, name: string): CrewColumn => {
    const mine = inWeek.filter((a) => a.assigneeUserId === userId);
    return {
      userId, name,
      days: dates.map((date) => ({ date, weekday: WEEKDAY_LABEL[weekday(date)]!, appts: mine.filter((a) => toCivilDate(a.startsAt, tz) === date) })),
      appts: mine,
    };
  };
  const columns = crew.map((c) => mkColumn(c.id, c.name));
  if (inWeek.some((a) => a.assigneeUserId === null)) columns.push(mkColumn(null, "Unassigned"));
  return { dates, columns };
}
```

- [ ] **Step 4: Run (passes)** — `pnpm --filter @savvy/core test schedule-view` → PASS (all tests).

- [ ] **Step 5: Commit**
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm --filter @savvy/core test
git add packages/core/src/schedule-view.ts packages/core/src/schedule-view.test.ts
git commit -m "feat(core): schedule engine part 2 — month + crew views"
```

---

## Task 6: Queries — filters, options, timezone (`scheduling-queries.ts`)

**Files:** Modify `apps/web/src/lib/scheduling-queries.ts`.

- [ ] **Step 1: Rewrite `listAppointments` + add helpers**

Read the current file first. Replace `listAppointments` and add the two helpers. Match the existing tenant-scoping (`getTenantId` + `withTenant`). The new content:

```ts
import {
  withTenant, adminDb, tenant, appointment, job, property, customer, user, eq, and, desc, isNull,
} from "@savvy/db";
import { parseFinanceConfig } from "@savvy/core";
import { getTenantId } from "./tenant";

export type ScheduleFilter = { assigneeUserId?: string; type?: string; jobType?: string; city?: string };

export async function listAppointments(filter?: ScheduleFilter) {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) => {
    const wheres = [
      eq(appointment.tenantId, tenantId),
      ...(filter?.assigneeUserId ? [eq(appointment.assigneeUserId, filter.assigneeUserId)] : []),
      ...(filter?.type ? [eq(appointment.type, filter.type as "inspection" | "cm" | "crew")] : []),
      ...(filter?.jobType ? [eq(job.type, filter.jobType as "retail" | "insurance" | "repair" | "commercial")] : []),
      ...(filter?.city === "__unknown__" ? [isNull(property.city)] : filter?.city ? [eq(property.city, filter.city)] : []),
    ];
    return tx.select({
      id: appointment.id,
      type: appointment.type,
      status: appointment.status,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      assigneeUserId: appointment.assigneeUserId,
      assigneeName: user.name,
      customerName: customer.name,
      address: property.address,
      city: property.city,
      jobId: appointment.jobId,
      jobType: job.type,
    })
      .from(appointment)
      .leftJoin(customer, eq(appointment.customerId, customer.id))
      .leftJoin(job, eq(appointment.jobId, job.id))
      .leftJoin(property, eq(job.propertyId, property.id))
      .leftJoin(user, eq(appointment.assigneeUserId, user.id))
      .where(and(...wheres))
      .orderBy(desc(appointment.startsAt));
  });
}

export async function listUsers() {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx.select({ id: user.id, name: user.name }).from(user).where(isNull(user.deactivatedAt)),
  );
}

/** Distinct non-null cities for the filter dropdown, plus whether any property has a null city. */
export async function getScheduleCities(): Promise<{ cities: string[]; hasUnknown: boolean }> {
  const tenantId = await getTenantId();
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.selectDistinct({ city: property.city }).from(property).where(eq(property.tenantId, tenantId));
    const cities = rows.map((r) => r.city).filter((c): c is string => !!c).sort();
    return { cities, hasUnknown: rows.some((r) => !r.city) };
  });
}

/** Tenant scheduling timezone (finance.timezone; default America/Phoenix). tenant.settings has no RLS → adminDb. */
export async function getTenantTimezone(): Promise<string> {
  const tenantId = await getTenantId();
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const settings = (t?.settings ?? {}) as { finance?: unknown };
  return parseFinanceConfig(settings.finance).timezone;
}
```

IMPORTANT: confirm `adminDb` and `tenant` are exported from `@savvy/db` (they are — used in `change-order-actions.ts`/`esign-actions.ts`). Confirm `parseFinanceConfig` accepts the `finance` sub-object and returns `{ timezone }` — open `packages/core/src/finance.ts` and match its actual input shape (if it expects the whole `settings` object or a different key, adjust accordingly). The enum string casts mirror how the codebase casts in similar filter spots; if `eq(appointment.type, ...)` accepts a bare string without the cast, drop the cast.

- [ ] **Step 2: Gate + commit**
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint
git add apps/web/src/lib/scheduling-queries.ts
git commit -m "feat(web): schedule queries — type/jobType/city filters, city + tz helpers"
```

---

## Task 7: Schedule page (server) — load filtered data + options

**Files:** Modify `apps/web/src/app/(app)/schedule/page.tsx`.

- [ ] **Step 1: Rewrite the page**

Replace `apps/web/src/app/(app)/schedule/page.tsx`:

```tsx
import { listAppointments, listUsers, getScheduleCities, getTenantTimezone, type ScheduleFilter } from "@/lib/scheduling-queries";
import { toCivilDate, type ScheduleAppt } from "@savvy/core";
import { ScheduleClient } from "./ScheduleClient";
import { PageHeader } from "@/components/cockpit/PageHeader";

export const dynamic = "force-dynamic";

type SP = { view?: string; anchor?: string; crew?: string; type?: string; jobType?: string; city?: string };

export default async function SchedulePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const filter: ScheduleFilter = {
    assigneeUserId: sp.crew || undefined,
    type: sp.type || undefined,
    jobType: sp.jobType || undefined,
    city: sp.city || undefined,
  };
  const [rows, crew, cityOpts, tz] = await Promise.all([
    listAppointments(filter), listUsers(), getScheduleCities(), getTenantTimezone(),
  ]);
  const appts: ScheduleAppt[] = rows.map((r) => ({
    id: r.id, type: r.type, status: r.status,
    startsAt: r.startsAt.toISOString(), endsAt: r.endsAt.toISOString(),
    assigneeUserId: r.assigneeUserId, assigneeName: r.assigneeName,
    customerName: r.customerName, address: r.address, jobId: r.jobId, jobType: r.jobType, city: r.city,
  }));
  const view = (sp.view === "month" || sp.view === "crew") ? sp.view : "week";
  const anchor = sp.anchor || toCivilDate(new Date().toISOString(), tz);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Dispatch" title="Schedule" />
      <ScheduleClient
        appts={appts}
        crew={crew}
        cityOptions={cityOpts}
        tz={tz}
        view={view}
        anchor={anchor}
        filters={{ crew: sp.crew ?? "", type: sp.type ?? "", jobType: sp.jobType ?? "", city: sp.city ?? "" }}
      />
    </div>
  );
}
```

- [ ] **Step 2: Gate** (this will FAIL typecheck until `ScheduleClient` has the new props — that's expected; Task 8 fixes it). Do NOT commit yet; proceed to Task 8 and commit them together at the end of Task 8.

---

## Task 8: ScheduleClient — toggle, filter bar, nav, view switch

**Files:** Rewrite `apps/web/src/app/(app)/schedule/ScheduleClient.tsx`.

- [ ] **Step 1: Rewrite the client shell**

Replace `apps/web/src/app/(app)/schedule/ScheduleClient.tsx`:

```tsx
"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { addWeeks, addMonths, toCivilDate, type ScheduleAppt } from "@savvy/core";
import { APPOINTMENT_TYPE, JOB_TYPE } from "@savvy/core";
import { WeekGrid } from "./WeekGrid";
import { MonthGrid } from "./MonthGrid";
import { CrewBoard } from "./CrewBoard";
import { AppointmentPopover } from "./AppointmentPopover";
import { Button } from "@/components/ui/button";

type Crew = { id: string; name: string };
type View = "week" | "month" | "crew";

export function ScheduleClient(props: {
  appts: ScheduleAppt[];
  crew: Crew[];
  cityOptions: { cities: string[]; hasUnknown: boolean };
  tz: string;
  view: View;
  anchor: string;
  filters: { crew: string; type: string; jobType: string; city: string };
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [selected, setSelected] = useState<ScheduleAppt | null>(null);

  function setParam(patch: Record<string, string>) {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    router.push(`/schedule?${next.toString()}`);
  }
  const setView = (view: View) => setParam({ view });
  const step = (dir: -1 | 1) =>
    setParam({ anchor: props.view === "month" ? addMonths(props.anchor, dir) : addWeeks(props.anchor, dir) });
  const goToday = () => setParam({ anchor: toCivilDate(new Date().toISOString(), props.tz) });

  const sel = (cls: string) => "rounded-md px-2 py-1 text-sm " + cls;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1" data-testid="view-toggle">
          {(["week", "month", "crew"] as View[]).map((v) => (
            <button key={v} data-testid={`view-${v}`} onClick={() => setView(v)}
              className={sel(props.view === v ? "bg-[var(--accent-010)] text-accent-gold" : "text-[var(--text-muted)]")}>
              {v[0]!.toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => step(-1)} data-testid="nav-prev">‹</Button>
          <Button size="sm" variant="outline" onClick={goToday} data-testid="nav-today">Today</Button>
          <Button size="sm" variant="outline" onClick={() => step(1)} data-testid="nav-next">›</Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2" data-testid="filter-bar">
        <Select label="Crew" value={props.filters.crew} onChange={(v) => setParam({ crew: v })}
          options={[["", "All crew"], ...props.crew.map((c) => [c.id, c.name] as [string, string])]} testid="filter-crew" />
        <Select label="Type" value={props.filters.type} onChange={(v) => setParam({ type: v })}
          options={[["", "All types"], ...APPOINTMENT_TYPE.map((t) => [t, t] as [string, string])]} testid="filter-type" />
        <Select label="Job" value={props.filters.jobType} onChange={(v) => setParam({ jobType: v })}
          options={[["", "All jobs"], ...JOB_TYPE.map((t) => [t, t] as [string, string])]} testid="filter-jobType" />
        <Select label="City" value={props.filters.city} onChange={(v) => setParam({ city: v })}
          options={[["", "All cities"], ...props.cityOptions.cities.map((c) => [c, c] as [string, string]),
            ...(props.cityOptions.hasUnknown ? [["__unknown__", "Unknown"] as [string, string]] : [])]} testid="filter-city" />
      </div>

      {props.view === "week" && <WeekGrid appts={props.appts} anchor={props.anchor} tz={props.tz} onSelect={setSelected} />}
      {props.view === "month" && <MonthGrid appts={props.appts} anchor={props.anchor} tz={props.tz} onSelect={setSelected} />}
      {props.view === "crew" && <CrewBoard appts={props.appts} anchor={props.anchor} tz={props.tz} crew={props.crew} onSelect={setSelected} />}

      {selected && <AppointmentPopover appt={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Select(props: { label: string; value: string; onChange: (v: string) => void; options: [string, string][]; testid: string }) {
  return (
    <label className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
      {props.label}
      <select data-testid={props.testid} value={props.value} onChange={(e) => props.onChange(e.target.value)}
        className="rounded-md border bg-transparent px-2 py-1 text-sm"
        style={{ borderColor: "var(--border-panel)", color: "var(--text-body)" }}>
        {props.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}
```

- [ ] **Step 2: Gate** (still fails until the view + popover components exist — Task 9/10). Proceed; do not commit yet.

---

## Task 9: View components — WeekGrid, MonthGrid, CrewBoard

**Files:** Create `apps/web/src/app/(app)/schedule/WeekGrid.tsx`, `MonthGrid.tsx`, `CrewBoard.tsx`.

- [ ] **Step 1: WeekGrid**

Create `apps/web/src/app/(app)/schedule/WeekGrid.tsx`:

```tsx
"use client";
import { buildWeekView, type ScheduleAppt } from "@savvy/core";

export function WeekGrid({ appts, anchor, tz, onSelect }: { appts: ScheduleAppt[]; anchor: string; tz: string; onSelect: (a: ScheduleAppt) => void }) {
  const view = buildWeekView(appts, anchor, tz);
  return (
    <div className="overflow-x-auto" data-testid="week-grid">
      <div className="grid min-w-[700px]" style={{ gridTemplateColumns: "48px repeat(7, 1fr)" }}>
        <div />
        {view.days.map((d) => (
          <div key={d.date} className="mono px-1 pb-2 text-center text-[11px]" style={{ color: "var(--text-muted)" }}>
            {d.weekday} {Number(d.date.slice(8))}
          </div>
        ))}
        <div className="relative" style={{ height: 560 }}>
          {view.hourLabels.map((h, i) => (
            <div key={h} className="mono absolute right-1 text-[10px]" style={{ top: `${(i / (view.hourLabels.length - 1)) * 100}%`, color: "var(--text-faint)" }}>{h}</div>
          ))}
        </div>
        {view.days.map((d) => (
          <div key={d.date} data-testid={`week-col-${d.date}`} className="relative border-l" style={{ height: 560, borderColor: "var(--border-panel)" }}>
            {d.blocks.map((b) => (
              <button key={b.id} data-testid="appt-block" onClick={() => onSelect(b)}
                className="absolute overflow-hidden rounded-md px-1.5 py-0.5 text-left text-[11px]"
                style={{
                  top: `${b.topPct}%`, height: `${b.heightPct}%`,
                  left: `${(b.lane / b.lanes) * 100}%`, width: `${(1 / b.lanes) * 100}%`,
                  background: "var(--surface-panel)", borderLeft: `3px solid ${b.tone}`, color: "var(--text-body)",
                }}>
                <span className="truncate">{b.customerName ?? b.type}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: MonthGrid**

Create `apps/web/src/app/(app)/schedule/MonthGrid.tsx`:

```tsx
"use client";
import { buildMonthView, type ScheduleAppt } from "@savvy/core";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function MonthGrid({ appts, anchor, tz, onSelect }: { appts: ScheduleAppt[]; anchor: string; tz: string; onSelect: (a: ScheduleAppt) => void }) {
  const view = buildMonthView(appts, anchor, tz);
  return (
    <div data-testid="month-grid">
      <div className="grid grid-cols-7">
        {DOW.map((d) => <div key={d} className="mono px-2 py-1 text-[11px]" style={{ color: "var(--text-muted)" }}>{d}</div>)}
      </div>
      <div className="grid grid-cols-7" style={{ borderTop: "1px solid var(--border-panel)" }}>
        {view.weeks.flat().map((cell) => (
          <div key={cell.date} data-testid={`month-cell-${cell.date}`} className="min-h-24 border-b border-r p-1"
            style={{ borderColor: "var(--border-panel)", opacity: cell.outside ? 0.4 : 1 }}>
            <div className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>{cell.day}</div>
            <div className="mt-0.5 space-y-0.5">
              {cell.chips.slice(0, 3).map((c) => (
                <button key={c.id} data-testid="appt-chip" onClick={() => onSelect(c)}
                  className="block w-full truncate rounded px-1 text-left text-[10px]"
                  style={{ background: "var(--surface-panel)", borderLeft: `3px solid ${c.tone}`, color: "var(--text-body)" }}>
                  {c.customerName ?? c.type}
                </button>
              ))}
              {cell.chips.length > 3 ? <div className="mono text-[10px]" style={{ color: "var(--text-faint)" }}>+{cell.chips.length - 3} more</div> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: CrewBoard**

Create `apps/web/src/app/(app)/schedule/CrewBoard.tsx`:

```tsx
"use client";
import { buildCrewView, type ScheduleAppt } from "@savvy/core";

export function CrewBoard({ appts, anchor, tz, crew, onSelect }: { appts: ScheduleAppt[]; anchor: string; tz: string; crew: { id: string; name: string }[]; onSelect: (a: ScheduleAppt) => void }) {
  const view = buildCrewView(appts, anchor, tz, crew);
  return (
    <div className="overflow-x-auto" data-testid="crew-board">
      <div className="flex gap-3">
        {view.columns.map((col) => (
          <div key={col.userId ?? "unassigned"} data-testid={`crew-col-${col.userId ?? "unassigned"}`} className="w-56 shrink-0 rounded-xl p-2" style={{ background: "var(--surface-panel)", border: "1px solid var(--border-panel)" }}>
            <div className="mono mb-2 px-1 text-[12px] uppercase tracking-wider" style={{ color: "var(--text-body)" }}>
              {col.name} <span style={{ color: "var(--text-faint)" }}>· {col.appts.length}</span>
            </div>
            <div className="space-y-1">
              {col.days.flatMap((d) => d.appts.map((a) => (
                <button key={a.id} data-testid="appt-card" onClick={() => onSelect(a)}
                  className="block w-full rounded-md px-2 py-1 text-left text-[11px]"
                  style={{ background: "var(--surface-app)", color: "var(--text-body)" }}>
                  <span className="mono" style={{ color: "var(--text-faint)" }}>{d.weekday}</span> {a.customerName ?? a.type}
                </button>
              )))}
              {col.appts.length === 0 ? <div className="px-2 py-1 text-[11px]" style={{ color: "var(--text-faint)" }}>—</div> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4:** No commit yet (popover next, then commit Tasks 7–10 together). Move to Task 10.

---

## Task 10: AppointmentPopover (reuses existing actions)

**Files:** Create `apps/web/src/app/(app)/schedule/AppointmentPopover.tsx`. Then commit Tasks 7–10.

- [ ] **Step 1: Build the popover**

Create `apps/web/src/app/(app)/schedule/AppointmentPopover.tsx` (lifts the action UX from the old `AppointmentRow`):

```tsx
"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import type { ScheduleAppt } from "@savvy/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/cockpit/StatusBadge";
import { cancelAction, markStatusAction, rescheduleAction } from "@/lib/scheduling-actions";

export function AppointmentPopover({ appt, onClose }: { appt: ScheduleAppt; onClose: () => void }) {
  const [pending, start] = useTransition();
  const [showReschedule, setShowReschedule] = useState(false);
  const [rescheduleVal, setRescheduleVal] = useState("");
  const [slotTaken, setSlotTaken] = useState(false);
  const isActive = appt.status === "scheduled";
  const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: true });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.4)" }} onClick={onClose}>
      <div data-testid="appt-popover" onClick={(e) => e.stopPropagation()} className="w-full max-w-sm space-y-3 rounded-xl p-4"
        style={{ background: "var(--surface-app)", border: "1px solid var(--border-panel)" }}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-medium" style={{ color: "var(--text-primary)" }}>{appt.customerName ?? "Appointment"}</div>
            <div className="mono text-xs" style={{ color: "var(--text-muted)" }}>{appt.type} · {fmt(appt.startsAt)} – {fmt(appt.endsAt)}</div>
            {appt.address ? <div className="text-xs" style={{ color: "var(--text-faint)" }}>{appt.address}</div> : null}
            {appt.assigneeName ? <div className="text-xs" style={{ color: "var(--text-faint)" }}>Crew: {appt.assigneeName}</div> : null}
          </div>
          <StatusBadge status={appt.status ?? "unknown"} />
        </div>

        {isActive ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { await markStatusAction(appt.id, "done"); toast.success("Marked done"); onClose(); })}>Done</Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { await markStatusAction(appt.id, "no_show"); toast.success("No-show"); onClose(); })}>No-show</Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => { setShowReschedule((v) => !v); setSlotTaken(false); }}>Reschedule</Button>
            <Button size="sm" variant="outline" disabled={pending} className="text-destructive hover:text-destructive" onClick={() => start(async () => { await cancelAction(appt.id); toast.success("Canceled"); onClose(); })}>Cancel</Button>
          </div>
        ) : null}

        {isActive && showReschedule ? (
          <div className="space-y-1.5">
            <div className="flex gap-2">
              <Input type="datetime-local" value={rescheduleVal} disabled={pending} className="text-sm"
                onChange={(e) => { setRescheduleVal(e.target.value); setSlotTaken(false); }} />
              <Button size="sm" disabled={pending || !rescheduleVal} onClick={() => start(async () => {
                const s = new Date(rescheduleVal); const e = new Date(s.getTime() + 60 * 60 * 1000);
                const r = await rescheduleAction(appt.id, s.toISOString(), e.toISOString());
                if ("error" in r) { setSlotTaken(true); return; }
                toast.success("Rescheduled"); onClose();
              })}>Save</Button>
            </div>
            {slotTaken ? <p className="text-xs text-destructive">That time is already taken — choose another.</p> : null}
          </div>
        ) : null}

        <div className="flex items-center justify-between pt-1">
          {appt.jobId ? <Link href={`/jobs/${appt.jobId}`} className="mono text-[12px] text-accent-gold hover:underline">Open job →</Link> : <span />}
          <Button size="sm" variant="outline" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Gate the whole UI (Tasks 7–10)**
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint
```
Expected: typecheck 7/7, lint 0. Fix any prop/type mismatches between page → client → views/popover.

- [ ] **Step 3: Commit Tasks 7–10 together**
```bash
git add "apps/web/src/app/(app)/schedule"
git commit -m "feat(web): schedule calendar — week/month/crew views, filters, appointment popover"
```
Then `git status` — confirm no stray `\(app\)` dir.

---

## Task 11: e2e

**Files:** Create `apps/web/tests/e2e/schedule.spec.ts`.

- [ ] **Step 1: Read conventions** — read `apps/web/tests/e2e/scheduling.spec.ts` (existing) + `leads.spec.ts` for the seed/`withTenant` pattern and how they create appointments (the `appointment` table insert). Reuse those helpers.

- [ ] **Step 2: Write the spec**

Create `apps/web/tests/e2e/schedule.spec.ts` covering: seed 2+ appointments on known days, different crews/types/cities (insert customer→property(with city)→job→appointment via `withTenant`, matching `scheduling.spec.ts`), then:

```ts
import { test, expect } from "@playwright/test";
// (Reuse the appointment-seeding helper shape from scheduling.spec.ts — withTenant insert of
//  customer -> property{city} -> job -> appointment{startsAt,endsAt,type,assigneeUserId,status:"scheduled"}.)

test("week view renders appointment blocks", async ({ page }) => {
  // seed an appointment this week
  await page.goto("/schedule"); // defaults to week
  await expect(page.getByTestId("week-grid")).toBeVisible();
  await expect(page.getByTestId("appt-block").first()).toBeVisible();
});

test("view toggle switches to month and crew", async ({ page }) => {
  await page.goto("/schedule");
  await page.getByTestId("view-month").click();
  await expect(page.getByTestId("month-grid")).toBeVisible();
  await page.getByTestId("view-crew").click();
  await expect(page.getByTestId("crew-board")).toBeVisible();
});

test("type filter narrows the set", async ({ page }) => {
  // seed one inspection + one crew appt this week
  await page.goto("/schedule");
  await page.getByTestId("view-crew").click();
  const before = await page.getByTestId("appt-card").count();
  await page.getByTestId("filter-type").selectOption("inspection");
  await expect(page).toHaveURL(/type=inspection/);
  const after = await page.getByTestId("appt-card").count();
  expect(after).toBeLessThanOrEqual(before);
});

test("clicking an appointment opens the popover and marks done", async ({ page }) => {
  await page.goto("/schedule");
  await page.getByTestId("view-crew").click();
  await page.getByTestId("appt-card").first().click();
  await expect(page.getByTestId("appt-popover")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("appt-popover")).toBeHidden();
});
```
Flesh out the seeding to match `scheduling.spec.ts`. If a known appointment must be in the current week, compute its date from `new Date()` in the seed (e2e is allowed `new Date()`), inserting at e.g. 9:00 local. Adjust testids/locators to the real markup if needed — the behaviors (render, toggle, filter-narrows, popover-acts) are what must pass.

- [ ] **Step 3: Run the e2e**

Bring up the harness (Postgres running + migrated — re-run `pnpm --filter @savvy/db db:migrate` so `0014`/`city` is applied for the e2e DB) and run only this spec:
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy AI_STUB_PORT=4010
pkill -f "next dev" 2>/dev/null; pkill -f "inngest-cli" 2>/dev/null; pkill -f "ai-stub" 2>/dev/null; sleep 1
node apps/web/tests/e2e/ai-stub.mjs > /tmp/sch-aistub.log 2>&1 &
npx --yes inngest-cli@latest dev -u http://localhost:3000/api/inngest --no-discovery > /tmp/sch-inngest.log 2>&1 &
sleep 6
pnpm --filter @savvy/web exec tsx tests/e2e/create-tenant.ts
export TEST_TENANT_ID="$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)")"
cd apps/web && pnpm exec playwright test schedule --reporter=list ; cd ..
pkill -f ai-stub; pkill -f inngest-cli; pkill -f "next dev"
```
Expected: 4 passed. Iterate locators/seed until the behaviors pass.

- [ ] **Step 4: Full gate + commit**
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
git add apps/web/tests/e2e/schedule.spec.ts
git commit -m "test(web): e2e for schedule views, filter, popover"
```

---

## Final verification (whole-branch, before PR)
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green (core gains ~16+ new unit tests across address + schedule-view); `schedule` e2e green.
- [ ] Migration chain clean on a fresh DB: `DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;` then `pnpm --filter @savvy/db db:migrate` applies `0001..0014` without error; `\d property` shows `city`.
- [ ] Manual: load `/schedule` in a dev server (TEST_MODE, seeded tenant with at least one appointment this week) — week blocks render, toggle to month/crew works, each filter narrows, clicking an appt opens the popover and the actions work; prev/next/today move the range.
- [ ] `git log --oneline origin/main..HEAD` shows the spec + plan + the task commits; no stray worktree commits; no `\(app\)` dirs.
- [ ] PR body notes Slice B (drag) + Slice C (create) as the queued follow-ups, and that city parsing is heuristic.

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| `parseCityFromAddress` (pure, tested) | Task 1 |
| `property.city` column + populate at intake | Task 2 |
| Backfill existing rows | Task 3 |
| Pure engine: weekRange/buildWeekView, nav, tone, tz-aware | Task 4 |
| Pure engine: buildMonthView, buildCrewView | Task 5 |
| `listAppointments` filters (fix type, +jobType, +city) + city/options + tz | Task 6 |
| Schedule page reads searchParams + loads data | Task 7 |
| ScheduleClient: view toggle + 4 filters + nav, URL-driven | Task 8 |
| Week/Month/Crew view components | Task 9 |
| Appointment popover reusing existing actions + open job | Task 10 |
| Replace the agenda list | Tasks 7–10 (rewrite) |
| Unit + e2e tests | Tasks 1,4,5 (unit) + Task 11 (e2e) |
| Default Week, 6a–8p, Sunday-start, finance.timezone | Tasks 4 (engine) + 7 (defaults) |
| No calendar library; tenant isolation; no vitest in apps/web | All (verified in final) |
