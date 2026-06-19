# Schedule Drag — Reschedule + Reassign (Slice B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add drag-to-reschedule (Week + Month) and drag-to-reassign (Crew) to the schedule calendar, optimistic with revert-on-conflict.

**Architecture:** New pure tz-inverse + drag→time math in `@savvy/core` (unit-tested); a new `reassignAppointment` write mirroring `rescheduleAppointment`; `@dnd-kit` wiring on the three views with `ScheduleClient` holding optimistic appt state (jobs-board pattern). No schema change.

**Tech Stack:** Next.js 16, React, `@dnd-kit/core` (already a dep), Drizzle/Postgres (the `appointment_no_overlap` EXCLUDE constraint enforces no-double-book), vitest (core/db), Playwright (web).

---

## Conventions
- **Repo root:** `~/Sites/savvy-crm`. **Branch:** `feat/schedule-drag` (checked out, off `feat/schedule-calendar`).
- **Gate:** `export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy && pnpm typecheck && pnpm lint` (+ `pnpm test` for core/db tasks). 7/7 typecheck, 0 lint. `rm -rf apps/web/.next` if stale-cache.
- Import drizzle ops from `@savvy/db`, `z` from `@savvy/core`. No `.js` in source; `*.test.ts` in core use `.js`. `noUncheckedIndexedAccess` is ON. apps/web Playwright-only. Token colors only. Quote `(app)` paths in `git add`.

## File Structure
- **Modify** `packages/core/src/schedule-view.ts` (+ `.test.ts`): add `zonedTimeToUtc`, `applyDragToWeek`, `applyDragToMonth` (uses the existing internal `partsInTz`/`minutesInTz`).
- **Modify** `packages/db/src/lifecycle/appointments.ts`: add `reassignAppointment`; ensure it's exported from `packages/db/src/index.ts`. **New** `packages/db/tests/reassign.test.ts`.
- **Modify** `apps/web/src/lib/scheduling-actions.ts`: add `reassignAction`.
- **Modify** `apps/web/src/app/(app)/schedule/ScheduleClient.tsx`, `WeekGrid.tsx`, `MonthGrid.tsx`, `CrewBoard.tsx` (dnd wiring + optimistic state).
- **New** `apps/web/tests/e2e/schedule-drag.spec.ts`.

---

## Task 1: Pure engine — tz inverse + drag math (`@savvy/core`)

**Files:** Modify `packages/core/src/schedule-view.ts` + `schedule-view.test.ts`.

- [ ] **Step 1: Append failing tests to `packages/core/src/schedule-view.test.ts`**

```ts
import { zonedTimeToUtc, applyDragToWeek, applyDragToMonth } from "./schedule-view.js";

describe("zonedTimeToUtc", () => {
  it("round-trips a Phoenix wall time", () => {
    const iso = zonedTimeToUtc("2026-06-17", 540, TZ); // 09:00 Phoenix
    expect(iso).toBe("2026-06-17T16:00:00.000Z");
    expect(toCivilDate(iso, TZ)).toBe("2026-06-17");
  });
  it("round-trips a New York (DST) wall time", () => {
    const ny = "America/New_York"; // UTC-4 in June
    const iso = zonedTimeToUtc("2026-06-17", 540, ny); // 09:00 EDT
    expect(iso).toBe("2026-06-17T13:00:00.000Z");
    expect(toCivilDate(iso, ny)).toBe("2026-06-17");
  });
});

describe("applyDragToWeek", () => {
  const base = { startsAt: "2026-06-17T16:00:00Z", endsAt: "2026-06-17T17:00:00Z" }; // 09:00-10:00 Phoenix, 1h
  it("shifts time by the vertical delta (snapped), same day, keeps duration", () => {
    // 80px / 560px * 840min = 120min -> 09:00 + 2h = 11:00 Phoenix = 18:00Z
    const r = applyDragToWeek(base, 80, 560, "2026-06-17", TZ);
    expect(r.startsAt).toBe("2026-06-17T18:00:00.000Z");
    expect(r.endsAt).toBe("2026-06-17T19:00:00.000Z");
  });
  it("moves to a new day when dropped on another column (delta 0)", () => {
    const r = applyDragToWeek(base, 0, 560, "2026-06-19", TZ);
    expect(toCivilDate(r.startsAt, TZ)).toBe("2026-06-19");
    expect(r.startsAt).toBe("2026-06-19T16:00:00.000Z"); // still 09:00 Phoenix
  });
  it("clamps above the 6am window edge", () => {
    const r = applyDragToWeek(base, -1000, 560, "2026-06-17", TZ); // drag far up
    expect(r.startsAt).toBe("2026-06-17T13:00:00.000Z"); // 06:00 Phoenix
  });
});

describe("applyDragToMonth", () => {
  it("changes the day, keeps the time-of-day", () => {
    const r = applyDragToMonth({ startsAt: "2026-06-17T16:00:00Z", endsAt: "2026-06-17T17:00:00Z" }, "2026-06-20", TZ);
    expect(r.startsAt).toBe("2026-06-20T16:00:00.000Z");
    expect(r.endsAt).toBe("2026-06-20T17:00:00.000Z");
  });
});
```
(`TZ` + `toCivilDate` are already imported/defined at the top of this test file from Slice A.)

