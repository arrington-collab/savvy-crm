# Jobs K — Capacity view Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/capacity` page showing each rep's utilization (booked appointment-hours vs. available office-hours minus time-off) over the next 7 days, sorted most-loaded first, flagging overbooked reps.

**Architecture:** Pure capacity math in `@savvy/core` (`capacity.ts`): office minutes for a set of civil dates, interval-overlap minutes, and `buildCapacityView`. A web `capacity-queries.ts` computes the 7-day window (tenant tz), aggregates per-rep booked + blocked minutes from `appointment` + `rep_availability_block`, and calls the core builder. A server-component `/capacity` page renders it. No schema change.

**Tech Stack:** TypeScript, Next.js App Router (server components), Drizzle/Postgres (RLS), Vitest (core), Playwright (web e2e). Branches off `main`.

## Global Constraints

- **No schema change / no migration.** Reads existing tables via `withTenant`.
- **Tenant isolation:** every query inside `withTenant`; no new raw cross-tenant path.
- **Reuse:** `parseSchedulingConfig`, `getTenantTimezone`, `listAssignableReps`, and the `schedule-view` tz helpers (`toCivilDate`, `addDays`, `zonedTimeToUtc`) — all from `@savvy/core`/existing web libs. Do not re-implement tz or hours logic.
- **Window = next 7 days** from today in tenant tz. Office capacity = Σ each date's weekday hours (weekends `[]`).
- **Booked = Σ (ends_at − starts_at)** for `scheduled` appointments with `starts_at` in the window; **Available = office minutes − Σ block overlap with window**, clamped ≥ 0.
- **Utilization** = `round(booked / available × 100)`; available 0 + booked > 0 → 100. Status: `over` ≥100, `high` ≥80, `ok` >0, `free` 0.
- **Pure logic in `@savvy/core`** (apps/web is NOT in the vitest workspace — page verified by Playwright e2e). The page is a **server component**.
- **No `.js` extensions** in core/web source.
- Definition of done: `pnpm test && pnpm typecheck && pnpm lint` green; PR off `main`.

---

## File Structure

**Create:**
- `packages/core/src/capacity.ts` — types + `officeMinutesForWindow`, `overlapMinutes`, `buildCapacityView`.
- `packages/core/src/capacity.test.ts` — unit tests.
- `apps/web/src/lib/capacity-queries.ts` — `getCapacityView()`.
- `apps/web/src/app/(app)/capacity/page.tsx` — the capacity page.
- `apps/web/tests/e2e/capacity.spec.ts` — e2e.

**Modify:**
- `packages/core/src/index.ts` — append `export * from "./capacity"`.
- `apps/web/src/components/cockpit/Sidebar.tsx` — add the Capacity nav entry after Schedule.
- `docs/jobs-pipeline.md` — Capacity note.

---

## Task 1: Core — capacity math

**Files:**
- Create: `packages/core/src/capacity.ts`
- Test: `packages/core/src/capacity.test.ts`
- Modify: `packages/core/src/index.ts` (append export)

**Interfaces:**
- Consumes: `type SchedulingConfig`, `type Weekday` from `./scheduling`.
- Produces:
  - `officeMinutesForWindow(config: SchedulingConfig, civilDates: string[]): number`
  - `overlapMinutes(aStart: Date, aEnd: Date, wStart: Date, wEnd: Date): number`
  - `type RepCapacityInput = { userId: string; name: string; scheduledMin: number; blockedMin: number; apptCount: number }`
  - `type CapacityStatus = "over" | "high" | "ok" | "free"`
  - `type RepCapacity = { userId: string; name: string; availableMin: number; scheduledMin: number; apptCount: number; utilizationPct: number; status: CapacityStatus }`
  - `type CapacityView = { reps: RepCapacity[]; teamUtilizationPct: number; overCount: number; windowDays: number }`
  - `buildCapacityView(input: { officeMinutesInWindow: number; windowDays: number; reps: RepCapacityInput[] }): CapacityView`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/capacity.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parseSchedulingConfig } from "./scheduling";
