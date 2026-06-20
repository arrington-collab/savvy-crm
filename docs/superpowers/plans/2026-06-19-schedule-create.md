# Schedule Slice C — Click-to-Create — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a rep create an appointment by clicking an empty time slot in the schedule **Week** view, opening a pre-filled modal create form (job typeahead, type, optional crew, time, duration).

**Architecture:** Reuse the existing `bookAppointment` primitive and `zonedTimeToUtc` engine. Add one pure helper (`minutesFromOffset`), widen `bookAppointment` to allow a null assignee, add a thin tenant-scoped job-search query, a `createAppointmentAction`, a `CreateAppointmentForm` modal, and an empty-slot click handler on the Week grid. No schema migration.

**Tech Stack:** Next.js 16 (App Router, server actions), Drizzle/Postgres (RLS), `@dnd-kit` (existing), `@savvy/core` (pure engine, vitest), `@savvy/db` (integration, vitest), Playwright (apps/web e2e). `pnpm` + Turborepo.

**Spec:** `docs/superpowers/specs/2026-06-19-schedule-create-design.md`

**Gate (run from repo root, env exported):**
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Docker `savvy_db` must be running + migrated (`pnpm db:migrate`). **apps/web has no vitest** — web-layer pieces (query, action, components) are validated by typecheck/lint + the Playwright e2e (Task 7), not unit tests. Core (Task 1) and db (Task 2) are TDD.

---

## File Structure

| File | Responsibility | Task |
|------|----------------|------|
| `packages/core/src/schedule-view.ts` | add `minutesFromOffset` (pixel-Y → minute-of-day) | 1 |
| `packages/core/src/schedule-view.test.ts` | unit tests for `minutesFromOffset` | 1 |
| `packages/db/src/lifecycle/appointments.ts` | widen `BookInput.assigneeUserId` to `string \| null` | 2 |
| `packages/db/tests/create-appointment.test.ts` | integration: null-assignee book + no-overlap-on-null + isolation | 2 |
| `packages/db/src/index.ts` | re-export `ilike` from drizzle-orm | 3 |
| `apps/web/src/lib/schedule-create-queries.ts` | `searchSchedulableJobs(q)` (tenant-scoped) | 3 |
| `apps/web/src/lib/scheduling-actions.ts` | add `createAppointmentAction` | 4 |
| `apps/web/src/app/(app)/schedule/CreateAppointmentForm.tsx` | modal create form + job typeahead | 5 |
| `apps/web/src/app/(app)/schedule/WeekGrid.tsx` | empty-slot click → `onCreate`; block `stopPropagation` | 6 |
| `apps/web/src/app/(app)/schedule/ScheduleClient.tsx` | `createDraft` state; render `CreateAppointmentForm` | 6 |
| `apps/web/tests/e2e/schedule-create.spec.ts` | e2e: create / conflict / unassigned | 7 |

---

## Task 1: `minutesFromOffset` pure helper (`@savvy/core`)

**Files:**
- Modify: `packages/core/src/schedule-view.ts`
- Test: `packages/core/src/schedule-view.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/schedule-view.test.ts` (import `minutesFromOffset` — add it to the existing import from `"./schedule-view"` at the top of the file):

```ts
describe("minutesFromOffset", () => {
  // 6a–8p window = 360..1200 min over a 560px column.
  it("maps the very top to 6:00 (360)", () => {
    expect(minutesFromOffset(0, 560)).toBe(360);
  });
  it("snaps to the nearest 30 minutes", () => {
    // 280/560 = 50% → 360 + 0.5*840 = 780 (1:00pm), already a multiple of 30
    expect(minutesFromOffset(280, 560)).toBe(780);
    // a hair above the 11:00 line should snap back to 11:00 (660)
    expect(minutesFromOffset(205, 560)).toBe(660);
  });
  it("clamps the bottom so a 30-min appt still fits (max 19:30 = 1170)", () => {
    expect(minutesFromOffset(560, 560)).toBe(1170);
    expect(minutesFromOffset(99999, 560)).toBe(1170);
  });
  it("clamps negative offsets to the top", () => {
    expect(minutesFromOffset(-50, 560)).toBe(360);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @savvy/core test -- schedule-view`
Expected: FAIL — `minutesFromOffset is not a function` / not exported.