- [ ] **Step 2: Run (fails)** — `pnpm --filter @savvy/core test schedule-view` → FAIL (new fns missing).

- [ ] **Step 3: Implement — append to `packages/core/src/schedule-view.ts`**

```ts
// ---- drag: tz inverse + position->time -----------------------------------
/** Inverse of toCivilDate/minutesInTz: a wall-clock day+minutes in `tz` -> UTC ISO instant.
 *  Offset-correction; exact outside the 1h DST spring-forward gap (approximate inside it). */
export function zonedTimeToUtc(civilDate: string, minutes: number, tz: string): string {
  const [y, mo, d] = civilDate.split("-").map(Number);
  const guess = Date.UTC(y!, mo! - 1, d!, Math.floor(minutes / 60), minutes % 60);
  const p = partsInTz(new Date(guess).toISOString(), tz); // wall time that `guess` shows in tz
  const wallAsUTC = Date.UTC(p.y, p.mo - 1, p.d, Math.floor(p.minutes / 60), p.minutes % 60);
  const offset = wallAsUTC - guess; // how far tz is from UTC at this instant
  return new Date(guess - offset).toISOString();
}

function snap30(min: number): number { return Math.round(min / 30) * 30; }

/** New {startsAt,endsAt} after dragging a week block by `deltaYpx` (within a `gridHeightPx`
 *  6a-8p grid) onto `newDate`. Snaps to 30 min, preserves duration, clamps into the window. */
export function applyDragToWeek(
  appt: { startsAt: string; endsAt: string }, deltaYpx: number, gridHeightPx: number, newDate: string, tz: string,
): { startsAt: string; endsAt: string } {
  const startMin = minutesInTz(appt.startsAt, tz);
  const durMin = (Date.parse(appt.endsAt) - Date.parse(appt.startsAt)) / 60000;
  const deltaMin = Math.round((deltaYpx / gridHeightPx) * SPAN_MIN);
  const newStart = Math.max(DAY_START_MIN, Math.min(snap30(startMin + deltaMin), DAY_END_MIN - durMin));
  const startsAt = zonedTimeToUtc(newDate, newStart, tz);
  const endsAt = new Date(Date.parse(startsAt) + durMin * 60000).toISOString();
  return { startsAt, endsAt };
}

/** New {startsAt,endsAt} after dragging a month chip onto `newDate` (keeps the time-of-day). */
export function applyDragToMonth(
  appt: { startsAt: string; endsAt: string }, newDate: string, tz: string,
): { startsAt: string; endsAt: string } {
  const startMin = minutesInTz(appt.startsAt, tz);
  const durMin = (Date.parse(appt.endsAt) - Date.parse(appt.startsAt)) / 60000;
  const startsAt = zonedTimeToUtc(newDate, startMin, tz);
  const endsAt = new Date(Date.parse(startsAt) + durMin * 60000).toISOString();
  return { startsAt, endsAt };
}
```
(`partsInTz`, `minutesInTz`, `DAY_START_MIN`=360, `DAY_END_MIN`=1200, `SPAN_MIN`=840 already exist in this file from Slice A. No new exports of those needed.)