import { officeMinutesForWindow, overlapMinutes, buildCapacityView } from "./capacity";

describe("officeMinutesForWindow", () => {
  const cfg = parseSchedulingConfig(undefined); // Mon–Fri 8–17 (540 min/day), weekends closed

  it("sums weekday office minutes and ignores weekends", () => {
    // 2026-06-29 is a Monday → Mon..Sun = 5 weekdays
    const dates = ["2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05"];
    expect(officeMinutesForWindow(cfg, dates)).toBe(5 * 540);
  });

  it("any 7-day window has exactly 5 weekdays (Wed start)", () => {
    const dates = ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05", "2026-07-06", "2026-07-07"];
    expect(officeMinutesForWindow(cfg, dates)).toBe(5 * 540);
  });

  it("respects custom hours", () => {
    const c = parseSchedulingConfig({ hours: { mon: [9, 12], tue: [], wed: [9, 12], thu: [], fri: [], sat: [], sun: [] } });
    expect(officeMinutesForWindow(c, ["2026-06-29", "2026-06-30", "2026-07-01"])).toBe(2 * 180); // Mon+Wed only
  });
});

describe("overlapMinutes", () => {
  const w0 = new Date("2026-06-29T00:00:00Z");
  const w1 = new Date("2026-07-06T00:00:00Z");
  it("clamps the interval to the window", () => {
    expect(overlapMinutes(new Date("2026-06-30T10:00:00Z"), new Date("2026-06-30T14:00:00Z"), w0, w1)).toBe(240);
  });
  it("is 0 for a non-overlapping interval", () => {
    expect(overlapMinutes(new Date("2026-07-10T00:00:00Z"), new Date("2026-07-11T00:00:00Z"), w0, w1)).toBe(0);
  });
  it("clamps a partially-outside interval", () => {
    expect(overlapMinutes(new Date("2026-06-28T22:00:00Z"), new Date("2026-06-29T02:00:00Z"), w0, w1)).toBe(120);
  });
});