- [ ] **Step 3: Implement `minutesFromOffset`**

In `packages/core/src/schedule-view.ts`, add directly below the private `snap30` function (around line 187):

```ts
/** Inverse of the week grid's vertical positioning: a click offset within a day
 *  column (height px) → minute-of-day, snapped to 30, clamped so a 30-min appt
 *  fits inside the 6a–8p window. */
export function minutesFromOffset(offsetY: number, height: number): number {
  const raw = DAY_START_MIN + (offsetY / height) * SPAN_MIN;
  const snapped = snap30(raw);
  return Math.max(DAY_START_MIN, Math.min(snapped, DAY_END_MIN - 30));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @savvy/core test -- schedule-view`
Expected: PASS (all `minutesFromOffset` cases + existing schedule-view tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/schedule-view.ts packages/core/src/schedule-view.test.ts
git commit -m "feat(core): minutesFromOffset — click-Y to minute-of-day (Slice C)"
```

---

## Task 2: Allow a null assignee in `bookAppointment` (`@savvy/db`)

**Files:**
- Modify: `packages/db/src/lifecycle/appointments.ts:22-43`
- Test: `packages/db/tests/create-appointment.test.ts` (new)

- [ ] **Step 1: Write the failing integration test**

Create `packages/db/tests/create-appointment.test.ts`. Model the seed/isolation pattern on `packages/db/tests/reassign.test.ts` (read it first for the exact tenant/user/job seeding helpers it uses). The test must:

```ts
import { describe, it, expect } from "vitest";
import { bookAppointment, withTenant, appointment, eq } from "../src/index";
// reuse whatever seed helpers reassign.test.ts uses (e.g. a makeTenant/seedJob helper);
// if it inlines seeding, inline the same here.

describe("bookAppointment with a null assignee", () => {
  it("creates an unassigned scheduled appointment", async () => {
    const { tenantId, jobId, customerId } = await seedTenantWithJob(); // same helper style as reassign.test.ts
    const { id } = await bookAppointment({
      tenantId, jobId, customerId, type: "inspection", assigneeUserId: null,
      startsAt: new Date("2026-07-01T17:00:00Z"), endsAt: new Date("2026-07-01T18:00:00Z"),
    });
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(appointment).where(eq(appointment.id, id)));
    expect(row?.assigneeUserId).toBeNull();
    expect(row?.status).toBe("scheduled");
  });

  it("does NOT raise SlotTaken for two overlapping null-assignee appointments", async () => {
    const { tenantId, jobId, customerId } = await seedTenantWithJob();
    const at = { startsAt: new Date("2026-07-02T17:00:00Z"), endsAt: new Date("2026-07-02T18:00:00Z") };
    await bookAppointment({ tenantId, jobId, customerId, type: "inspection", assigneeUserId: null, ...at });
    // second overlapping unassigned booking must also succeed (null assignee → exclusion does not fire)
    await expect(
      bookAppointment({ tenantId, jobId, customerId, type: "inspection", assigneeUserId: null, ...at }),
    ).resolves.toBeTruthy();
  });
});
```

If `reassign.test.ts` does not expose a reusable `seedTenantWithJob`, copy its inline seeding into this file (a tenant via the admin path + a customer/property/job via `withTenant`). Keep it self-contained.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @savvy/db test -- create-appointment`
Expected: FAIL — TypeScript rejects `assigneeUserId: null` (current type is `string`), or the insert rejects null.

- [ ] **Step 3: Widen the type and insert**

In `packages/db/src/lifecycle/appointments.ts`, change `BookInput` (line ~22-26):

```ts
export type BookInput = {
  tenantId: string; jobId: string; customerId?: string;
  type: AppointmentType; assigneeUserId: string | null;
  startsAt: Date; endsAt: Date;
};
```

And in `bookAppointment`'s insert (line ~34), make the null explicit:

```ts
        type: input.type, assigneeUserId: input.assigneeUserId ?? null,
```