- [ ] **Step 4: Run (passes)** — `pnpm --filter @savvy/core test schedule-view` → PASS.

- [ ] **Step 5: Gate + commit**
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm --filter @savvy/core test
git add packages/core/src/schedule-view.ts packages/core/src/schedule-view.test.ts
git commit -m "feat(core): zonedTimeToUtc + applyDragToWeek/Month (drag math)"
```

---

## Task 2: `reassignAppointment` (`@savvy/db`)

**Files:** Modify `packages/db/src/lifecycle/appointments.ts`; ensure export in `packages/db/src/index.ts`; create `packages/db/tests/reassign.test.ts`.

- [ ] **Step 1: Write the integration test**

First READ an existing `packages/db/tests/*.test.ts` (e.g. one that inserts appointments / uses `withTenant` + a seeded tenant) to copy the setup harness (how it makes a tenant + users + a job + appointments, and the test DB connection). Then create `packages/db/tests/reassign.test.ts` modeled on it, asserting:
- reassign a scheduled appointment to a free user → `assigneeUserId` updates;
- reassign into a slot already occupied (overlapping, same time) by the target user → throws `SlotTakenError`;
- reassign with a different tenant's id → no row changes (isolation).

Use the same imports/setup as the sibling test. Core assertions:
```ts
// after seeding userA, userB, an appt for userA, and an overlapping scheduled appt for userB:
await reassignAppointment({ tenantId, appointmentId: apptA.id, assigneeUserId: userBFree.id });
// -> row.assigneeUserId === userBFree.id
await expect(reassignAppointment({ tenantId, appointmentId: apptA.id, assigneeUserId: userBBusy.id }))
  .rejects.toBeInstanceOf(SlotTakenError);
```
(Import `reassignAppointment`, `SlotTakenError` from `@savvy/db` or the relative lifecycle path matching the sibling test's import style.)

- [ ] **Step 2: Run (fails)** — `pnpm --filter @savvy/db test reassign` → FAIL (`reassignAppointment` missing).

- [ ] **Step 3: Implement — add to `packages/db/src/lifecycle/appointments.ts`** (after `rescheduleAppointment`):

```ts
export async function reassignAppointment(input: {
  tenantId: string; appointmentId: string; assigneeUserId: string | null;
}): Promise<void> {
  try {
    await withTenant(input.tenantId, (tx) => tx.update(appointment).set({
      assigneeUserId: input.assigneeUserId,
    }).where(and(eq(appointment.id, input.appointmentId), eq(appointment.status, "scheduled"))));
  } catch (e) {
    if (isExclusionViolation(e)) throw new SlotTakenError();
    throw e;
  }
}
```

- [ ] **Step 4: Ensure it's exported** — confirm `packages/db/src/index.ts` re-exports the appointments lifecycle (it already exports `rescheduleAppointment`/`SlotTakenError`, used by `apps/web`). If the export is an explicit list, add `reassignAppointment`; if it's `export * from "./lifecycle/appointments"`, nothing to do. Verify `import { reassignAppointment } from "@savvy/db"` resolves.

- [ ] **Step 5: Run (passes) + gate + commit**
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm --filter @savvy/db test reassign && pnpm typecheck && pnpm lint
git add packages/db/src/lifecycle/appointments.ts packages/db/src/index.ts packages/db/tests/reassign.test.ts
git commit -m "feat(db): reassignAppointment (mirrors reschedule conflict handling)"
```

---

## Task 3: `reassignAction` (`apps/web`)

**Files:** Modify `apps/web/src/lib/scheduling-actions.ts`.

- [ ] **Step 1: Add the action**

In `apps/web/src/lib/scheduling-actions.ts`: add `reassignAppointment` to the `@savvy/db` import (alongside `rescheduleAppointment`, etc.), then append:

```ts
export async function reassignAction(
  appointmentId: string,
  assigneeUserId: string | null,
): Promise<{ ok: true } | { error: "slot_taken" }> {
  const tenantId = await getTenantId();
  try {
    await reassignAppointment({ tenantId, appointmentId, assigneeUserId });
  } catch (e) {
    if (e instanceof SlotTakenError) return { error: "slot_taken" as const };
    throw e;
  }
  await emit("appointment/changed", { appointmentId, tenantId, reason: "reassigned" });
  revalidatePath("/schedule");
  return { ok: true as const };
}
```
(`SlotTakenError`, `emit`, `getTenantId`, `revalidatePath` are already imported/defined in this file. `reason: "reassigned"` is already in the `emit` union type — confirm; it is.)

- [ ] **Step 2: Gate + commit**
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint
git add apps/web/src/lib/scheduling-actions.ts
git commit -m "feat(web): reassignAction server action"
```

---

## Task 4: Client drag wiring — ScheduleClient state + 3 views (`apps/web`)

Build all four together (interdependent) and commit once. apps/web is Playwright-only — no unit tests here.

**Files:** Modify `ScheduleClient.tsx`, `WeekGrid.tsx`, `MonthGrid.tsx`, `CrewBoard.tsx` (all under `apps/web/src/app/(app)/schedule/`).

- [ ] **Step 1: ScheduleClient — optimistic state + handlers**

In `ScheduleClient.tsx`:
- Add imports: `useEffect, useTransition` to the React import; `import { toast } from "sonner";`; `import { rescheduleAction, reassignAction } from "@/lib/scheduling-actions";`.
- Replace the appts source + add handlers. After the existing `const [selected, setSelected] = useState<ScheduleAppt | null>(null);` add:
```tsx
  const [appts, setAppts] = useState(props.appts);
  useEffect(() => setAppts(props.appts), [props.appts]);
  const [, startTransition] = useTransition();
  const crewName = (id: string | null) => props.crew.find((c) => c.id === id)?.name ?? null;

  function onReschedule(id: string, next: { startsAt: string; endsAt: string }) {
    const prev = appts;
    setAppts((a) => a.map((x) => (x.id === id ? { ...x, ...next } : x)));
    startTransition(async () => {
      const r = await rescheduleAction(id, next.startsAt, next.endsAt);
      if ("error" in r) { setAppts(prev); toast.error("That time is taken — reverted."); }
    });
  }
  function onReassign(id: string, userId: string | null) {
    const prev = appts;
    setAppts((a) => a.map((x) => (x.id === id ? { ...x, assigneeUserId: userId, assigneeName: crewName(userId) } : x)));
    startTransition(async () => {
      const r = await reassignAction(id, userId);
      if ("error" in r) { setAppts(prev); toast.error("That crew is busy then — reverted."); }
    });
  }
```
- Change the three view renders to use the local `appts` state and pass the handlers:
```tsx
{props.view === "week" && <WeekGrid appts={appts} anchor={props.anchor} tz={props.tz} onSelect={setSelected} onReschedule={onReschedule} />}
{props.view === "month" && <MonthGrid appts={appts} anchor={props.anchor} tz={props.tz} onSelect={setSelected} onReschedule={onReschedule} />}
{props.view === "crew" && <CrewBoard appts={appts} anchor={props.anchor} tz={props.tz} crew={props.crew} onSelect={setSelected} onReassign={onReassign} />}
```
(Note: the `AppointmentPopover` render and everything else stay as-is, including the `tz` prop on the popover from Slice A's fix.)

- [ ] **Step 2: WeekGrid — draggable blocks, droppable columns**

Replace `apps/web/src/app/(app)/schedule/WeekGrid.tsx`:
```tsx
"use client";
import { DndContext, useDraggable, useDroppable, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { buildWeekView, applyDragToWeek, type ScheduleAppt, type PositionedAppt, type WeekDay } from "@savvy/core";

function WeekBlock({ b, onSelect }: { b: PositionedAppt; onSelect: (a: ScheduleAppt) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: b.id });
  const drag = transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined;
  return (
    <button ref={setNodeRef} {...listeners} {...attributes} data-testid="appt-block" onClick={() => onSelect(b)}
      className="absolute overflow-hidden rounded-md px-1.5 py-0.5 text-left text-[11px]"
      style={{
        top: `${b.topPct}%`, height: `${b.heightPct}%`, left: `${(b.lane / b.lanes) * 100}%`, width: `${(1 / b.lanes) * 100}%`,
        transform: drag, zIndex: isDragging ? 20 : undefined, opacity: isDragging ? 0.7 : 1,
        background: "var(--surface-panel)", borderLeft: `3px solid ${b.tone}`, color: "var(--text-body)",
      }}>
      <span className="truncate">{b.customerName ?? b.type}</span>
    </button>
  );
}

function WeekCol({ day, onSelect }: { day: WeekDay; onSelect: (a: ScheduleAppt) => void }) {
  const { setNodeRef } = useDroppable({ id: day.date });
  return (
    <div ref={setNodeRef} data-testid={`week-col-${day.date}`} className="relative border-l" style={{ height: 560, borderColor: "var(--border-panel)" }}>
      {day.blocks.map((b) => <WeekBlock key={b.id} b={b} onSelect={onSelect} />)}
    </div>
  );
}

export function WeekGrid({ appts, anchor, tz, onSelect, onReschedule }: {
  appts: ScheduleAppt[]; anchor: string; tz: string;
  onSelect: (a: ScheduleAppt) => void; onReschedule: (id: string, next: { startsAt: string; endsAt: string }) => void;
}) {
  const view = buildWeekView(appts, anchor, tz);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  function handleDragEnd(e: DragEndEvent) {
    const appt = appts.find((a) => a.id === String(e.active.id));
    const overDate = e.over ? String(e.over.id) : null;
    if (!appt || !overDate) return;
    onReschedule(appt.id, applyDragToWeek({ startsAt: appt.startsAt, endsAt: appt.endsAt }, e.delta.y, 560, overDate, tz));
  }
  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="overflow-x-auto" data-testid="week-grid">
        <div className="grid min-w-[700px]" style={{ gridTemplateColumns: "48px repeat(7, 1fr)" }}>
          <div />
          {view.days.map((d) => (
            <div key={d.date} className="mono px-1 pb-2 text-center text-[11px]" style={{ color: "var(--text-muted)" }}>{d.weekday} {Number(d.date.slice(8))}</div>
          ))}
          <div className="relative" style={{ height: 560 }}>
            {view.hourLabels.map((h, i) => (
              <div key={h} className="mono absolute right-1 text-[10px]" style={{ top: `${(i / (view.hourLabels.length - 1)) * 100}%`, color: "var(--text-faint)" }}>{h}</div>
            ))}
          </div>
          {view.days.map((d) => <WeekCol key={d.date} day={d} onSelect={onSelect} />)}
        </div>
      </div>
    </DndContext>
  );
}
```
(Verify `PositionedAppt` and `WeekDay` are exported from `@savvy/core` — they are exported types in `schedule-view.ts`. If a type isn't exported, add `export` to it there.)

- [ ] **Step 3: MonthGrid — draggable chips, droppable cells**

Replace `apps/web/src/app/(app)/schedule/MonthGrid.tsx`:
```tsx
"use client";
import { DndContext, useDraggable, useDroppable, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { buildMonthView, applyDragToMonth, type ScheduleAppt, type MonthChip, type MonthCell } from "@savvy/core";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Chip({ c, onSelect }: { c: MonthChip; onSelect: (a: ScheduleAppt) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: c.id });
  return (
    <button ref={setNodeRef} {...listeners} {...attributes} data-testid="appt-chip" onClick={() => onSelect(c)}
      className="block w-full truncate rounded px-1 text-left text-[10px]"
      style={{ background: "var(--surface-panel)", borderLeft: `3px solid ${c.tone}`, color: "var(--text-body)", opacity: isDragging ? 0.7 : 1 }}>
      {c.customerName ?? c.type}
    </button>
  );
}

function Cell({ cell, onSelect }: { cell: MonthCell; onSelect: (a: ScheduleAppt) => void }) {
  const { setNodeRef } = useDroppable({ id: cell.date });
  return (
    <div ref={setNodeRef} data-testid={`month-cell-${cell.date}`} className="min-h-24 border-b border-r p-1" style={{ borderColor: "var(--border-panel)", opacity: cell.outside ? 0.4 : 1 }}>
      <div className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>{cell.day}</div>
      <div className="mt-0.5 space-y-0.5">
        {cell.chips.slice(0, 3).map((c) => <Chip key={c.id} c={c} onSelect={onSelect} />)}
        {cell.chips.length > 3 ? <div className="mono text-[10px]" style={{ color: "var(--text-faint)" }}>+{cell.chips.length - 3} more</div> : null}
      </div>
    </div>
  );
}

export function MonthGrid({ appts, anchor, tz, onSelect, onReschedule }: {
  appts: ScheduleAppt[]; anchor: string; tz: string;
  onSelect: (a: ScheduleAppt) => void; onReschedule: (id: string, next: { startsAt: string; endsAt: string }) => void;
}) {
  const view = buildMonthView(appts, anchor, tz);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  function handleDragEnd(e: DragEndEvent) {
    const appt = appts.find((a) => a.id === String(e.active.id));
    const overDate = e.over ? String(e.over.id) : null;
    if (!appt || !overDate) return;
    onReschedule(appt.id, applyDragToMonth({ startsAt: appt.startsAt, endsAt: appt.endsAt }, overDate, tz));
  }
  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div data-testid="month-grid">
        <div className="grid grid-cols-7">
          {DOW.map((d) => <div key={d} className="mono px-2 py-1 text-[11px]" style={{ color: "var(--text-muted)" }}>{d}</div>)}
        </div>
        <div className="grid grid-cols-7" style={{ borderTop: "1px solid var(--border-panel)" }}>
          {view.weeks.flat().map((cell) => <Cell key={cell.date} cell={cell} onSelect={onSelect} />)}
        </div>
      </div>
    </DndContext>
  );
}
```
(Verify `MonthChip`/`MonthCell` are exported from `@savvy/core`; they are types in `schedule-view.ts` — add `export` if missing.)

- [ ] **Step 4: CrewBoard — draggable cards, droppable columns (reassign)**

Replace `apps/web/src/app/(app)/schedule/CrewBoard.tsx`:
```tsx
"use client";
import { DndContext, useDraggable, useDroppable, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { buildCrewView, type ScheduleAppt, type CrewColumn } from "@savvy/core";

function Card({ a, weekday, onSelect }: { a: ScheduleAppt; weekday: string; onSelect: (x: ScheduleAppt) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: a.id });
  return (
    <button ref={setNodeRef} {...listeners} {...attributes} data-testid="appt-card" onClick={() => onSelect(a)}
      className="block w-full rounded-md px-2 py-1 text-left text-[11px]"
      style={{ background: "var(--surface-app)", color: "var(--text-body)", opacity: isDragging ? 0.7 : 1 }}>
      <span className="mono" style={{ color: "var(--text-faint)" }}>{weekday}</span> {a.customerName ?? a.type}
    </button>
  );
}

function Col({ col, onSelect }: { col: CrewColumn; onSelect: (a: ScheduleAppt) => void }) {
  const { setNodeRef } = useDroppable({ id: col.userId ?? "unassigned" });
  return (
    <div ref={setNodeRef} data-testid={`crew-col-${col.userId ?? "unassigned"}`} className="w-56 shrink-0 rounded-xl p-2" style={{ background: "var(--surface-panel)", border: "1px solid var(--border-panel)" }}>
      <div className="mono mb-2 px-1 text-[12px] uppercase tracking-wider" style={{ color: "var(--text-body)" }}>
        {col.name} <span style={{ color: "var(--text-faint)" }}>· {col.appts.length}</span>
      </div>
      <div className="space-y-1">
        {col.days.flatMap((d) => d.appts.map((a) => <Card key={a.id} a={a} weekday={d.weekday} onSelect={onSelect} />))}
        {col.appts.length === 0 ? <div className="px-2 py-1 text-[11px]" style={{ color: "var(--text-faint)" }}>—</div> : null}
      </div>
    </div>
  );
}

export function CrewBoard({ appts, anchor, tz, crew, onSelect, onReassign }: {
  appts: ScheduleAppt[]; anchor: string; tz: string; crew: { id: string; name: string }[];
  onSelect: (a: ScheduleAppt) => void; onReassign: (id: string, userId: string | null) => void;
}) {
  const view = buildCrewView(appts, anchor, tz, crew);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  function handleDragEnd(e: DragEndEvent) {
    const appt = appts.find((a) => a.id === String(e.active.id));
    if (!appt || !e.over) return;
    const target = String(e.over.id); // a userId or "unassigned"
    const targetUserId = target === "unassigned" ? null : target;
    if (targetUserId === appt.assigneeUserId) return; // dropped on its own column -> no-op
    onReassign(appt.id, targetUserId);
  }
  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="overflow-x-auto" data-testid="crew-board">
        <div className="flex gap-3">
          {view.columns.map((col) => <Col key={col.userId ?? "unassigned"} col={col} onSelect={onSelect} />)}
        </div>
      </div>
    </DndContext>
  );
}
```
(Verify `CrewColumn` is exported from `@savvy/core`.)

- [ ] **Step 5: Gate (all four files)**
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint
```
Expect 7/7 + 0. Fix any missing `export` on the `@savvy/core` types used (`PositionedAppt`/`WeekDay`/`MonthChip`/`MonthCell`/`CrewColumn`) — add `export` in `schedule-view.ts` and re-run.

- [ ] **Step 6: Commit**
```bash
git add "apps/web/src/app/(app)/schedule" packages/core/src/schedule-view.ts
git commit -m "feat(web): drag-to-reschedule (week/month) + drag-to-reassign (crew), optimistic"
```
(Include `schedule-view.ts` only if you had to add `export` to types there.) Then `git status` — no stray `\(app\)` dir.

---

## Task 5: e2e + final verification

**Files:** Create `apps/web/tests/e2e/schedule-drag.spec.ts`.

- [ ] **Step 1: Write the spec** — model seeding on `apps/web/tests/e2e/schedule.spec.ts` (Slice A) which already seeds in-week appts via `adminDb`. Cover the three behaviors; use Playwright drag (`locator.dragTo`, or `mouse.move`/`down`/`up` for finer control). dnd e2e is flaky — assert the RESULTING state after the action/revalidate, and prefer the conflict-revert assertion (most reliable).

```ts
import { test, expect } from "@playwright/test";
// reuse Slice A's seeding helpers (adminDb insert user[crew] -> customer -> property -> job -> appointment this week)

test("drag a crew card to another column reassigns it", async ({ page }) => {
  // seed crew users Mike(u1) + Sara(u2) and an appt assigned to Mike this week
  await page.goto("/schedule");
  await page.getByTestId("view-crew").click();
  const card = page.getByTestId("appt-card").first();
  await expect(card).toBeVisible();
  // drag the card from Mike's column to Sara's column
  await card.dragTo(page.getByTestId(`crew-col-${u2Id}`));
  // after revalidate, the card lives under Sara's column
  await expect(page.getByTestId(`crew-col-${u2Id}`).getByTestId("appt-card")).toBeVisible();
});

test("dragging onto a busy crew reverts with a toast", async ({ page }) => {
  // seed Mike with an appt at 9-10 AND Sara with an overlapping appt at 9-10 this week
  await page.goto("/schedule");
  await page.getByTestId("view-crew").click();
  const mikeCard = page.getByTestId(`crew-col-${u1Id}`).getByTestId("appt-card").first();
  await mikeCard.dragTo(page.getByTestId(`crew-col-${u2Id}`));
  // conflict -> reverted: Mike still has his card, and a toast shows
  await expect(page.getByText(/busy then|reverted/i)).toBeVisible();
  await expect(page.getByTestId(`crew-col-${u1Id}`).getByTestId("appt-card")).toBeVisible();
});

test("drag a week block to another day", async ({ page }) => {
  // seed an appt this week (default week view)
  await page.goto("/schedule");
  const block = page.getByTestId("appt-block").first();
  await expect(block).toBeVisible();
  const origDay = /* the appt's week-col date */ "";
  const targetDay = /* a different in-window day */ "";
  await block.dragTo(page.getByTestId(`week-col-${targetDay}`));
  await expect(page.getByTestId(`week-col-${targetDay}`).getByTestId("appt-block")).toBeVisible();
});
```
Compute the seeded appt's `week-col-<date>` from the seed time (use `toCivilDate(startISO, "America/Phoenix")` imported from `@savvy/core`, as Slice A's scheduling.spec fix did). Iterate until the three behaviors pass; if a positional drag is too flaky, keep the reassign + conflict-revert tests (column-target drags are the most reliable) and make the week-block test a same-evidence DB-or-column assertion.

- [ ] **Step 2: Run the e2e** (harness; ensure migrations applied):
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy AI_STUB_PORT=4010
pnpm --filter @savvy/db db:migrate
pkill -f "next dev" 2>/dev/null; pkill -f "inngest-cli" 2>/dev/null; pkill -f "ai-stub" 2>/dev/null; sleep 1
node apps/web/tests/e2e/ai-stub.mjs > /tmp/drag-aistub.log 2>&1 &
npx --yes inngest-cli@latest dev -u http://localhost:3000/api/inngest --no-discovery > /tmp/drag-inngest.log 2>&1 &
sleep 6
pnpm --filter @savvy/web exec tsx tests/e2e/create-tenant.ts
export TEST_TENANT_ID="$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)")"
cd apps/web && pnpm exec playwright test schedule-drag --reporter=list ; cd ..
pkill -f ai-stub; pkill -f inngest-cli; pkill -f "next dev"
```
Expect the tests green. Iterate on drag mechanics/locators; don't fake a pass.