describe("buildCapacityView", () => {
  const office = 2700; // 5 × 540
  it("computes utilization and status per rep, sorted most-loaded first", () => {
    const v = buildCapacityView({
      officeMinutesInWindow: office,
      windowDays: 7,
      reps: [
        { userId: "free", name: "Free", scheduledMin: 0, blockedMin: 0, apptCount: 0 },
        { userId: "over", name: "Over", scheduledMin: 3000, blockedMin: 0, apptCount: 6 },
        { userId: "ok", name: "Ok", scheduledMin: 540, blockedMin: 0, apptCount: 1 },
      ],
    });
    expect(v.reps.map((r) => r.userId)).toEqual(["over", "ok", "free"]);
    expect(v.reps.find((r) => r.userId === "over")!).toMatchObject({ utilizationPct: 111, status: "over", availableMin: 2700 });
    expect(v.reps.find((r) => r.userId === "ok")!).toMatchObject({ utilizationPct: 20, status: "ok" });
    expect(v.reps.find((r) => r.userId === "free")!).toMatchObject({ utilizationPct: 0, status: "free" });
    expect(v.overCount).toBe(1);
  });

  it("reduces available capacity by blocked minutes", () => {
    const v = buildCapacityView({ officeMinutesInWindow: office, windowDays: 7, reps: [{ userId: "u", name: "U", scheduledMin: 1080, blockedMin: 540, apptCount: 2 }] });
    // available = 2700 − 540 = 2160; 1080/2160 = 50%
    expect(v.reps[0]!).toMatchObject({ availableMin: 2160, utilizationPct: 50, status: "ok" });
  });

  it("flags over when available is 0 but booked > 0", () => {
    const v = buildCapacityView({ officeMinutesInWindow: 0, windowDays: 7, reps: [{ userId: "u", name: "U", scheduledMin: 60, blockedMin: 0, apptCount: 1 }] });
    expect(v.reps[0]!).toMatchObject({ availableMin: 0, utilizationPct: 100, status: "over" });
  });

  it("computes team utilization across reps and is empty-safe", () => {
    expect(buildCapacityView({ officeMinutesInWindow: office, windowDays: 7, reps: [] })).toEqual({ reps: [], teamUtilizationPct: 0, overCount: 0, windowDays: 7 });
  });

  it("marks 80% as high", () => {
    const v = buildCapacityView({ officeMinutesInWindow: office, windowDays: 7, reps: [{ userId: "u", name: "U", scheduledMin: 2160, blockedMin: 0, apptCount: 4 }] });
    expect(v.reps[0]!).toMatchObject({ utilizationPct: 80, status: "high" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core exec vitest run src/capacity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/core/src/capacity.ts`:

```typescript
import type { SchedulingConfig, Weekday } from "./scheduling";

const WD_OF_INDEX: Record<number, Weekday> = { 0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat" };

/** Total office minutes across the given civil dates (YYYY-MM-DD), using the config's per-weekday hours. */
export function officeMinutesForWindow(config: SchedulingConfig, civilDates: string[]): number {
  let total = 0;
  for (const d of civilDates) {
    const wd = WD_OF_INDEX[new Date(`${d}T00:00:00Z`).getUTCDay()]!;
    const h = config.hours[wd];
    if (h && h.length === 2) total += Math.max(0, h[1]! - h[0]!) * 60;
  }
  return total;
}

/** Minutes of [aStart,aEnd) that fall inside [wStart,wEnd). Never negative. */
export function overlapMinutes(aStart: Date, aEnd: Date, wStart: Date, wEnd: Date): number {
  const start = Math.max(aStart.getTime(), wStart.getTime());
  const end = Math.min(aEnd.getTime(), wEnd.getTime());
  return end > start ? Math.round((end - start) / 60000) : 0;
}

export type RepCapacityInput = { userId: string; name: string; scheduledMin: number; blockedMin: number; apptCount: number };
export type CapacityStatus = "over" | "high" | "ok" | "free";
export type RepCapacity = {
  userId: string; name: string; availableMin: number; scheduledMin: number; apptCount: number; utilizationPct: number; status: CapacityStatus;
};
export type CapacityView = { reps: RepCapacity[]; teamUtilizationPct: number; overCount: number; windowDays: number };

function util(scheduledMin: number, availableMin: number): number {
  if (availableMin > 0) return Math.round((scheduledMin / availableMin) * 100);
  return scheduledMin > 0 ? 100 : 0;
}

function statusOf(pct: number): CapacityStatus {
  if (pct >= 100) return "over";
  if (pct >= 80) return "high";
  return pct > 0 ? "ok" : "free";
}

/** Per-rep utilization (booked vs. available = office − blocked), sorted most-loaded first. */
export function buildCapacityView(input: { officeMinutesInWindow: number; windowDays: number; reps: RepCapacityInput[] }): CapacityView {
  const reps: RepCapacity[] = input.reps.map((r) => {
    const availableMin = Math.max(0, input.officeMinutesInWindow - r.blockedMin);
    const utilizationPct = util(r.scheduledMin, availableMin);
    return { userId: r.userId, name: r.name, availableMin, scheduledMin: r.scheduledMin, apptCount: r.apptCount, utilizationPct, status: statusOf(utilizationPct) };
  });
  reps.sort((a, b) => b.utilizationPct - a.utilizationPct);
  const totalScheduled = reps.reduce((s, r) => s + r.scheduledMin, 0);
  const totalAvailable = reps.reduce((s, r) => s + r.availableMin, 0);
  return {
    reps,
    teamUtilizationPct: util(totalScheduled, totalAvailable),
    overCount: reps.filter((r) => r.status === "over").length,
    windowDays: input.windowDays,
  };
}
```

- [ ] **Step 4: Append the export**

In `packages/core/src/index.ts`, add at the end: `export * from "./capacity";`

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @savvy/core exec vitest run src/capacity.test.ts` → PASS.
Run: `pnpm --filter @savvy/core typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/capacity.ts packages/core/src/capacity.test.ts packages/core/src/index.ts
git commit -m "feat(core): capacity math (office minutes, overlap, buildCapacityView)"
```

---

## Task 2: Web — capacity query, `/capacity` page, nav, e2e

**Files:**
- Create: `apps/web/src/lib/capacity-queries.ts`, `apps/web/src/app/(app)/capacity/page.tsx`, `apps/web/tests/e2e/capacity.spec.ts`
- Modify: `apps/web/src/components/cockpit/Sidebar.tsx`

**Interfaces:**
- Consumes: `officeMinutesForWindow`, `overlapMinutes`, `buildCapacityView`, `parseSchedulingConfig`, `toCivilDate`, `addDays`, `zonedTimeToUtc`, `type CapacityView` from `@savvy/core`; `@savvy/db` (`withTenant`, `appointment`, `repAvailabilityBlock`, `tenant`, `eq`, `and`, `gte`, `lt`, `sql`, `listAssignableReps`); `getTenantId`; `getTenantTimezone` from `./scheduling-queries`.
- Produces: `getCapacityView()`; the page; the nav entry.

- [ ] **Step 1: Build the query**

First READ `apps/web/src/lib/scheduling-queries.ts` to confirm `getTenantTimezone()`'s export/signature and reuse it. Then create `apps/web/src/lib/capacity-queries.ts`:

```typescript
import "server-only";
import { withTenant, appointment, repAvailabilityBlock, tenant, eq, and, gte, lt, listAssignableReps } from "@savvy/db";
import { parseSchedulingConfig, officeMinutesForWindow, overlapMinutes, buildCapacityView, toCivilDate, addDays, zonedTimeToUtc, type CapacityView } from "@savvy/core";
import { getTenantId } from "./tenant";
import { getTenantTimezone } from "./scheduling-queries";

const WINDOW_DAYS = 7;

export async function getCapacityView(): Promise<CapacityView> {
  const tenantId = await getTenantId();
  const tz = await getTenantTimezone();

  const today = toCivilDate(new Date().toISOString(), tz);
  const civilDates = Array.from({ length: WINDOW_DAYS }, (_, i) => addDays(today, i));
  const windowStart = new Date(zonedTimeToUtc(today, 0, tz));
  const windowEnd = new Date(zonedTimeToUtc(addDays(today, WINDOW_DAYS), 0, tz));

  return withTenant(tenantId, async (tx) => {
    const [t] = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
    const config = parseSchedulingConfig((t?.settings as { scheduling?: unknown } | undefined)?.scheduling);
    const officeMinutesInWindow = officeMinutesForWindow(config, civilDates);

    const reps = await listAssignableReps(tenantId); // [{ id, name }]

    const appts = await tx
      .select({ assigneeUserId: appointment.assigneeUserId, startsAt: appointment.startsAt, endsAt: appointment.endsAt })
      .from(appointment)
      .where(and(eq(appointment.status, "scheduled"), gte(appointment.startsAt, windowStart), lt(appointment.startsAt, windowEnd)));

    const blocks = await tx
      .select({ userId: repAvailabilityBlock.userId, startsAt: repAvailabilityBlock.startsAt, endsAt: repAvailabilityBlock.endsAt })
      .from(repAvailabilityBlock)
      .where(and(lt(repAvailabilityBlock.startsAt, windowEnd), gte(repAvailabilityBlock.endsAt, windowStart)));

    const repInputs = reps.map((r) => {
      const mine = appts.filter((a) => a.assigneeUserId === r.id);
      const scheduledMin = mine.reduce((s, a) => s + Math.round((a.endsAt.getTime() - a.startsAt.getTime()) / 60000), 0);
      const blockedMin = blocks
        .filter((b) => b.userId === r.id)
        .reduce((s, b) => s + overlapMinutes(b.startsAt, b.endsAt, windowStart, windowEnd), 0);
      return { userId: r.id, name: r.name, scheduledMin, blockedMin, apptCount: mine.length };
    });

    return buildCapacityView({ officeMinutesInWindow, windowDays: WINDOW_DAYS, reps: repInputs });
  });
}
```

If any import is unused (e.g. `sql`), drop it so lint stays at 0 errors.

- [ ] **Step 2: Build the page**

Create `apps/web/src/app/(app)/capacity/page.tsx` (server component; mirror the page shell + dark-mode tokens of `apps/web/src/app/(app)/command-center/page.tsx`):

```tsx
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { getCapacityView } from "@/lib/capacity-queries";

const STATUS_COLOR: Record<string, string> = {
  over: "var(--color-destructive, #dc2626)",
  high: "var(--accent-gold)",
  ok: "var(--accent-gold)",
  free: "var(--text-faint)",
};

function hrs(min: number): string {
  return `${Math.round(min / 60)}h`;
}

export default async function CapacityPage() {
  const view = await getCapacityView();
  return (
    <div className="space-y-6" data-testid="capacity-page">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Capacity</h1>
          <p className="text-xs" style={{ color: "var(--text-faint)" }}>Next {view.windowDays} days</p>
        </div>
        <div className="text-right">
          <div className="mono text-2xl font-semibold text-accent-gold" data-testid="team-utilization">{view.teamUtilizationPct}%</div>
          <div className="text-xs" style={{ color: "var(--text-faint)" }}>{view.overCount} overbooked</div>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle>Rep load</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {view.reps.length === 0 && (
            <p className="text-sm" style={{ color: "var(--text-faint)" }} data-testid="capacity-empty">No assignable reps yet.</p>
          )}
          {view.reps.map((r) => (
            <div key={r.userId} className="space-y-1" data-testid="capacity-rep" data-status={r.status}>
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{r.name}</span>
                <span className="mono text-xs" style={{ color: "var(--text-faint)" }}>
                  {hrs(r.scheduledMin)} of {hrs(r.availableMin)} · {r.apptCount} appts · <span data-testid="rep-utilization">{r.utilizationPct}%</span>
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--surface-2, rgba(255,255,255,0.06))" }}>
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.min(100, r.utilizationPct)}%`, background: STATUS_COLOR[r.status] }}
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Add the nav entry**

In `apps/web/src/components/cockpit/Sidebar.tsx`, add to `NAV` immediately AFTER the `/schedule` entry:

```typescript
  { href: "/capacity", label: "Capacity" },
```

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm --filter web typecheck && pnpm --filter web lint`
Expected: clean / no new errors (drop any unused import).

- [ ] **Step 5: Write the e2e**

Create `apps/web/tests/e2e/capacity.spec.ts`. (Office minutes for any 7-day window with default config = 2700; seed a rep with one 270-min appointment → 10% utilization, deterministic regardless of run date.)

```typescript
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, user, customer, property, job, appointment } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("capacity page shows per-rep utilization for the next 7 days", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [rep] = await adminDb.insert(user).values({ tenantId, name: `Rep ${stamp}`, email: `rep-${stamp}@e2e.test`, role: "rep" }).returning();
  const [cust] = await adminDb.insert(customer).values({ tenantId, name: `Cap ${stamp}`, email: `cap-${stamp}@e2e.test` }).returning();
  const [prop] = await adminDb.insert(property).values({ tenantId, customerId: cust!.id, address: `${stamp} Cap Way` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "production" }).returning();
  // One 270-minute appointment 2 days out (inside the 7-day window) → 270/2700 = 10%.
  const start = new Date(Date.now() + 2 * 86_400_000);
  const end = new Date(start.getTime() + 270 * 60_000);
  await adminDb.insert(appointment).values({ tenantId, jobId: j!.id, customerId: cust!.id, assigneeUserId: rep!.id, type: "inspection", status: "scheduled", startsAt: start, endsAt: end });

  await page.goto(`/capacity`);
  await expect(page.getByTestId("capacity-page")).toBeVisible();
  const row = page.getByTestId("capacity-rep").filter({ hasText: `Rep ${stamp}` });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("rep-utilization")).toHaveText("10%");
  await expect(row).toContainText("1 appts");
});
```

- [ ] **Step 6: Run the e2e**

Setup: `pnpm db:up && pnpm --filter @savvy/db db:migrate`, then from `apps/web`:
```bash
npx tsx tests/e2e/create-tenant.ts
export TEST_TENANT_ID=$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)")
./node_modules/.bin/playwright test tests/e2e/capacity.spec.ts
```
Expected: PASS (the seeded rep shows 10%, 1 appt). If a browser needs installing: `npx playwright install chromium`. Make it pass for REAL — don't weaken; if blocked, report with the failing output. (If the seeded appointment's `starts_at` ever lands on a window-edge boundary causing flakiness, place it 2 days out as written — safely interior.)

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/capacity-queries.ts "apps/web/src/app/(app)/capacity/page.tsx" apps/web/src/components/cockpit/Sidebar.tsx apps/web/tests/e2e/capacity.spec.ts
git commit -m "feat(web): /capacity view (per-rep utilization, next 7 days) + nav"
```

---

## Task 3: Docs + full verification

**Files:**
- Modify: `docs/jobs-pipeline.md`

- [ ] **Step 1: Document the view**

Append to `docs/jobs-pipeline.md`:

```markdown
## Capacity (Jobs K)

`/capacity` shows each rep's utilization over the **next 7 days**:

- **Available** = office minutes in the window (per-weekday hours from
  `parseSchedulingConfig`, weekends closed) minus the rep's time-off
  (`rep_availability_block`) overlapping the window. Any 7-day window contains
  exactly the 5 weekdays, so default capacity = 5 × 9h = 2700 min.
- **Booked** = sum of real appointment durations (`ends_at − starts_at`) for the
  rep's `scheduled` appointments starting in the window.
- **Utilization** = booked ÷ available; `over` ≥ 100%, `high` ≥ 80%, `ok` > 0,
  `free` 0. Reps are sorted most-loaded first; the header shows team utilization
  and the overbooked count.

Capacity is per-user (appointments carry an `assignee_user_id`; there is no crew
entity yet). Logic: `buildCapacityView` in `@savvy/core`.
```

- [ ] **Step 2: Full suite**

Run: `pnpm test` → all green (core cases added).

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint` → typecheck clean; lint 0 errors.

- [ ] **Step 4: Commit + PR**

```bash
git add docs/jobs-pipeline.md
git commit -m "docs(jobs): document the Capacity view (K)"
git push -u origin jobs-k
gh pr create --base main --title "feat(jobs): K — Capacity view (per-rep utilization)" --body "<summary>"
```

---

## Self-Review notes

- **Spec coverage:** office capacity → Task 1 (`officeMinutesForWindow`). Booked/blocked aggregation → Task 2 (query) using Task 1's `overlapMinutes`. Utilization + status + sort + team summary → Task 1 (`buildCapacityView`). Page + nav → Task 2. No schema change → confirmed.
- **Determinism:** any 7-day window = 5 weekdays → office minutes are run-date-independent for the default config, so the e2e's 10% assertion is stable.
- **Reuse:** tz + hours via `parseSchedulingConfig`/`toCivilDate`/`zonedTimeToUtc`/`getTenantTimezone`; reps via `listAssignableReps`. Only the capacity math is new (pure + tested).
- **Type consistency:** `RepCapacityInput`/`CapacityView` defined in Task 1, produced/consumed verbatim by Task 2.
- **Server-component page:** no client boundary; numbers/strings only.