(The `appointment.assigneeUserId` column is already nullable; the per-crew `appointment_no_overlap` EXCLUDE constraint does not fire when the assignee key is null. Existing callers pass a non-null assignee, so they are unaffected.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @savvy/db test -- create-appointment`
Expected: PASS (both cases).

- [ ] **Step 5: Confirm existing appointment tests still pass**

Run: `pnpm --filter @savvy/db test -- appointments reassign`
Expected: PASS (no regression in book/reschedule/reassign).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/appointments.ts packages/db/tests/create-appointment.test.ts
git commit -m "feat(db): bookAppointment accepts a null assignee (Slice C)"
```

---

## Task 3: Job-search query (`searchSchedulableJobs`)

**Files:**
- Modify: `packages/db/src/index.ts:27` (re-export `ilike`)
- Create: `apps/web/src/lib/schedule-create-queries.ts`

- [ ] **Step 1: Re-export `ilike` from `@savvy/db`**

In `packages/db/src/index.ts` line 27, add `ilike` to the drizzle-orm re-export:

```ts
export { eq, and, or, not, sql, count, desc, asc, inArray, isNull, isNotNull, lt, gte, lte, gt, ilike } from "drizzle-orm";
```

- [ ] **Step 2: Create the query**

Create `apps/web/src/lib/schedule-create-queries.ts` (thin tenant-scoped read, same shape as `leads-queries.ts` — RLS enforces isolation):

```ts
import "server-only";
import { withTenant, job, customer, property, eq, or, ilike, desc } from "@savvy/db";
import { getTenantId } from "./tenant";

export type SchedulableJob = {
  jobId: string;
  customerId: string;
  customerName: string;
  address: string | null;
};

/** Search active jobs by customer name or property address for the create-appointment
 *  picker. Returns up to 10, most recent first. Blank/short queries return []. */
export async function searchSchedulableJobs(q: string): Promise<SchedulableJob[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const tenantId = await getTenantId();
  const pattern = `%${term}%`;
  return withTenant(tenantId, (tx) =>
    tx
      .select({
        jobId: job.id,
        customerId: job.customerId,
        customerName: customer.name,
        address: property.address,
      })
      .from(job)
      // innerJoin customer (job.customerId is NOT NULL) → customerName types as string;
      // leftJoin property tolerates a missing row → address is string | null.
      .innerJoin(customer, eq(customer.id, job.customerId))
      .leftJoin(property, eq(property.id, job.propertyId))
      .where(or(ilike(customer.name, pattern), ilike(property.address, pattern)))
      .orderBy(desc(job.createdAt))
      .limit(10),
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no type errors; `ilike` resolves from `@savvy/db`).

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/index.ts apps/web/src/lib/schedule-create-queries.ts
git commit -m "feat(web): searchSchedulableJobs query + ilike export (Slice C)"
```

---

## Task 4: `createAppointmentAction` server action

**Files:**
- Modify: `apps/web/src/lib/scheduling-actions.ts`

- [ ] **Step 1: Add the action**

In `apps/web/src/lib/scheduling-actions.ts`:

1. Extend the imports from `@savvy/db` to add `bookAppointment, withTenant, job, eq`, and import the query (a `"use server"` module CAN import a `server-only` one):

```ts
import {
  rescheduleAppointment, cancelAppointment, setAppointmentStatus, SlotTakenError, reassignAppointment,
  bookAppointment, withTenant, job, eq,
} from "@savvy/db";
import type { AppointmentType } from "@savvy/core";
import { searchSchedulableJobs, type SchedulableJob } from "./schedule-create-queries";
```

2. Add a client-callable search wrapper (a client component cannot import the `server-only` query directly, so it calls this action instead) and re-export the row type:

```ts
export type { SchedulableJob };

export async function searchJobsAction(q: string): Promise<SchedulableJob[]> {
  return searchSchedulableJobs(q);
}
```

3. Append the create action at the end of the file:

```ts
export async function createAppointmentAction(input: {
  jobId: string;
  type: AppointmentType;
  assigneeUserId: string | null;
  startsAt: string;
  endsAt: string;
}): Promise<{ ok: true } | { error: "slot_taken" }> {
  const tenantId = await getTenantId();
  // Resolve the customer from the job (tenant-scoped) so reminders can look up phone/email.
  const customerId = await withTenant(tenantId, async (tx) => {
    const [j] = await tx.select({ customerId: job.customerId }).from(job).where(eq(job.id, input.jobId));
    return j?.customerId;
  });
  let appointmentId: string;
  try {
    const created = await bookAppointment({
      tenantId, jobId: input.jobId, customerId,
      type: input.type, assigneeUserId: input.assigneeUserId,
      startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt),
    });
    appointmentId = created.id;
  } catch (e) {
    if (e instanceof SlotTakenError) return { error: "slot_taken" as const };
    throw e;
  }
  try { await inngest.send({ name: "appointment/booked", data: { appointmentId, tenantId } }); }
  catch (e) { console.error("inngest.send failed", e); }
  revalidatePath("/schedule");
  return { ok: true as const };
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/scheduling-actions.ts
git commit -m "feat(web): createAppointmentAction + searchJobsAction wrapper (Slice C)"
```

---

## Task 5: `CreateAppointmentForm` modal component

**Files:**
- Create: `apps/web/src/app/(app)/schedule/CreateAppointmentForm.tsx`

- [ ] **Step 1: Create the component**

Create `apps/web/src/app/(app)/schedule/CreateAppointmentForm.tsx`. It mirrors `AppointmentPopover`'s modal shell. Props give the pre-filled start (`startLocal`, a `datetime-local` string), the tz, the crew list, and the per-type default durations.

```tsx
"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { APPOINTMENT_TYPE, type AppointmentType } from "@savvy/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createAppointmentAction, searchJobsAction, type SchedulableJob } from "@/lib/scheduling-actions";

type Crew = { id: string; name: string };

const DURATIONS = [30, 60, 90, 120, 480];
// Per-type default duration (matches parseSchedulingConfig DEFAULTS.types).
const TYPE_DEFAULT_MIN: Record<AppointmentType, number> = { inspection: 60, cm: 60, crew: 480 };

export function CreateAppointmentForm(props: {
  startLocal: string; // "YYYY-MM-DDTHH:mm" in tenant tz, prefilled from the clicked slot
  crew: Crew[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [pending, start] = useTransition();
  const [type, setType] = useState<AppointmentType>("inspection");
  const [assignee, setAssignee] = useState<string>(""); // "" = Unassigned
  const [startVal, setStartVal] = useState(props.startLocal);
  const [durationMin, setDurationMin] = useState(TYPE_DEFAULT_MIN.inspection);
  const [jobQuery, setJobQuery] = useState("");
  const [results, setResults] = useState<SchedulableJob[]>([]);
  const [picked, setPicked] = useState<SchedulableJob | null>(null);
  const [slotTaken, setSlotTaken] = useState(false);
  const [, startSearch] = useTransition();

  function onType(next: AppointmentType) {
    setType(next);
    setDurationMin(TYPE_DEFAULT_MIN[next]);
  }
  function onQuery(v: string) {
    setJobQuery(v);
    setPicked(null);
    startSearch(async () => setResults(await searchJobsAction(v)));
  }
  function submit() {
    if (!picked) return;
    setSlotTaken(false);
    const s = new Date(startVal);
    const e = new Date(s.getTime() + durationMin * 60_000);
    start(async () => {
      const r = await createAppointmentAction({
        jobId: picked.jobId, type, assigneeUserId: assignee || null,
        startsAt: s.toISOString(), endsAt: e.toISOString(),
      });
      if ("error" in r) { setSlotTaken(true); return; }
      toast.success("Appointment created");
      props.onCreated();
      props.onClose();
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.4)" }} onClick={props.onClose}>
      <div data-testid="create-appt-form" onClick={(e) => e.stopPropagation()} className="w-full max-w-sm space-y-3 rounded-xl p-4"
        style={{ background: "var(--surface-app)", border: "1px solid var(--border-panel)" }}>
        <div className="font-medium" style={{ color: "var(--text-primary)" }}>New appointment</div>

        {/* Job typeahead */}
        <div className="space-y-1">
          <Input data-testid="create-job-search" placeholder="Search customer or address…" value={picked ? picked.customerName : jobQuery}
            disabled={pending} onChange={(e) => onQuery(e.target.value)} className="text-sm" />
          {!picked && jobQuery.trim().length >= 2 ? (
            <div data-testid="create-job-results" className="max-h-40 overflow-auto rounded-md border" style={{ borderColor: "var(--border-panel)" }}>
              {results.map((j) => (
                <button key={j.jobId} data-testid="create-job-option" onClick={() => { setPicked(j); setResults([]); }}
                  className="block w-full px-2 py-1 text-left text-sm hover:bg-[var(--surface-panel)]" style={{ color: "var(--text-body)" }}>
                  {j.customerName}{j.address ? ` · ${j.address}` : ""}
                </button>
              ))}
              {results.length === 0 ? (
                <Link href="/leads/new" data-testid="create-new-lead" className="block px-2 py-1 text-sm text-accent-gold hover:underline">
                  + New lead
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex gap-2">
          <label className="flex-1 text-xs" style={{ color: "var(--text-muted)" }}>Type
            <select data-testid="create-type" value={type} onChange={(e) => onType(e.target.value as AppointmentType)}
              className="mt-0.5 w-full rounded-md border bg-transparent px-2 py-1 text-sm" style={{ borderColor: "var(--border-panel)", color: "var(--text-body)" }}>
              {APPOINTMENT_TYPE.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="flex-1 text-xs" style={{ color: "var(--text-muted)" }}>Crew
            <select data-testid="create-crew" value={assignee} onChange={(e) => setAssignee(e.target.value)}
              className="mt-0.5 w-full rounded-md border bg-transparent px-2 py-1 text-sm" style={{ borderColor: "var(--border-panel)", color: "var(--text-body)" }}>
              <option value="">Unassigned</option>
              {props.crew.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        </div>

        <div className="flex gap-2">
          <label className="flex-1 text-xs" style={{ color: "var(--text-muted)" }}>Start
            <Input type="datetime-local" data-testid="create-start" value={startVal} disabled={pending}
              onChange={(e) => { setStartVal(e.target.value); setSlotTaken(false); }} className="mt-0.5 text-sm" />
          </label>
          <label className="flex-1 text-xs" style={{ color: "var(--text-muted)" }}>Duration
            <select data-testid="create-duration" value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value))}
              className="mt-0.5 w-full rounded-md border bg-transparent px-2 py-1 text-sm" style={{ borderColor: "var(--border-panel)", color: "var(--text-body)" }}>
              {DURATIONS.map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
          </label>
        </div>

        {slotTaken ? <p className="text-xs text-destructive">That time is taken for this crew — pick another time or crew.</p> : null}

        <div className="flex items-center justify-between pt-1">
          <Button size="sm" variant="outline" onClick={props.onClose} disabled={pending}>Cancel</Button>
          <Button size="sm" data-testid="create-submit" disabled={pending || !picked} onClick={submit}>Create</Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. The component imports `createAppointmentAction`, `searchJobsAction`, and `type SchedulableJob` from the `"use server"` module `@/lib/scheduling-actions` (defined in Task 4) — never the `server-only` query module directly, which a client component cannot import.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/\(app\)/schedule/CreateAppointmentForm.tsx
git commit -m "feat(web): CreateAppointmentForm modal (Slice C)"
```

---

## Task 6: Wire the Week-grid empty-slot click

**Files:**
- Modify: `apps/web/src/app/(app)/schedule/WeekGrid.tsx`
- Modify: `apps/web/src/app/(app)/schedule/ScheduleClient.tsx`

- [ ] **Step 1: Add `onCreate` to `WeekGrid` and the column click**

In `WeekGrid.tsx`:

1. Import `minutesFromOffset`:

```ts
import { buildWeekView, applyDragToWeek, minutesFromOffset, type ScheduleAppt, type PositionedAppt, type WeekDay } from "@savvy/core";
```

2. In `WeekBlock`, stop the click from bubbling to the column (so clicking a block opens its popover, not the create form):

```tsx
    <button ref={setNodeRef} {...listeners} {...attributes} data-testid="appt-block"
      onClick={(e) => { e.stopPropagation(); onSelect(b); }}
```

3. Change `WeekCol` to accept and fire `onCreate`:

```tsx
function WeekCol({ day, onSelect, onCreate }: {
  day: WeekDay; onSelect: (a: ScheduleAppt) => void; onCreate: (date: string, minutes: number) => void;
}) {
  const { setNodeRef } = useDroppable({ id: day.date });
  return (
    <div ref={setNodeRef} data-testid={`week-col-${day.date}`} className="relative border-l" style={{ height: 560, borderColor: "var(--border-panel)" }}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onCreate(day.date, minutesFromOffset(e.clientY - rect.top, rect.height));
      }}>
      {day.blocks.map((b) => <WeekBlock key={b.id} b={b} onSelect={onSelect} />)}
    </div>
  );
}
```

4. Thread `onCreate` through `WeekGrid`'s signature and its `WeekCol` render:

```tsx
export function WeekGrid({ appts, anchor, tz, onSelect, onReschedule, onCreate }: {
  appts: ScheduleAppt[]; anchor: string; tz: string;
  onSelect: (a: ScheduleAppt) => void; onReschedule: (id: string, next: { startsAt: string; endsAt: string }) => void;
  onCreate: (date: string, minutes: number) => void;
}) {
```

and at the column render:

```tsx
          {view.days.map((d) => <WeekCol key={d.date} day={d} onSelect={onSelect} onCreate={onCreate} />)}
```

- [ ] **Step 2: Add `createDraft` state + render the form in `ScheduleClient`**

In `ScheduleClient.tsx`:

1. Add imports:

```ts
import { addWeeks, addMonths, toCivilDate, zonedTimeToUtc, type ScheduleAppt } from "@savvy/core";
import { CreateAppointmentForm } from "./CreateAppointmentForm";
import { useRouter } from "next/navigation";
```
(`useRouter` is already imported; keep one import. `zonedTimeToUtc` is the new addition to the existing `@savvy/core` import.)

2. Add state next to `selected`:

```ts
  const [createDraft, setCreateDraft] = useState<{ date: string; minutes: number } | null>(null);
```

3. Convert the draft's `{date, minutes}` to a `datetime-local` value in the tenant tz. Add this helper inside the component:

```ts
  function draftStartLocal(date: string, minutes: number): string {
    // zonedTimeToUtc gives the UTC instant for that wall-clock slot; render it back
    // as a tz-local "YYYY-MM-DDTHH:mm" for the datetime-local input.
    const iso = zonedTimeToUtc(date, minutes, props.tz);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: props.tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(iso));
    const g = (t: string) => parts.find((p) => p.type === t)!.value;
    return `${g("year")}-${g("month")}-${g("day")}T${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}`;
  }
```

4. Pass `onCreate` to `WeekGrid`:

```tsx
      {props.view === "week" && <WeekGrid appts={appts} anchor={props.anchor} tz={props.tz} onSelect={setSelected} onReschedule={onReschedule} onCreate={(date, minutes) => setCreateDraft({ date, minutes })} />}
```

5. Render the form near the popover at the bottom of the returned JSX:

```tsx
      {createDraft && (
        <CreateAppointmentForm
          startLocal={draftStartLocal(createDraft.date, createDraft.minutes)}
          crew={props.crew}
          onClose={() => setCreateDraft(null)}
          onCreated={() => router.refresh()}
        />
      )}
```

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Boot the app under TEST_MODE (per the spec's local-demo notes) and click an empty Week slot → the form opens with the start pre-filled. Skip if going straight to e2e.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/\(app\)/schedule/WeekGrid.tsx apps/web/src/app/\(app\)/schedule/ScheduleClient.tsx
git commit -m "feat(web): wire Week empty-slot click to the create form (Slice C)"
```

---

## Task 7: End-to-end test

**Files:**
- Create: `apps/web/tests/e2e/schedule-create.spec.ts`

Read `apps/web/tests/e2e/pipeline.spec.ts` (seeding via `withTenant`) and the existing `apps/web/tests/e2e/scheduling.spec.ts` / `schedule.spec.ts` (how they navigate `/schedule` and read the tenant file) before writing, to reuse the exact import surface and the `/tmp/savvy-e2e-tenant.json` pattern.

- [ ] **Step 1: Write the e2e**

Create `apps/web/tests/e2e/schedule-create.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, customer, property, job, user, bookAppointment, appointment, eq, and } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

// Anchor on a fixed future Monday so the week is deterministic and empty for our customer.
const ANCHOR = "2026-08-03"; // a Monday

async function seedJob(name: string, address: string) {
  return withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name, phone: "+15555550111" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address }).returning();
    const [j] = await tx.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead", valueEstimate: 1000000 }).returning();
    return { customerId: c!.id, jobId: j!.id };
  });
}