- [ ] **Step 3: Full gate + commit**
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
git add apps/web/tests/e2e/schedule-drag.spec.ts
git commit -m "test(web): e2e for drag reschedule + reassign + conflict-revert"
```

- [ ] **Step 4: Whole-branch checks**
- `pnpm typecheck && pnpm lint && pnpm test` green; the Slice A `schedule`/`scheduling` e2e still pass (drag is additive — clicking a block/card still opens the popover via the 5px activation distance; verify in one of the runs).
- `git log --oneline feat/schedule-calendar..HEAD` shows the spec + plan + 5 task commits; no stray worktree commits / `\(app\)` dirs.
- PR base = `feat/schedule-calendar` (stacked) OR `main` once #31 merges. Note in the PR that it stacks on #31.

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| `zonedTimeToUtc` (tz inverse, round-trip incl. DST) | Task 1 |
| `applyDragToWeek` / `applyDragToMonth` (snap, duration, clamp) | Task 1 |
| `reassignAppointment` (mirrors reschedule conflict) + integration test | Task 2 |
| `reassignAction` (reason "reassigned") | Task 3 |
| ScheduleClient optimistic state + revert | Task 4 (step 1) |
| Week drag → reschedule (time+day) | Task 4 (step 2) |
| Month drag → reschedule (day) | Task 4 (step 3) |
| Crew drag → reassign (incl. null/unassigned) | Task 4 (step 4) |
| Click-to-open preserved (5px activation) | Task 4 (sensors) + Task 5 (verify) |
| e2e: reschedule, reassign, conflict-revert | Task 5 |
| Snap 30, optimistic+revert, no schema change | Tasks 1 + 4 (verified in final) |