test("create: click an empty Week slot -> pick a job -> appointment is created", async ({ page }) => {
  const uniq = `Createtest ${Date.now()}`;
  await seedJob(uniq, "11 Create Way");

  await page.goto(`/schedule?view=week&anchor=${ANCHOR}`);
  // Click an empty area of Tuesday's column (mid-column => ~1pm, snapped).
  const col = page.locator(`[data-testid="week-col-2026-08-04"]`);
  await expect(col).toBeVisible();
  await col.click({ position: { x: 20, y: 280 } });

  const form = page.getByTestId("create-appt-form");
  await expect(form).toBeVisible();

  await page.getByTestId("create-job-search").fill(uniq);
  await page.getByTestId("create-job-option").first().click();
  await page.getByTestId("create-submit").click();

  // The new block shows up in the grid (customer name on the block).
  await expect(page.getByTestId("appt-block").filter({ hasText: uniq.split(" ")[0]! })).toBeVisible();

  // And it persisted as a scheduled appointment for this job.
  const { jobId } = await seedJobLookup(uniq);
  const rows = await withTenant(tenantId, (tx) => tx.select().from(appointment).where(and(eq(appointment.jobId, jobId), eq(appointment.status, "scheduled"))));
  expect(rows.length).toBeGreaterThan(0);
});

// helper: find the job we just seeded by customer name (the seed returns ids, but the
// create flow looked it up via search; re-find for the DB assertion).
async function seedJobLookup(name: string) {
  return withTenant(tenantId, async (tx) => {
    const [c] = await tx.select().from(customer).where(eq(customer.name, name));
    const [j] = await tx.select().from(job).where(eq(job.customerId, c!.id));
    return { jobId: j!.id };
  });
}

test("create: assigned crew that is busy shows an inline conflict and does not create", async ({ page }) => {
  const uniq = `Conflicttest ${Date.now()}`;
  const { jobId, customerId } = await seedJob(uniq, "22 Conflict Way");
  // a crew user + an existing scheduled appointment at 1:00–2:00pm local on Tue
  const crewId = await withTenant(tenantId, async (tx) => {
    const [u] = await tx.insert(user).values({ tenantId, name: `Busy Bee ${Date.now()}`, role: "crew" }).returning();
    return u!.id;
  });
  // 2026-08-04 13:00 America/Phoenix (UTC-7) = 20:00Z
  await bookAppointment({ tenantId, jobId, customerId, type: "inspection", assigneeUserId: crewId, startsAt: new Date("2026-08-04T20:00:00Z"), endsAt: new Date("2026-08-04T21:00:00Z") });

  await page.goto(`/schedule?view=week&anchor=${ANCHOR}`);
  await page.locator(`[data-testid="week-col-2026-08-04"]`).click({ position: { x: 20, y: 280 } }); // ~1pm
  await page.getByTestId("create-job-search").fill(uniq);
  await page.getByTestId("create-job-option").first().click();
  await page.getByTestId("create-crew").selectOption(crewId);
  await page.getByTestId("create-submit").click();

  await expect(page.getByText(/taken for this crew/i)).toBeVisible();
  await expect(page.getByTestId("create-appt-form")).toBeVisible(); // stays open
});

test("create: unassigned appointment always succeeds", async ({ page }) => {
  const uniq = `Unassigned ${Date.now()}`;
  await seedJob(uniq, "33 Open Way");

  await page.goto(`/schedule?view=week&anchor=${ANCHOR}`);
  await page.locator(`[data-testid="week-col-2026-08-05"]`).click({ position: { x: 20, y: 200 } });
  await page.getByTestId("create-job-search").fill(uniq);
  await page.getByTestId("create-job-option").first().click();
  // leave crew = Unassigned
  await page.getByTestId("create-submit").click();
  await expect(page.getByTestId("appt-block").filter({ hasText: uniq.split(" ")[0]! })).toBeVisible();
});
```

> **Implementer notes:**
> - Confirm the tenant tz is `America/Phoenix` (the spec's `getTenantTimezone` default). If `finance.timezone` differs for the e2e tenant, adjust the conflict appointment's UTC time so it lands on the clicked local slot.
> - The clicked Y (`280/560 = 50%` → ~13:00) must overlap the seeded busy 13:00–14:00 appt for the conflict test. If `minutesFromOffset` snapping puts it slightly off, nudge `y` so the created slot intersects the busy interval.
> - `seedJobLookup` exists only because `seedJob` runs in a different transaction; if you prefer, capture the `jobId` from the first `seedJob` return and skip the lookup.

- [ ] **Step 2: Run the e2e locally (full harness, mirrors CI)**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy AI_STUB_PORT=4010
lsof -ti:4010 | xargs kill -9 2>/dev/null; lsof -ti:8288 | xargs kill -9 2>/dev/null; lsof -ti:3000 | xargs kill -9 2>/dev/null
node apps/web/tests/e2e/ai-stub.mjs > /tmp/ai-stub.log 2>&1 &
npx --yes inngest-cli@latest dev -u http://localhost:3000/api/inngest --no-discovery > /tmp/inngest.log 2>&1 &
sleep 6
pnpm --filter @savvy/web exec tsx tests/e2e/create-tenant.ts
export TEST_TENANT_ID="$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)")"
pnpm --filter @savvy/web exec playwright test schedule-create.spec.ts
```
Expected: 3 passed. Kill the background procs afterward (`lsof -ti:4010,8288,3000 | xargs kill -9`).

- [ ] **Step 3: Re-run the existing schedule e2e (no regression on click-to-open / drag)**

```bash
pnpm --filter @savvy/web exec playwright test schedule.spec.ts scheduling.spec.ts
```
Expected: PASS (the new `stopPropagation` on blocks must not break the existing popover/drag specs).

- [ ] **Step 4: Commit**

```bash
git add apps/web/tests/e2e/schedule-create.spec.ts
git commit -m "test(web): e2e for click-to-create (create/conflict/unassigned) (Slice C)"
```

---

## Task 8: Full gate, final whole-branch review, PR

- [ ] **Step 1: Run the full gate**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Expected: typecheck 7/7, lint 0 errors, all unit/integration tests pass (core `minutesFromOffset` + db `create-appointment`).

- [ ] **Step 2: Final adversarial whole-branch review**

Review the full diff (`git diff main...feat/schedule-create`) for: tenant isolation on the new query/action; that `stopPropagation` did not regress drag or popover; that a `server-only` module is never imported by a client component (the `searchJobsAction` wrapper); that the conflict path returns `slot_taken` and the form stays open; that an unassigned create cannot conflict.

- [ ] **Step 3: Push + open PR (base main)**

```bash
git push -u origin feat/schedule-create
gh pr create --base main --title "Schedule Slice C: click-empty-slot → create appointment inline" --body "<summary + test plan; closes the 3-slice schedule upgrade>"
```

- [ ] **Step 4: Watch CI green, then merge (squash)**

```bash
gh pr checks <PR#> --watch
gh pr merge <PR#> --squash --delete-branch
```

---

## Self-Review (author)

**Spec coverage:**
- Week-only click-to-create → Tasks 1, 6, 7 ✅
- Typeahead job picker + "New lead" link → Task 5 (`create-job-results`, `create-new-lead`) ✅
- Optional assignee → Task 2 (db) + Task 5 ("Unassigned") + Task 7 (unassigned test) ✅
- `minutesFromOffset` pure + unit-tested → Task 1 ✅
- Reuse `bookAppointment` + `appointment/booked` + customerId-from-job → Task 4 ✅
- Job search tenant-scoped (RLS) → Task 3 ✅
- Conflict → inline error, form stays open → Task 5 + Task 7 ✅
- No migration → confirmed (Task 2 only widens a TS type) ✅
- Duration default per type (incl. crew 480) → Task 5 (`TYPE_DEFAULT_MIN`, `DURATIONS`) ✅

**Placeholder scan:** PR body in Task 8 is the only `<…>` — intentional (author writes it at PR time). No code placeholders.

**Type consistency:** `createAppointmentAction` signature matches between Task 4 (definition) and Task 5 (call site); `SchedulableJob` shape matches between Task 3 and Task 5; `onCreate(date, minutes)` matches between Task 6's WeekGrid and ScheduleClient; `minutesFromOffset(offsetY, height)` matches Task 1 and Task 6.

**Known implementer decision:** `server-only` import into a client component is resolved by the `searchJobsAction` wrapper (Task 5 implementer note) — the component imports the action, not the query module.
