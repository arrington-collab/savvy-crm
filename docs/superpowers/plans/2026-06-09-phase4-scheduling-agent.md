# Phase 4 — Scheduling Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the scheduling agent — availability-based appointment booking with provably-no-double-booking, one-way Google Calendar push, configurable durable reminders, and a `/schedule` UI.

**Architecture:** A pure-function availability engine in `@savvy/core` offers open slots; a Postgres `EXCLUDE` constraint is the race-safe backstop. Booking/reschedule/cancel run through transactional `@savvy/db` lifecycle helpers; calendar push and reminders are durable Inngest workflows (reusing the Phase 3 `sleep` + `cancelOn` idiom). Two events — `appointment/booked` and `appointment/changed` — drive the side effects.

**Tech Stack:** Next.js 16, Drizzle + Postgres (RLS + `btree_gist`), Inngest, Twilio/Resend (via Phase 3 senders), Nango (Google Calendar), Vitest + Playwright.

**Spec:** `docs/superpowers/specs/2026-06-09-phase4-scheduling-agent-design.md`

## Conventions (read once)
- Imports: drizzle operators + tables from `@savvy/db`; `z` from `@savvy/core`; senders from `@savvy/integrations`. **Never** import `drizzle-orm`/`zod` directly in source.
- **No `.js`** extensions on relative imports in SOURCE. In-package **db test files** DO use `.js` (matches `stop-drip.test.ts`).
- Every tenant DB access goes through `withTenant(tenantId, tx => …)`.
- DB env for any migrate/test run:
  ```bash
  export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
  export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
  ```
- Static gate after each task: `pnpm typecheck && pnpm lint && pnpm test`.

## File structure (created / modified)

| File | Responsibility |
|---|---|
| `packages/core/src/enums.ts` (M) | `APPOINTMENT_TYPE`, `APPOINTMENT_STATUS` + types |
| `packages/core/src/scheduling.ts` (C) | `parseSchedulingConfig`, `computeOpenSlots`, `haversineMeters`, types |
| `packages/core/src/comms.ts` (M) | drop `"cancel"` from stop-words; add `isCancelKeyword`; add `signPayloadToken`/`verifyPayloadToken` |
| `packages/core/src/index.ts` (M) | export `./scheduling` |
| `packages/db/src/schema/enums.ts` (M) | `appointmentTypeEnum`, `appointmentStatusEnum` |
| `packages/db/src/schema/comms.ts` (M) | appointment: enum cols, `customerId`, required `endsAt`; constraint comment |
| `packages/db/src/schema/tenancy.ts` (M) | `user.gcalConnectionId` |
| `packages/db/drizzle/0003_*.sql` (C) | generated migration + hand-added `btree_gist` + `EXCLUDE` |
| `packages/db/src/lifecycle/appointments.ts` (C) | `getBusyIntervals`, `bookAppointment`, `rescheduleAppointment`, `cancelAppointment`, `setAppointmentStatus`, `convertLeadToJob`, `SlotTakenError`, `NoAssigneeError` |
| `packages/db/tests/appointments.test.ts` (C) | exclusion constraint + lifecycle + RLS |
| `packages/integrations/src/gcal.ts` (C) | `CalendarSync` interface, `nangoGcal`, `makeFakeCalendarSync` |
| `packages/integrations/src/index.ts` (M) | export gcal |
| `packages/agents/src/client.ts` (M) | `appointment/booked`, `appointment/changed` events |
| `packages/agents/src/functions/appointment-calendar.ts` (C) | `appointmentCalendarSync` workflow |
| `packages/agents/src/functions/appointment-reminders.ts` (C) | `appointmentReminders` workflow |
| `packages/agents/src/functions/lead-intake.ts` (M) | SMS link → `/book/[token]`; `leadBooked` uses `convertLeadToJob`, no auto-appointment |
| `packages/agents/src/index.ts` (M) | register new workflows |
| `apps/web/src/lib/scheduling-queries.ts` (C) | read queries for `/schedule` + slot-picker |
| `apps/web/src/lib/scheduling-actions.ts` (C) | server actions (wrap lifecycle, emit events) |
| `apps/web/src/lib/inbound-sms.ts` (M) | CANCEL → cancel upcoming appointment |
| `apps/web/src/app/book/[token]/page.tsx` (C) | public slot-picker (book + reschedule) |
| `apps/web/src/app/(app)/schedule/page.tsx` (C) | internal agenda |
| `apps/web/src/app/(app)/settings/scheduling/*` (C) | hours/reminders builder + Connect Google |
| `apps/web/src/app/api/nango/connect/route.ts` (C) | Nango connect-session for Google Calendar |
| `apps/web/src/app/api/leads/[id]/book/route.ts` (D) | retired (replaced by slot-picker) |
| `packages/db/src/seed.ts` (M) | seed `tenant.settings.scheduling` |
| `apps/web/tests/e2e/scheduling.spec.ts` (C) | e2e: book → schedule → reschedule |
| `.env.example` (M) | `NANGO_SECRET_KEY`, `NANGO_HOST`, `NANGO_GCAL_INTEGRATION_ID` |

---

## Task 1: Appointment enums in `@savvy/core`

**Files:**
- Modify: `packages/core/src/enums.ts`
- Test: `packages/core/src/enums.test.ts`

- [ ] **Step 1: Write failing test** — append to `packages/core/src/enums.test.ts`:

```ts
import { APPOINTMENT_TYPE, APPOINTMENT_STATUS } from "./enums";

test("appointment enums", () => {
  expect(APPOINTMENT_TYPE).toEqual(["inspection", "cm", "crew"]);
  expect(APPOINTMENT_STATUS).toEqual(["scheduled", "done", "canceled", "no_show"]);
});
```

- [ ] **Step 2: Run, expect fail**

Run: `pnpm --filter @savvy/core exec vitest run enums`
Expected: FAIL — `APPOINTMENT_TYPE` is not exported.

- [ ] **Step 3: Implement** — append to `packages/core/src/enums.ts`:

```ts
// --- Phase 4 (scheduling) ---
export const APPOINTMENT_TYPE = ["inspection", "cm", "crew"] as const;
export const APPOINTMENT_STATUS = ["scheduled", "done", "canceled", "no_show"] as const;
export type AppointmentType = (typeof APPOINTMENT_TYPE)[number];
export type AppointmentStatus = (typeof APPOINTMENT_STATUS)[number];
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm --filter @savvy/core exec vitest run enums`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/enums.ts packages/core/src/enums.test.ts
git commit -m "feat(core): appointment type + status enums"
```

---

## Task 2: Scheduling config schema + `parseSchedulingConfig`

**Files:**
- Create: `packages/core/src/scheduling.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/scheduling.test.ts`

- [ ] **Step 1: Write failing test** — `packages/core/src/scheduling.test.ts`:

```ts
import { parseSchedulingConfig } from "./scheduling";

test("empty config yields safe defaults", () => {
  const c = parseSchedulingConfig(undefined);
  expect(c.slotGranularityMin).toBe(30);
  expect(c.bookingHorizonDays).toBe(14);
  expect(c.hours.mon).toEqual([8, 17]);
  expect(c.hours.sun).toEqual([]);
  expect(c.types.inspection).toEqual({ durationMin: 60, bufferMin: 30 });
  expect(c.reminders).toEqual([
    { offsetH: 24, channel: "sms" },
    { offsetH: 2, channel: "sms" },
  ]);
});

test("partial config merges over defaults", () => {
  const c = parseSchedulingConfig({ slotGranularityMin: 15, hours: { sat: [9, 12] } });
  expect(c.slotGranularityMin).toBe(15);
  expect(c.hours.sat).toEqual([9, 12]);
  expect(c.hours.mon).toEqual([8, 17]); // default kept
});
```

- [ ] **Step 2: Run, expect fail**

Run: `pnpm --filter @savvy/core exec vitest run scheduling`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `packages/core/src/scheduling.ts`:

```ts
import { z } from "./schemas";
import { APPOINTMENT_TYPE, type AppointmentType } from "./enums";
import { MESSAGE_CHANNEL } from "./enums";

// [openHour, closeHour] in local 24h; [] = closed that day.
const dayHours = z.union([z.tuple([z.number(), z.number()]), z.tuple([])]);
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Weekday = (typeof WEEKDAYS)[number];

const typeCfg = z.object({ durationMin: z.number().int().positive(), bufferMin: z.number().int().min(0) });
const reminderCfg = z.object({ offsetH: z.number().positive(), channel: z.enum(MESSAGE_CHANNEL) });

const DEFAULTS = {
  hours: { mon: [8, 17], tue: [8, 17], wed: [8, 17], thu: [8, 17], fri: [8, 17], sat: [], sun: [] },
  slotGranularityMin: 30,
  bookingHorizonDays: 14,
  types: {
    inspection: { durationMin: 60, bufferMin: 30 },
    cm: { durationMin: 60, bufferMin: 15 },
    crew: { durationMin: 480, bufferMin: 0 },
  },
  reminders: [
    { offsetH: 24, channel: "sms" },
    { offsetH: 2, channel: "sms" },
  ],
} as const;

const schema = z.object({
  hours: z.record(z.enum(WEEKDAYS), dayHours).default({}),
  slotGranularityMin: z.number().int().positive().default(DEFAULTS.slotGranularityMin),
  bookingHorizonDays: z.number().int().positive().default(DEFAULTS.bookingHorizonDays),
  types: z.record(z.enum(APPOINTMENT_TYPE), typeCfg).default({}),
  reminders: z.array(reminderCfg).default([...DEFAULTS.reminders]),
});

export type SchedulingConfig = {
  hours: Record<Weekday, number[]>;
  slotGranularityMin: number;
  bookingHorizonDays: number;
  types: Record<AppointmentType, { durationMin: number; bufferMin: number }>;
  reminders: { offsetH: number; channel: "sms" | "email" }[];
};

export function parseSchedulingConfig(raw: unknown): SchedulingConfig {
  const p = schema.parse(raw ?? {});
  return {
    hours: { ...DEFAULTS.hours, ...p.hours } as Record<Weekday, number[]>,
    slotGranularityMin: p.slotGranularityMin,
    bookingHorizonDays: p.bookingHorizonDays,
    types: { ...DEFAULTS.types, ...p.types } as SchedulingConfig["types"],
    reminders: p.reminders,
  };
}

export { WEEKDAYS };
export type { Weekday };
```

- [ ] **Step 4:** add to `packages/core/src/index.ts`: `export * from "./scheduling";`

- [ ] **Step 5: Run, expect pass**

Run: `pnpm --filter @savvy/core exec vitest run scheduling`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/scheduling.ts packages/core/src/scheduling.test.ts packages/core/src/index.ts
git commit -m "feat(core): scheduling config schema + defaults"
```

---

## Task 3: `haversineMeters`

**Files:**
- Modify: `packages/core/src/scheduling.ts`
- Test: `packages/core/src/scheduling.test.ts`

- [ ] **Step 1: Write failing test** — append:

```ts
import { haversineMeters } from "./scheduling";

test("haversine ~ known distance", () => {
  // ~1.11 km between 0,0 and 0.01,0
  const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 0.01, lng: 0 });
  expect(d).toBeGreaterThan(1090);
  expect(d).toBeLessThan(1130);
});
```

- [ ] **Step 2: Run, expect fail**

Run: `pnpm --filter @savvy/core exec vitest run scheduling`
Expected: FAIL — `haversineMeters` not exported.

- [ ] **Step 3: Implement** — append to `packages/core/src/scheduling.ts`:

```ts
export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm --filter @savvy/core exec vitest run scheduling`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scheduling.ts packages/core/src/scheduling.test.ts
git commit -m "feat(core): haversineMeters helper"
```

---

## Task 4: `computeOpenSlots` engine

**Files:**
- Modify: `packages/core/src/scheduling.ts`
- Test: `packages/core/src/scheduling.test.ts`

- [ ] **Step 1: Write failing tests** — append:

```ts
import { computeOpenSlots } from "./scheduling";

const cfg = parseSchedulingConfig({
  hours: { mon: [8, 10], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
  slotGranularityMin: 60,
  bookingHorizonDays: 1,
});
// A Monday 8am UTC reference.
const mon = new Date("2026-06-15T00:00:00Z"); // 2026-06-15 is a Monday

test("generates slots inside working hours, excludes past", () => {
  const slots = computeOpenSlots({
    config: cfg, type: "inspection",
    existingAppts: [], fromDate: mon, now: mon,
  });
  // inspection 60m + 30m buffer; 8-10 window -> only 8:00 fits (ends 9:00, +buffer 9:30 < 10) ; 9:00 ends 10:00 +buffer exceeds 10
  expect(slots.length).toBe(1);
  expect(slots[0]!.startsAt.toISOString()).toBe("2026-06-15T08:00:00.000Z");
});

test("removes slots overlapping an existing appt (incl. buffer)", () => {
  const slots = computeOpenSlots({
    config: cfg, type: "inspection",
    existingAppts: [{ startsAt: new Date("2026-06-15T08:00:00Z"), endsAt: new Date("2026-06-15T09:00:00Z") }],
    fromDate: mon, now: mon,
  });
  expect(slots.length).toBe(0);
});

test("proximity scoring ranks near-cluster slots higher", () => {
  const wideCfg = parseSchedulingConfig({
    hours: { mon: [8, 12] }, slotGranularityMin: 60, bookingHorizonDays: 1,
  });
  const slots = computeOpenSlots({
    config: wideCfg, type: "cm", // 60m + 15m buffer
    existingAppts: [{ startsAt: new Date("2026-06-15T11:00:00Z"), endsAt: new Date("2026-06-15T11:30:00Z"), lat: 33.4, lng: -112.0 }],
    fromDate: mon, now: mon,
    clusterAround: { lat: 33.4, lng: -112.0 },
  });
  // All returned slots carry a score; highest score first.
  expect(slots.length).toBeGreaterThan(0);
  for (let i = 1; i < slots.length; i++) expect(slots[i - 1]!.score).toBeGreaterThanOrEqual(slots[i]!.score);
});
```

- [ ] **Step 2: Run, expect fail**

Run: `pnpm --filter @savvy/core exec vitest run scheduling`
Expected: FAIL — `computeOpenSlots` not exported.

- [ ] **Step 3: Implement** — append to `packages/core/src/scheduling.ts`:

```ts
export type BusyInterval = { startsAt: Date; endsAt: Date; lat?: number; lng?: number };
export type Slot = { startsAt: Date; endsAt: Date; score: number };

const WD_INDEX: Record<number, Weekday> = { 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat", 0: "sun" };

export function computeOpenSlots(input: {
  config: SchedulingConfig;
  type: AppointmentType;
  existingAppts: BusyInterval[];
  fromDate: Date;
  now: Date;
  clusterAround?: { lat: number; lng: number };
}): Slot[] {
  const { config, type, existingAppts, fromDate, now, clusterAround } = input;
  const t = config.types[type];
  const slotMs = config.slotGranularityMin * 60_000;
  const durMs = t.durationMin * 60_000;
  const bufMs = t.bufferMin * 60_000;
  const out: Slot[] = [];

  for (let day = 0; day < config.bookingHorizonDays; day++) {
    const base = new Date(fromDate);
    base.setUTCDate(base.getUTCDate() + day);
    const wd = WD_INDEX[base.getUTCDay()]!;
    const hours = config.hours[wd];
    if (!hours || hours.length === 0) continue;
    const [openH, closeH] = hours as [number, number];

    const dayOpen = new Date(base); dayOpen.setUTCHours(openH, 0, 0, 0);
    const dayClose = new Date(base); dayClose.setUTCHours(closeH, 0, 0, 0);

    for (let start = dayOpen.getTime(); start + durMs <= dayClose.getTime(); start += slotMs) {
      const s = new Date(start);
      const e = new Date(start + durMs);
      if (s.getTime() < now.getTime()) continue;
      // Overlap check against existing appts, padded by buffer on both sides.
      const blocked = existingAppts.some((a) =>
        start - bufMs < a.endsAt.getTime() && a.startsAt.getTime() < start + durMs + bufMs,
      );
      if (blocked) continue;
      out.push({ startsAt: s, endsAt: e, score: 0 });
    }
  }

  // Proximity scoring: higher when near the day's existing cluster / target property.
  if (clusterAround) {
    for (const slot of out) {
      const sameDay = existingAppts.filter(
        (a) => a.lat != null && a.lng != null && a.startsAt.toDateString() === slot.startsAt.toDateString(),
      );
      const anchor = sameDay.length ? sameDay : (clusterAround ? [{ ...clusterAround, startsAt: slot.startsAt, endsAt: slot.endsAt } as BusyInterval] : []);
      if (!anchor.length) continue;
      const minMeters = Math.min(
        ...anchor.map((a) => haversineMeters({ lat: a.lat!, lng: a.lng! }, clusterAround)),
      );
      slot.score = 1 / (1 + minMeters / 1000); // 0..1, closer = higher
    }
  }

  return out.sort((a, b) => b.score - a.score || a.startsAt.getTime() - b.startsAt.getTime());
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm --filter @savvy/core exec vitest run scheduling`
Expected: PASS (3 new tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scheduling.ts packages/core/src/scheduling.test.ts
git commit -m "feat(core): computeOpenSlots availability engine"
```

---

## Task 5: Generic signed tokens + CANCEL keyword

**Files:**
- Modify: `packages/core/src/comms.ts`
- Test: `packages/core/src/comms.test.ts`

> The existing `STOP_WORDS` includes `"cancel"`. Phase 4 makes CANCEL appointment-specific, so we drop it from stop-words and add `isCancelKeyword`. STOP/UNSUBSCRIBE remain the compliant opt-out keywords.

- [ ] **Step 1: Write failing tests** — append to `packages/core/src/comms.test.ts`:

```ts
import { isStopKeyword, isCancelKeyword, signPayloadToken, verifyPayloadToken } from "./comms";

test("cancel is no longer an opt-out keyword", () => {
  expect(isStopKeyword("STOP")).toBe(true);
  expect(isStopKeyword("unsubscribe")).toBe(true);
  expect(isStopKeyword("cancel")).toBe(false);
});

test("isCancelKeyword matches CANCEL only", () => {
  expect(isCancelKeyword("CANCEL")).toBe(true);
  expect(isCancelKeyword(" cancel ")).toBe(true);
  expect(isCancelKeyword("stop")).toBe(false);
});

test("payload token round-trips and rejects tampering", () => {
  const secret = "s3cret";
  const tok = signPayloadToken({ appointmentId: "a1", tenantId: "t1", type: "inspection" }, secret);
  expect(verifyPayloadToken(tok, secret)).toEqual({ appointmentId: "a1", tenantId: "t1", type: "inspection" });
  expect(verifyPayloadToken(tok, "wrong")).toBeNull();
  expect(verifyPayloadToken("garbage", secret)).toBeNull();
});
```

- [ ] **Step 2: Run, expect fail**

Run: `pnpm --filter @savvy/core exec vitest run comms`
Expected: FAIL — `isCancelKeyword`/`signPayloadToken` not exported; `cancel` still stop-word.

- [ ] **Step 3: Implement** — in `packages/core/src/comms.ts`:

Change the stop-words set and add helpers:

```ts
const STOP_WORDS = new Set(["stop", "unsubscribe", "end", "quit"]); // 'cancel' removed (Phase 4)

/** True if the whole (trimmed) SMS body is the appointment-cancel keyword. */
export function isCancelKeyword(body: string): boolean {
  return body.trim().toLowerCase() === "cancel";
}

/** Generic signed, URL-safe token: `<base64url(json)>.<hmac>`. */
export function signPayloadToken(payload: Record<string, string>, secret: string): string {
  const json = JSON.stringify(payload);
  const data = Buffer.from(json).toString("base64url");
  const sig = createHmac("sha256", secret).update(data).digest().toString("base64url");
  return `${data}.${sig}`;
}

export function verifyPayloadToken<T = Record<string, string>>(token: string, secret: string): T | null {
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = createHmac("sha256", secret).update(data).digest().toString("base64url");
  if (expected !== sig) return null;
  try {
    return JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}
```

(Leave `signUnsubToken`/`verifyUnsubToken` untouched — the unsubscribe route still uses them.)

- [ ] **Step 4: Run, expect pass**

Run: `pnpm --filter @savvy/core exec vitest run comms`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/comms.ts packages/core/src/comms.test.ts
git commit -m "feat(core): generic signed tokens + CANCEL keyword (cancel out of opt-out set)"
```

---

## Task 6: Appointment schema changes

**Files:**
- Modify: `packages/db/src/schema/enums.ts`, `packages/db/src/schema/comms.ts`, `packages/db/src/schema/tenancy.ts`

> No standalone test here; verified by the migration + Task 7 integration test. Keep this task to schema edits only.

- [ ] **Step 1: Add enums** — in `packages/db/src/schema/enums.ts`:

```ts
import { /* …existing… */ APPOINTMENT_TYPE, APPOINTMENT_STATUS } from "@savvy/core";
export const appointmentTypeEnum = pgEnum("appointment_type", APPOINTMENT_TYPE);
export const appointmentStatusEnum = pgEnum("appointment_status", APPOINTMENT_STATUS);
```

- [ ] **Step 2: Update `appointment` table** — in `packages/db/src/schema/comms.ts`, change the import line to add the enums and `customer`, then replace the `appointment` definition:

```ts
import { appointmentTypeEnum, appointmentStatusEnum, /* …existing… */ } from "./enums";
// customer is already imported in this file.

export const appointment = pgTable("appointment", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  customerId: uuid("customer_id").references(() => customer.id),
  type: appointmentTypeEnum("type").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  assigneeUserId: uuid("assignee_user_id").references(() => user.id),
  status: appointmentStatusEnum("status").notNull().default("scheduled"),
  gcalEventId: text("gcal_event_id"),
  createdAt: createdAt(),
  // NOTE: a Postgres EXCLUDE constraint (appointment_no_overlap) enforcing
  // no overlapping 'scheduled' appts per assignee is added by hand in
  // migration 0003 (drizzle-kit can't express EXCLUDE). See plan Task 7.
}, (t) => [index("appt_tenant_job_idx").on(t.tenantId, t.jobId), tenantIsolation()]);
```

- [ ] **Step 3: Add `gcalConnectionId` to `user`** — in `packages/db/src/schema/tenancy.ts`, add to the `user` table columns:

```ts
gcalConnectionId: text("gcal_connection_id"),
```

(Ensure `text` is imported in that file.)

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @savvy/db typecheck`
Expected: PASS (no migration yet, just types).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/enums.ts packages/db/src/schema/comms.ts packages/db/src/schema/tenancy.ts
git commit -m "feat(db): appointment enums + customerId/endsAt + user.gcalConnectionId"
```

---

## Task 7: Migration 0003 (enums + exclusion constraint) + integration test

**Files:**
- Create: `packages/db/drizzle/0003_*.sql` (generated, then hand-edited)
- Create: `packages/db/tests/appointments.test.ts`

> ⚠️ The existing demo `appointment` rows from seed/e2e use the old `text` type/status. On local dev we reset the volume, so no data migration is needed. The migration must `CREATE EXTENSION btree_gist` and add the `EXCLUDE` constraint by hand.

- [ ] **Step 1: Generate migration**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm db:up
pnpm db:generate
```

Expected: a new `packages/db/drizzle/0003_*.sql` creating the two enums + altering `appointment`/`user`. If drizzle-kit prompts for a type-change strategy on `type`/`status`, choose to drop/re-add (local dev volume is disposable).

- [ ] **Step 2: Hand-add the constraint** — append to the generated `0003_*.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_no_overlap"
  EXCLUDE USING gist (
    assignee_user_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'scheduled');
```

- [ ] **Step 3: Reset + migrate**

```bash
docker compose down -v && docker compose up -d && sleep 3
pnpm db:migrate
```

Expected: migration applies cleanly; `appointment_no_overlap` exists.

- [ ] **Step 4: Write integration test** — `packages/db/tests/appointments.test.ts` (mirrors `stop-drip.test.ts`; uses `.js` imports + `savvy_app` connection helpers):

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { withTenant } from "../src/tenant.js";
import { appointment } from "../src/schema/comms.js";
import { eq } from "drizzle-orm";
import { makeTenant, makeUser, makeJobWithCustomer } from "./helpers.js"; // see note

describe("appointment exclusion constraint", () => {
  let tenantId: string, userId: string, jobId: string;
  beforeAll(async () => {
    ({ tenantId } = await makeTenant());
    ({ userId } = await makeUser(tenantId));
    ({ jobId } = await makeJobWithCustomer(tenantId));
  });

  it("rejects an overlapping scheduled appt for the same assignee", async () => {
    await withTenant(tenantId, (tx) => tx.insert(appointment).values({
      tenantId, jobId, type: "inspection", assigneeUserId: userId,
      startsAt: new Date("2026-07-01T15:00:00Z"), endsAt: new Date("2026-07-01T16:00:00Z"),
    }));
    await expect(
      withTenant(tenantId, (tx) => tx.insert(appointment).values({
        tenantId, jobId, type: "inspection", assigneeUserId: userId,
        startsAt: new Date("2026-07-01T15:30:00Z"), endsAt: new Date("2026-07-01T16:30:00Z"),
      })),
    ).rejects.toMatchObject({ code: "23P01" });
  });

  it("allows the same time for a DIFFERENT assignee", async () => {
    const { userId: other } = await makeUser(tenantId);
    await expect(
      withTenant(tenantId, (tx) => tx.insert(appointment).values({
        tenantId, jobId, type: "inspection", assigneeUserId: other,
        startsAt: new Date("2026-07-01T15:00:00Z"), endsAt: new Date("2026-07-01T16:00:00Z"),
      })),
    ).resolves.toBeDefined();
  });

  it("frees the slot when the blocking appt is canceled", async () => {
    await withTenant(tenantId, (tx) => tx.update(appointment)
      .set({ status: "canceled" })
      .where(eq(appointment.assigneeUserId, userId)));
    await expect(
      withTenant(tenantId, (tx) => tx.insert(appointment).values({
        tenantId, jobId, type: "inspection", assigneeUserId: userId,
        startsAt: new Date("2026-07-01T15:30:00Z"), endsAt: new Date("2026-07-01T16:30:00Z"),
      })),
    ).resolves.toBeDefined();
  });
});
```

> **Note on helpers:** if `packages/db/tests/helpers.ts` doesn't already exist with `makeTenant/makeUser/makeJobWithCustomer`, create it by extracting the row-creation pattern used in `lifecycle.test.ts`/`stop-drip.test.ts` (admin connection for tenant/user/customer/property/job setup). Keep it tiny and reused.

- [ ] **Step 5: Run, expect pass**

Run: `pnpm --filter @savvy/db exec vitest run appointments`
Expected: PASS (3 tests).

- [ ] **Step 6: Regenerate snapshot if needed + Commit**

```bash
git add packages/db/drizzle packages/db/tests/appointments.test.ts packages/db/tests/helpers.ts
git commit -m "feat(db): migration 0003 — appointment enums + no-overlap exclusion constraint"
```

---

## Task 8: Appointment lifecycle helpers

**Files:**
- Create: `packages/db/src/lifecycle/appointments.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/tests/appointments.test.ts` (extend)

- [ ] **Step 1: Write failing tests** — append to `packages/db/tests/appointments.test.ts`:

```ts
import {
  bookAppointment, rescheduleAppointment, cancelAppointment, setAppointmentStatus,
  getBusyIntervals, SlotTakenError,
} from "../src/lifecycle/appointments.js";

describe("appointment lifecycle", () => {
  let tenantId: string, userId: string, jobId: string;
  beforeAll(async () => {
    ({ tenantId } = await makeTenant());
    ({ userId } = await makeUser(tenantId));
    ({ jobId } = await makeJobWithCustomer(tenantId));
  });

  it("books, then rejects an overlapping book with SlotTakenError", async () => {
    const a = await bookAppointment({
      tenantId, jobId, type: "inspection", assigneeUserId: userId,
      startsAt: new Date("2026-08-01T15:00:00Z"), endsAt: new Date("2026-08-01T16:00:00Z"),
    });
    expect(a.id).toBeTruthy();
    await expect(bookAppointment({
      tenantId, jobId, type: "inspection", assigneeUserId: userId,
      startsAt: new Date("2026-08-01T15:30:00Z"), endsAt: new Date("2026-08-01T16:30:00Z"),
    })).rejects.toBeInstanceOf(SlotTakenError);
  });

  it("reschedule moves the appt and frees the old slot", async () => {
    const a = await bookAppointment({
      tenantId, jobId, type: "inspection", assigneeUserId: userId,
      startsAt: new Date("2026-08-02T15:00:00Z"), endsAt: new Date("2026-08-02T16:00:00Z"),
    });
    await rescheduleAppointment({ tenantId, appointmentId: a.id, startsAt: new Date("2026-08-02T17:00:00Z"), endsAt: new Date("2026-08-02T18:00:00Z") });
    const busy = await getBusyIntervals({ tenantId, assigneeUserId: userId, from: new Date("2026-08-02T00:00:00Z"), to: new Date("2026-08-03T00:00:00Z") });
    expect(busy.some((b) => b.startsAt.toISOString() === "2026-08-02T17:00:00.000Z")).toBe(true);
    expect(busy.some((b) => b.startsAt.toISOString() === "2026-08-02T15:00:00.000Z")).toBe(false);
  });

  it("cancel + setStatus update status", async () => {
    const a = await bookAppointment({
      tenantId, jobId, type: "cm", assigneeUserId: userId,
      startsAt: new Date("2026-08-03T15:00:00Z"), endsAt: new Date("2026-08-03T16:00:00Z"),
    });
    await cancelAppointment({ tenantId, appointmentId: a.id });
    await setAppointmentStatus({ tenantId, appointmentId: a.id, status: "no_show" }); // no-op-ish but exercises path
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `pnpm --filter @savvy/db exec vitest run appointments`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `packages/db/src/lifecycle/appointments.ts`:

```ts
import { withTenant } from "../tenant";
import { appointment } from "../schema/comms";
import { job } from "../schema/jobs";
import { property } from "../schema/crm";
import { lead, customer } from "../schema/crm";
import { jobTask } from "../schema/jobs"; // if needed; otherwise drop
import { eq, and } from "drizzle-orm";
import type { AppointmentType, AppointmentStatus } from "@savvy/core";

export class SlotTakenError extends Error {
  constructor() { super("slot_taken"); this.name = "SlotTakenError"; }
}
export class NoAssigneeError extends Error {
  constructor() { super("no_assignee"); this.name = "NoAssigneeError"; }
}

function isExclusionViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23P01";
}

export type BookInput = {
  tenantId: string; jobId: string; customerId?: string;
  type: AppointmentType; assigneeUserId: string;
  startsAt: Date; endsAt: Date;
};

export async function bookAppointment(input: BookInput): Promise<{ id: string }> {
  const { tenantId } = input;
  try {
    return await withTenant(tenantId, async (tx) => {
      const [row] = await tx.insert(appointment).values({
        tenantId, jobId: input.jobId, customerId: input.customerId ?? null,
        type: input.type, assigneeUserId: input.assigneeUserId,
        startsAt: input.startsAt, endsAt: input.endsAt, status: "scheduled",
      }).returning({ id: appointment.id });
      return { id: row!.id };
    });
  } catch (e) {
    if (isExclusionViolation(e)) throw new SlotTakenError();
    throw e;
  }
}

export async function rescheduleAppointment(input: {
  tenantId: string; appointmentId: string; startsAt: Date; endsAt: Date; assigneeUserId?: string;
}): Promise<void> {
  try {
    await withTenant(input.tenantId, (tx) => tx.update(appointment).set({
      startsAt: input.startsAt, endsAt: input.endsAt,
      ...(input.assigneeUserId ? { assigneeUserId: input.assigneeUserId } : {}),
    }).where(and(eq(appointment.id, input.appointmentId), eq(appointment.status, "scheduled"))));
  } catch (e) {
    if (isExclusionViolation(e)) throw new SlotTakenError();
    throw e;
  }
}

export async function cancelAppointment(input: { tenantId: string; appointmentId: string }): Promise<void> {
  await withTenant(input.tenantId, (tx) => tx.update(appointment)
    .set({ status: "canceled" })
    .where(eq(appointment.id, input.appointmentId)));
}

export async function setAppointmentStatus(input: {
  tenantId: string; appointmentId: string; status: AppointmentStatus;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) => tx.update(appointment)
    .set({ status: input.status })
    .where(eq(appointment.id, input.appointmentId)));
}

export type BusyInterval = { startsAt: Date; endsAt: Date; lat?: number; lng?: number };

export async function getBusyIntervals(input: {
  tenantId: string; assigneeUserId: string; from: Date; to: Date;
}): Promise<BusyInterval[]> {
  return withTenant(input.tenantId, async (tx) => {
    const rows = await tx
      .select({ startsAt: appointment.startsAt, endsAt: appointment.endsAt, lat: property.lat, lng: property.lng })
      .from(appointment)
      .leftJoin(job, eq(appointment.jobId, job.id))
      .leftJoin(property, eq(job.propertyId, property.id))
      .where(and(
        eq(appointment.assigneeUserId, input.assigneeUserId),
        eq(appointment.status, "scheduled"),
      ));
    return rows
      .filter((r) => r.startsAt >= input.from && r.startsAt < input.to)
      .map((r) => ({
        startsAt: r.startsAt, endsAt: r.endsAt,
        lat: r.lat == null ? undefined : Number(r.lat),
        lng: r.lng == null ? undefined : Number(r.lng),
      }));
  });
}

/**
 * Converts a lead to a job if not already converted (idempotent). Returns the
 * jobId + customerId. Extracted from the former leadBooked workflow so the
 * booking action can call it synchronously at the moment of booking.
 */
export async function convertLeadToJob(_args: { tenantId: string; leadId: string }): Promise<{ jobId: string; customerId: string }> {
  throw new Error("implemented in Task 14 refactor");
}
```

> The `convertLeadToJob` body is fleshed out in **Task 14** (it needs `seedJobTasks`/`recordStageChange`, which live in lifecycle already). Leave the stub throwing here so this task stays focused on the appointment helpers; Task 14 replaces it and wires it into both `leadBooked` and the booking action. Remove the unused `jobTask`/`lead`/`customer` imports if the linter complains until Task 14.

- [ ] **Step 4: Export** — add to `packages/db/src/index.ts`:

```ts
export {
  bookAppointment, rescheduleAppointment, cancelAppointment, setAppointmentStatus,
  getBusyIntervals, convertLeadToJob, SlotTakenError, NoAssigneeError,
} from "./lifecycle/appointments";
```

- [ ] **Step 5: Run, expect pass**

Run: `pnpm --filter @savvy/db exec vitest run appointments`
Expected: PASS (lifecycle tests; `convertLeadToJob` is not exercised by these tests).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/appointments.ts packages/db/src/index.ts packages/db/tests/appointments.test.ts
git commit -m "feat(db): appointment lifecycle helpers (book/reschedule/cancel/status/busy)"
```

---

## Task 9: Google Calendar integration (Nango wrapper)

**Files:**
- Create: `packages/integrations/src/gcal.ts`
- Modify: `packages/integrations/src/index.ts`, `.env.example`
- Test: `packages/integrations/src/gcal.test.ts`

> `@savvy/integrations` has no `test` script wired (per handoff). Add one if missing (`"test": "vitest run"`) OR rely on the agents-package tests that import the fake. Simplest: add the script so this unit test runs.

- [ ] **Step 1: Write failing test** — `packages/integrations/src/gcal.test.ts`:

```ts
import { makeFakeCalendarSync } from "./gcal";

test("fake calendar records create/patch/delete calls", async () => {
  const fake = makeFakeCalendarSync();
  const { eventId } = await fake.createEvent({ connectionId: "c1", summary: "Inspection", startsAt: new Date(), endsAt: new Date() });
  expect(eventId).toMatch(/^fake-/);
  await fake.patchEvent({ connectionId: "c1", eventId, startsAt: new Date(), endsAt: new Date() });
  await fake.deleteEvent({ connectionId: "c1", eventId });
  expect(fake.calls.map((c) => c.op)).toEqual(["create", "patch", "delete"]);
});
```

- [ ] **Step 2: Run, expect fail**

Run: `pnpm --filter @savvy/integrations exec vitest run gcal`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `packages/integrations/src/gcal.ts`:

```ts
export interface CalendarSync {
  createEvent(o: { connectionId: string; summary: string; description?: string; startsAt: Date; endsAt: Date }): Promise<{ eventId: string }>;
  patchEvent(o: { connectionId: string; eventId: string; summary?: string; startsAt: Date; endsAt: Date }): Promise<void>;
  deleteEvent(o: { connectionId: string; eventId: string }): Promise<void>;
}

// Real impl talks to Google Calendar through Nango's proxy. Kept thin; the
// connectionId is the per-user Nango connection (stored on user.gcalConnectionId).
export const nangoGcal: CalendarSync = {
  async createEvent({ connectionId, summary, description, startsAt, endsAt }) {
    const res = await nangoProxy(connectionId, "POST", "/calendar/v3/calendars/primary/events", {
      summary, description, start: { dateTime: startsAt.toISOString() }, end: { dateTime: endsAt.toISOString() },
    });
    return { eventId: (res as { id: string }).id };
  },
  async patchEvent({ connectionId, eventId, summary, startsAt, endsAt }) {
    await nangoProxy(connectionId, "PATCH", `/calendar/v3/calendars/primary/events/${eventId}`, {
      ...(summary ? { summary } : {}), start: { dateTime: startsAt.toISOString() }, end: { dateTime: endsAt.toISOString() },
    });
  },
  async deleteEvent({ connectionId, eventId }) {
    await nangoProxy(connectionId, "DELETE", `/calendar/v3/calendars/primary/events/${eventId}`);
  },
};

async function nangoProxy(connectionId: string, method: string, endpoint: string, body?: unknown): Promise<unknown> {
  const host = process.env.NANGO_HOST ?? "https://api.nango.dev";
  const integrationId = process.env.NANGO_GCAL_INTEGRATION_ID ?? "google-calendar";
  const res = await fetch(`${host}/proxy${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NANGO_SECRET_KEY ?? ""}`,
      "Connection-Id": connectionId,
      "Provider-Config-Key": integrationId,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`nango proxy ${method} ${endpoint} -> ${res.status}`);
  return method === "DELETE" ? undefined : res.json();
}

export function makeFakeCalendarSync(): CalendarSync & { calls: { op: string; eventId?: string }[] } {
  const calls: { op: string; eventId?: string }[] = [];
  let n = 0;
  return {
    calls,
    async createEvent() { const eventId = `fake-${++n}`; calls.push({ op: "create", eventId }); return { eventId }; },
    async patchEvent({ eventId }) { calls.push({ op: "patch", eventId }); },
    async deleteEvent({ eventId }) { calls.push({ op: "delete", eventId }); },
  };
}
```

- [ ] **Step 4: Export + env** — add to `packages/integrations/src/index.ts`:

```ts
export { nangoGcal, makeFakeCalendarSync, type CalendarSync } from "./gcal";
```

Append to `.env.example`:

```
# Nango (Google Calendar one-way push) — Phase 4
NANGO_SECRET_KEY=
NANGO_HOST=https://api.nango.dev
NANGO_GCAL_INTEGRATION_ID=google-calendar
```

- [ ] **Step 5: Run, expect pass**

Run: `pnpm --filter @savvy/integrations exec vitest run gcal`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/integrations/src/gcal.ts packages/integrations/src/index.ts packages/integrations/package.json .env.example
git commit -m "feat(integrations): Nango Google Calendar wrapper + fake"
```

---

## Task 10: Scheduling events on the Inngest client

**Files:**
- Modify: `packages/agents/src/client.ts`

- [ ] **Step 1: Add events** — in the `Events` type:

```ts
"appointment/booked": { data: { appointmentId: string; tenantId: string } };
"appointment/changed": {
  data: {
    appointmentId: string; tenantId: string;
    reason: "rescheduled" | "reassigned" | "canceled" | "done" | "no_show";
    prevAssigneeUserId?: string;
  };
};
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @savvy/agents typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/client.ts
git commit -m "feat(agents): appointment/booked + appointment/changed events"
```

---

## Task 11: `appointmentCalendarSync` workflow

**Files:**
- Create: `packages/agents/src/functions/appointment-calendar.ts`
- Modify: `packages/agents/src/index.ts`
- Test: `packages/agents/src/functions/appointment-calendar.test.ts`

> Extract the side-effect logic into a pure, injectable `syncCalendarForAppointment(appt, user, deps)` so it can be unit-tested without Inngest (mirrors how `sendDripStep` is tested independent of `dripRun`).

- [ ] **Step 1: Write failing tests** — `packages/agents/src/functions/appointment-calendar.test.ts`:

```ts
import { syncCalendarForAppointment } from "./appointment-calendar";
import { makeFakeCalendarSync } from "@savvy/integrations";

const baseAppt = { id: "a1", gcalEventId: null as string | null, type: "inspection", startsAt: new Date(), endsAt: new Date(), status: "scheduled" };

test("create when assignee connected and no existing event", async () => {
  const cal = makeFakeCalendarSync();
  const out = await syncCalendarForAppointment(
    { event: "appointment/booked", appt: baseAppt, connectionId: "c1" }, { cal },
  );
  expect(out).toEqual({ op: "created", eventId: "fake-1" });
  expect(cal.calls[0]!.op).toBe("create");
});

test("no-op when assignee has no connection", async () => {
  const cal = makeFakeCalendarSync();
  const out = await syncCalendarForAppointment(
    { event: "appointment/booked", appt: baseAppt, connectionId: null }, { cal },
  );
  expect(out).toEqual({ op: "skipped" });
  expect(cal.calls).toHaveLength(0);
});

test("changed->canceled deletes the event", async () => {
  const cal = makeFakeCalendarSync();
  const out = await syncCalendarForAppointment(
    { event: "appointment/changed", reason: "canceled", appt: { ...baseAppt, gcalEventId: "ev9", status: "canceled" }, connectionId: "c1" }, { cal },
  );
  expect(out).toEqual({ op: "deleted" });
  expect(cal.calls[0]!.op).toBe("delete");
});

test("changed->rescheduled patches existing, creates if missing", async () => {
  const cal = makeFakeCalendarSync();
  await syncCalendarForAppointment({ event: "appointment/changed", reason: "rescheduled", appt: { ...baseAppt, gcalEventId: "ev9" }, connectionId: "c1" }, { cal });
  expect(cal.calls[0]!.op).toBe("patch");
});
```

- [ ] **Step 2: Run, expect fail**

Run: `pnpm --filter @savvy/agents exec vitest run appointment-calendar`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `packages/agents/src/functions/appointment-calendar.ts`:

```ts
import { withTenant, eq, appointment, user as userTbl } from "@savvy/db";
import { nangoGcal, type CalendarSync } from "@savvy/integrations";
import { inngest } from "../client";

type ApptLite = { id: string; gcalEventId: string | null; type: string; startsAt: Date; endsAt: Date; status: string };

export async function syncCalendarForAppointment(
  input:
    | { event: "appointment/booked"; appt: ApptLite; connectionId: string | null }
    | { event: "appointment/changed"; reason: "rescheduled" | "reassigned" | "canceled" | "done" | "no_show"; appt: ApptLite; connectionId: string | null },
  deps: { cal: CalendarSync },
): Promise<{ op: "created" | "patched" | "deleted" | "skipped"; eventId?: string }> {
  const { appt, connectionId } = input;
  if (!connectionId) return { op: "skipped" };
  const summary = `${appt.type} appointment`;

  if (input.event === "appointment/changed" && (input.reason === "canceled" || input.reason === "no_show" || input.reason === "done")) {
    if (!appt.gcalEventId) return { op: "skipped" };
    await deps.cal.deleteEvent({ connectionId, eventId: appt.gcalEventId });
    return { op: "deleted" };
  }
  if (appt.gcalEventId) {
    await deps.cal.patchEvent({ connectionId, eventId: appt.gcalEventId, summary, startsAt: appt.startsAt, endsAt: appt.endsAt });
    return { op: "patched", eventId: appt.gcalEventId };
  }
  const { eventId } = await deps.cal.createEvent({ connectionId, summary, startsAt: appt.startsAt, endsAt: appt.endsAt });
  return { op: "created", eventId };
}

export const appointmentCalendarSync = inngest.createFunction(
  { id: "appointment-calendar-sync", concurrency: { limit: 10 } },
  [{ event: "appointment/booked" }, { event: "appointment/changed" }],
  async ({ event, step }) => {
    const { appointmentId, tenantId } = event.data as { appointmentId: string; tenantId: string };
    const loaded = await step.run("load", () => withTenant(tenantId, async (tx) => {
      const [a] = await tx.select().from(appointment).where(eq(appointment.id, appointmentId));
      if (!a) return null;
      const [u] = a.assigneeUserId ? await tx.select().from(userTbl).where(eq(userTbl.id, a.assigneeUserId)) : [undefined];
      return { appt: { id: a.id, gcalEventId: a.gcalEventId, type: a.type, startsAt: a.startsAt, endsAt: a.endsAt, status: a.status }, connectionId: u?.gcalConnectionId ?? null };
    }));
    if (!loaded) return { skipped: true };

    const result = await step.run("sync", () =>
      syncCalendarForAppointment(
        event.name === "appointment/booked"
          ? { event: "appointment/booked", appt: loaded.appt, connectionId: loaded.connectionId }
          : { event: "appointment/changed", reason: (event.data as { reason: "rescheduled" | "reassigned" | "canceled" | "done" | "no_show" }).reason, appt: loaded.appt, connectionId: loaded.connectionId },
        { cal: nangoGcal },
      ),
    );

    if (result.op === "created" && result.eventId) {
      await step.run("store-event-id", () => withTenant(tenantId, (tx) =>
        tx.update(appointment).set({ gcalEventId: result.eventId! }).where(eq(appointment.id, appointmentId))));
    }
    return result;
  },
);
```

- [ ] **Step 4: Register** — in `packages/agents/src/index.ts` import + add `appointmentCalendarSync` to the exports and the `functions` array.

- [ ] **Step 5: Run, expect pass**

Run: `pnpm --filter @savvy/agents exec vitest run appointment-calendar`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/functions/appointment-calendar.ts packages/agents/src/functions/appointment-calendar.test.ts packages/agents/src/index.ts
git commit -m "feat(agents): appointmentCalendarSync workflow (best-effort GCal push)"
```

---

## Task 12: `appointmentReminders` workflow

**Files:**
- Create: `packages/agents/src/functions/appointment-reminders.ts`
- Modify: `packages/agents/src/index.ts`
- Test: `packages/agents/src/functions/appointment-reminders.test.ts`

> Reuses the Phase 3 drip pattern: triggers on `appointment/booked` OR `appointment/changed`; `cancelOn: appointment/changed` matched on `data.appointmentId`; guards at run start on status. Extract `buildReminderMessage(appt, offsetH, bookUrl)` as the pure unit under test.

- [ ] **Step 1: Write failing test** — `packages/agents/src/functions/appointment-reminders.test.ts`:

```ts
import { buildReminderMessage } from "./appointment-reminders";

test("sms reminder includes reschedule link + CANCEL hint", () => {
  const msg = buildReminderMessage({ type: "inspection", startsAt: new Date("2026-09-01T16:00:00Z") }, "https://x/book/tok", "sms");
  expect(msg.toLowerCase()).toContain("reschedule");
  expect(msg).toContain("https://x/book/tok");
  expect(msg.toUpperCase()).toContain("CANCEL");
});

test("email reminder includes link, no CANCEL reply hint", () => {
  const msg = buildReminderMessage({ type: "cm", startsAt: new Date("2026-09-01T16:00:00Z") }, "https://x/book/tok", "email");
  expect(msg).toContain("https://x/book/tok");
});
```

- [ ] **Step 2: Run, expect fail**

Run: `pnpm --filter @savvy/agents exec vitest run appointment-reminders`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `packages/agents/src/functions/appointment-reminders.ts`:

```ts
import { withTenant, eq, appointment, communication, customer as customerTbl, tenant as tenantTbl } from "@savvy/db";
import { parseSchedulingConfig, signPayloadToken } from "@savvy/core";
import { twilioSms, resendEmail } from "@savvy/integrations";
import { inngest } from "../client";

export function buildReminderMessage(
  appt: { type: string; startsAt: Date }, bookUrl: string, channel: "sms" | "email",
): string {
  const when = appt.startsAt.toUTCString();
  const base = `Reminder: your ${appt.type} appointment is at ${when}. Reschedule: ${bookUrl}`;
  return channel === "sms" ? `${base}  Reply CANCEL to cancel.` : base;
}

export const appointmentReminders = inngest.createFunction(
  {
    id: "appointment-reminders",
    concurrency: { limit: 20 },
    cancelOn: [{ event: "appointment/changed", match: "data.appointmentId" }],
  },
  [{ event: "appointment/booked" }, { event: "appointment/changed" }],
  async ({ event, step }) => {
    const { appointmentId, tenantId } = event.data as { appointmentId: string; tenantId: string };

    const ctx = await step.run("load", () => withTenant(tenantId, async (tx) => {
      const [a] = await tx.select().from(appointment).where(eq(appointment.id, appointmentId));
      if (!a || a.status !== "scheduled") return null; // guard: canceled/done -> no reminders
      const [t] = await tx.select().from(tenantTbl).where(eq(tenantTbl.id, tenantId));
      const cust = a.customerId ? (await tx.select().from(customerTbl).where(eq(customerTbl.id, a.customerId)))[0] : undefined;
      return {
        startsAt: a.startsAt, type: a.type, customerId: a.customerId,
        phone: cust?.phone ?? null, email: cust?.email ?? null,
        settings: (t?.settings as { scheduling?: unknown })?.scheduling,
      };
    }));
    if (!ctx) return { skipped: true };

    const cfg = parseSchedulingConfig(ctx.settings);
    const secret = process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret";
    const token = signPayloadToken({ appointmentId, tenantId, type: ctx.type }, secret);
    const bookUrl = `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/book/${token}`;

    // Sort reminders soonest-fire first (largest offset first).
    const reminders = [...cfg.reminders].sort((a, b) => b.offsetH - a.offsetH);
    for (const r of reminders) {
      const fireAt = new Date(ctx.startsAt.getTime() - r.offsetH * 3600_000);
      await step.sleepUntil(`wait-${r.offsetH}-${r.channel}`, fireAt);

      const stillScheduled = await step.run(`recheck-${r.offsetH}-${r.channel}`, () =>
        withTenant(tenantId, async (tx) => {
          const [a] = await tx.select().from(appointment).where(eq(appointment.id, appointmentId));
          return a?.status === "scheduled";
        }));
      if (!stillScheduled) return { stopped: true };

      await step.run(`send-${r.offsetH}-${r.channel}`, async () => {
        const body = buildReminderMessage({ type: ctx.type, startsAt: ctx.startsAt }, bookUrl, r.channel);
        const to = r.channel === "sms" ? ctx.phone : ctx.email;
        if (!to) return { sent: false };
        try {
          if (r.channel === "sms") await twilioSms.sendSms({ to, from: process.env.TWILIO_FROM ?? "+15555550000", body });
          else await resendEmail.sendEmail({ to, from: process.env.EMAIL_FROM ?? "noreply@example.com", subject: "Appointment reminder", html: body });
        } catch { /* fail-soft in dev/test (no creds) */ }
        await withTenant(tenantId, (tx) => tx.insert(communication).values({
          tenantId, customerId: ctx.customerId, channel: r.channel, direction: "outbound",
          to, body, aiHandled: false,
        }));
        return { sent: true };
      });
    }
    return { done: true };
  },
);
```

- [ ] **Step 4: Register** — add `appointmentReminders` to `packages/agents/src/index.ts` exports + `functions` array.

- [ ] **Step 5: Run, expect pass**

Run: `pnpm --filter @savvy/agents exec vitest run appointment-reminders`
Expected: PASS (the 2 `buildReminderMessage` tests; the workflow itself is covered by e2e in Task 20).

- [ ] **Step 6: Typecheck + Commit**

```bash
pnpm --filter @savvy/agents typecheck
git add packages/agents/src/functions/appointment-reminders.ts packages/agents/src/functions/appointment-reminders.test.ts packages/agents/src/index.ts
git commit -m "feat(agents): appointmentReminders durable workflow (configurable, self-cancelling)"
```

---

## Task 13: Scheduling queries + server actions (web)

**Files:**
- Create: `apps/web/src/lib/scheduling-queries.ts`, `apps/web/src/lib/scheduling-actions.ts`

> Pattern: mirror `comms-queries.ts` / `comms-actions.ts`. Actions resolve `getTenantId()`, call the `@savvy/db` lifecycle helpers, then best-effort `inngest.send` wrapped in try/catch (carrying the Phase 3 follow-up forward). No unit test (covered by e2e); keep functions thin.

- [ ] **Step 1: Implement queries** — `apps/web/src/lib/scheduling-queries.ts`:

```ts
import "server-only";
import { withTenant, appointment, job, property, customer, user, eq, and, desc } from "@savvy/db";
import { getTenantId } from "./tenant";

export async function listAppointments(filter?: { assigneeUserId?: string; type?: string }) {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) => {
    const wheres = [eq(appointment.tenantId, tenantId)];
    if (filter?.assigneeUserId) wheres.push(eq(appointment.assigneeUserId, filter.assigneeUserId));
    return tx.select({
      id: appointment.id, type: appointment.type, status: appointment.status,
      startsAt: appointment.startsAt, endsAt: appointment.endsAt,
      assigneeUserId: appointment.assigneeUserId,
      customerName: customer.name, address: property.address,
    })
      .from(appointment)
      .leftJoin(customer, eq(appointment.customerId, customer.id))
      .leftJoin(job, eq(appointment.jobId, job.id))
      .leftJoin(property, eq(job.propertyId, property.id))
      .where(and(...wheres))
      .orderBy(desc(appointment.startsAt));
  });
}

export async function listUsers() {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) => tx.select({ id: user.id, name: user.name }).from(user));
}
```

- [ ] **Step 2: Implement actions** — `apps/web/src/lib/scheduling-actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import {
  rescheduleAppointment, cancelAppointment, setAppointmentStatus, SlotTakenError,
} from "@savvy/db";
import { inngest } from "@savvy/agents";
import { getTenantId } from "./tenant";

async function emit(name: "appointment/changed", data: { appointmentId: string; tenantId: string; reason: "rescheduled" | "reassigned" | "canceled" | "done" | "no_show" }) {
  try { await inngest.send({ name, data }); } catch (e) { console.error("inngest.send failed", e); }
}

export async function rescheduleAction(appointmentId: string, startsAt: string, endsAt: string) {
  const tenantId = await getTenantId();
  try {
    await rescheduleAppointment({ tenantId, appointmentId, startsAt: new Date(startsAt), endsAt: new Date(endsAt) });
  } catch (e) {
    if (e instanceof SlotTakenError) return { error: "slot_taken" as const };
    throw e;
  }
  await emit("appointment/changed", { appointmentId, tenantId, reason: "rescheduled" });
  revalidatePath("/schedule");
  return { ok: true as const };
}

export async function cancelAction(appointmentId: string) {
  const tenantId = await getTenantId();
  await cancelAppointment({ tenantId, appointmentId });
  await emit("appointment/changed", { appointmentId, tenantId, reason: "canceled" });
  revalidatePath("/schedule");
  return { ok: true as const };
}

export async function markStatusAction(appointmentId: string, status: "done" | "no_show") {
  const tenantId = await getTenantId();
  await setAppointmentStatus({ tenantId, appointmentId, status });
  await emit("appointment/changed", { appointmentId, tenantId, reason: status });
  revalidatePath("/schedule");
  return { ok: true as const };
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @savvy/web typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/scheduling-queries.ts apps/web/src/lib/scheduling-actions.ts
git commit -m "feat(web): scheduling queries + reschedule/cancel/status actions"
```

---

## Task 14: Lead→job conversion refactor + booking action + retire demo route

**Files:**
- Modify: `packages/db/src/lifecycle/appointments.ts` (real `convertLeadToJob`)
- Modify: `packages/agents/src/functions/lead-intake.ts` (use helper, drop auto-appointment, new SMS link)
- Create: `apps/web/src/lib/booking-action.ts` (the slot-picker booking action)
- Delete: `apps/web/src/app/api/leads/[id]/book/route.ts`
- Modify: `apps/web/tests/e2e/lead-intake.spec.ts` (update to new flow)

- [ ] **Step 1: Implement real `convertLeadToJob`** — replace the stub in `packages/db/src/lifecycle/appointments.ts` (lift the logic from the former `leadBooked` step):

```ts
import { seedJobTasks } from "./seed-job-tasks";
import { recordStageChange } from "./record-stage-change";
import { stopDripEnrollments } from "./stop-drip";

export async function convertLeadToJob(args: { tenantId: string; leadId: string }): Promise<{ jobId: string; customerId: string }> {
  return withTenant(args.tenantId, async (tx) => {
    const [l] = await tx.select().from(lead).where(eq(lead.id, args.leadId));
    if (!l) throw new Error("lead not found");
    if (l.status === "booked") {
      const [existing] = await tx.select().from(job).where(eq(job.leadId, l.id));
      if (existing) return { jobId: existing.id, customerId: l.customerId! };
    }
    const [newJob] = await tx.insert(job).values({
      tenantId: args.tenantId, customerId: l.customerId!, propertyId: l.propertyId!,
      type: "retail", stage: "lead", leadId: l.id,
    }).returning();
    await seedJobTasks(tx as never, { id: newJob!.id, tenantId: args.tenantId, type: "retail" });
    await recordStageChange(tx, { tenantId: args.tenantId, jobId: newJob!.id, toStage: "inspected", byAgent: "orchestrator" });
    await tx.update(lead).set({ status: "booked" }).where(eq(lead.id, l.id));
    await stopDripEnrollments(tx, { tenantId: args.tenantId, customerId: l.customerId!, reason: "converted" });
    return { jobId: newJob!.id, customerId: l.customerId! };
  });
}
```

(This replaces the throwing Task 8 stub wholesale; the signature stays `convertLeadToJob({ tenantId, leadId })`. The `lead`/`job`/`property`/`customer`/`jobTask` imports stubbed in Task 8 are now actually used — keep the ones referenced here, drop any still unused.)

- [ ] **Step 2: Update `leadBooked`** — in `packages/agents/src/functions/lead-intake.ts`, the `leadBooked` function should now only convert (no appointment insert), since booking happens via the slot-picker. Replace its body:

```ts
export const leadBooked = inngest.createFunction(
  { id: "lead-booked" },
  { event: "lead/booked" },
  async ({ event, step }) => {
    const { leadId, tenantId } = event.data;
    const result = await step.run("convert", () => convertLeadToJob({ tenantId, leadId }));
    await step.run("emit-drip-stop", () =>
      inngest.send({ name: "drip/stop", data: { tenantId, customerId: result.customerId, reason: "converted" } }));
    return { jobId: result.jobId };
  },
);
```

Add `convertLeadToJob` to the `@savvy/db` import; remove now-unused `appointment`, `seedJobTasks`, `recordStageChange`, `stopDripEnrollments`, `job` imports if no longer referenced in the file.

- [ ] **Step 3: Update booking SMS link** — in `buildBookingSms`/the send step, point the URL at the slot-picker token instead of `/api/leads/[id]/book`. Build the token with the lead id:

```ts
import { signPayloadToken } from "@savvy/core";
// inside the step that builds the SMS:
const secret = process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret";
const token = signPayloadToken({ leadId, tenantId, type: "inspection" }, secret);
const bookingUrl = `${base}/book/${token}`;
```

- [ ] **Step 4: Booking action** — `apps/web/src/lib/booking-action.ts`:

```ts
"use server";
import { adminDb, lead, job, user, customer, property, eq, and,
  bookAppointment, rescheduleAppointment, convertLeadToJob, SlotTakenError, NoAssigneeError } from "@savvy/db";
import { verifyPayloadToken, parseSchedulingConfig, computeOpenSlots } from "@savvy/core";
import { inngest } from "@savvy/agents";

const SECRET = () => process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret";

type TokenPayload = { tenantId: string; type: "inspection" | "cm" | "crew"; leadId?: string; jobId?: string; appointmentId?: string };

export async function getSlotsForToken(token: string) {
  const p = verifyPayloadToken<TokenPayload>(token, SECRET());
  if (!p) return { error: "invalid" as const };
  // Resolve tenant settings + assignee + property via admin (the signed token is the auth).
  const cfg = parseSchedulingConfig(await loadSchedulingSettings(p.tenantId));
  const assignee = await resolveAssignee(p);
  if (!assignee) return { error: "no_assignee" as const };
  const busy = await loadBusy(p.tenantId, assignee.id, cfg.bookingHorizonDays);
  const cluster = await loadClusterPoint(p);
  const slots = computeOpenSlots({
    config: cfg, type: p.type, existingAppts: busy,
    fromDate: new Date(), now: new Date(), clusterAround: cluster ?? undefined,
  }).slice(0, 12);
  return { slots: slots.map((s) => ({ startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() })) };
}

export async function confirmSlot(token: string, startsAt: string, endsAt: string) {
  const p = verifyPayloadToken<TokenPayload>(token, SECRET());
  if (!p) return { error: "invalid" as const };
  try {
    if (p.appointmentId) {
      await rescheduleAppointment({ tenantId: p.tenantId, appointmentId: p.appointmentId, startsAt: new Date(startsAt), endsAt: new Date(endsAt) });
      await safeEmit({ appointmentId: p.appointmentId, tenantId: p.tenantId, reason: "rescheduled" });
      return { ok: true as const };
    }
    const assignee = await resolveAssignee(p);
    if (!assignee) return { error: "no_assignee" as const };
    const conv = p.leadId ? await convertLeadToJob({ tenantId: p.tenantId, leadId: p.leadId }) : null;
    const jobId = p.jobId ?? conv!.jobId;
    const customerId = conv?.customerId;
    const appt = await bookAppointment({
      tenantId: p.tenantId, jobId, customerId, type: p.type, assigneeUserId: assignee.id,
      startsAt: new Date(startsAt), endsAt: new Date(endsAt),
    });
    await safeEmitBooked({ appointmentId: appt.id, tenantId: p.tenantId });
    return { ok: true as const };
  } catch (e) {
    if (e instanceof SlotTakenError) return { error: "slot_taken" as const };
    if (e instanceof NoAssigneeError) return { error: "no_assignee" as const };
    throw e;
  }
}

async function safeEmit(data: { appointmentId: string; tenantId: string; reason: "rescheduled" }) {
  try { await inngest.send({ name: "appointment/changed", data }); } catch (e) { console.error(e); }
}
async function safeEmitBooked(data: { appointmentId: string; tenantId: string }) {
  try { await inngest.send({ name: "appointment/booked", data }); } catch (e) { console.error(e); }
}

// --- helpers (admin reads; token is the bearer) ---
async function loadSchedulingSettings(tenantId: string) {
  const { tenant } = await import("@savvy/db");
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
  return (t?.settings as { scheduling?: unknown })?.scheduling;
}
async function resolveAssignee(p: TokenPayload): Promise<{ id: string } | null> {
  if (p.leadId) {
    const [l] = await adminDb.select().from(lead).where(eq(lead.id, p.leadId));
    if (l?.assignedUserId) return { id: l.assignedUserId };
  }
  if (p.jobId) {
    const [j] = await adminDb.select().from(job).where(eq(job.id, p.jobId));
    if (j?.assignedUserId) return { id: j.assignedUserId };
  }
  if (p.appointmentId) {
    const { appointment } = await import("@savvy/db");
    const [a] = await adminDb.select().from(appointment).where(eq(appointment.id, p.appointmentId));
    if (a?.assigneeUserId) return { id: a.assigneeUserId };
  }
  // fallback: first owner/rep user in tenant
  const [u] = await adminDb.select({ id: user.id }).from(user)
    .where(and(eq(user.tenantId, p.tenantId), inRole(user)));
  return u ?? null;
}
function inRole(u: typeof user) { return or(eq(u.role, "owner"), eq(u.role, "rep")); }
async function loadBusy(tenantId: string, assigneeUserId: string, horizonDays: number) {
  const { appointment } = await import("@savvy/db");
  const from = new Date(); const to = new Date(Date.now() + horizonDays * 86400_000);
  const rows = await adminDb.select({
    startsAt: appointment.startsAt, endsAt: appointment.endsAt, lat: property.lat, lng: property.lng,
  }).from(appointment)
    .leftJoin(job, eq(appointment.jobId, job.id))
    .leftJoin(property, eq(job.propertyId, property.id))
    .where(and(eq(appointment.tenantId, tenantId), eq(appointment.assigneeUserId, assigneeUserId), eq(appointment.status, "scheduled")));
  return rows.filter((r) => r.startsAt >= from && r.startsAt < to)
    .map((r) => ({ startsAt: r.startsAt, endsAt: r.endsAt, lat: r.lat == null ? undefined : Number(r.lat), lng: r.lng == null ? undefined : Number(r.lng) }));
}
async function loadClusterPoint(p: TokenPayload): Promise<{ lat: number; lng: number } | null> {
  // best-effort: property tied to the lead/job
  let propertyId: string | undefined;
  if (p.leadId) { const [l] = await adminDb.select().from(lead).where(eq(lead.id, p.leadId)); propertyId = l?.propertyId ?? undefined; }
  if (!propertyId && p.jobId) { const [j] = await adminDb.select().from(job).where(eq(job.id, p.jobId)); propertyId = j?.propertyId ?? undefined; }
  if (!propertyId) return null;
  const [pr] = await adminDb.select().from(property).where(eq(property.id, propertyId));
  return pr?.lat != null && pr?.lng != null ? { lat: Number(pr.lat), lng: Number(pr.lng) } : null;
}
```

> Add `or` to the `@savvy/db` import (used by `inRole`). This action uses the admin (RLS-bypass) connection because the caller is an unauthenticated public page authorized solely by the signed token — same justification as the unsubscribe route.

- [ ] **Step 2: Delete the demo route**

```bash
git rm apps/web/src/app/api/leads/[id]/book/route.ts
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/agents typecheck && pnpm --filter @savvy/db typecheck`
Expected: PASS. Fix any unused-import lint fallout.

- [ ] **Step 4: Update Phase 1 e2e** — `apps/web/tests/e2e/lead-intake.spec.ts`: the booking link is now `/book/<token>`. Update the test to follow the slot-picker (visit the link, pick the first slot, assert an appointment exists). If the existing assertion checked the old GET response, replace it with a DB check that a `scheduled` appointment was created after confirming a slot. (Detailed slot-picker UI is built in Task 16 — sequence Task 16 before finalizing this e2e, or stub the assertion to check `convertLeadToJob` produced a job.)

- [ ] **Step 5: Run db lifecycle tests (convert now real)**

Run: `pnpm --filter @savvy/db exec vitest run appointments`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: route booking through slot-picker — convertLeadToJob helper + booking action; retire +24h demo route"
```

---

## Task 15: Inbound CANCEL handling

**Files:**
- Modify: `apps/web/src/lib/inbound-sms.ts`
- Test: extend `apps/web` (no test script) → cover via e2e in Task 20. Keep logic minimal + obviously correct.

- [ ] **Step 1: Implement** — update `handleInboundSms` so CANCEL cancels the customer's next upcoming `scheduled` appointment (before the opt-out/reply branch):

```ts
import { isStopKeyword, isCancelKeyword } from "@savvy/core";
import { withTenant, customer, communication, appointment, eq, and, asc } from "@savvy/db";
// …
// After logging the inbound communication and matching customer `c`:
if (isCancelKeyword(opts.body) && c) {
  const canceled = await withTenant(tenantId, async (tx) => {
    const [next] = await tx.select().from(appointment)
      .where(and(eq(appointment.customerId, c.id), eq(appointment.status, "scheduled")))
      .orderBy(asc(appointment.startsAt)).limit(1);
    if (!next) return null;
    await tx.update(appointment).set({ status: "canceled" }).where(eq(appointment.id, next.id));
    return next.id;
  });
  if (canceled) {
    try { await inngest.send({ name: "appointment/changed", data: { tenantId, appointmentId: canceled, reason: "canceled" } }); }
    catch (e) { console.error("inngest.send failed", e); }
    return { matched: true, stopped: null };
  }
}
```

> Structure the function so the inbound `communication` insert + customer match happen first, then the CANCEL branch, then the existing STOP/reply branch. CANCEL does **not** opt the customer out of comms (only cancels the appointment). If a customer texts CANCEL with no upcoming appointment, fall through to the existing reply behavior.

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/inbound-sms.ts
git commit -m "feat(web): inbound CANCEL cancels next appointment (STOP still opts out)"
```

---

## Task 16: Public slot-picker page `/book/[token]`

**Files:**
- Create: `apps/web/src/app/book/[token]/page.tsx`
- Create: `apps/web/src/app/book/[token]/SlotPicker.tsx` (client component)

- [ ] **Step 1: Server page** — `apps/web/src/app/book/[token]/page.tsx`:

```tsx
import { getSlotsForToken } from "@/lib/booking-action";
import { SlotPicker } from "./SlotPicker";

export const dynamic = "force-dynamic";

export default async function BookPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const res = await getSlotsForToken(token);
  if ("error" in res) {
    const msg = res.error === "invalid" ? "This booking link is invalid or expired." : "No one is available to book right now — please contact us.";
    return <main className="mx-auto max-w-md p-8 text-center"><h1 className="text-xl font-semibold">Booking unavailable</h1><p className="mt-2 text-muted-foreground">{msg}</p></main>;
  }
  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="text-2xl font-semibold">Pick a time</h1>
      <p className="text-muted-foreground mb-4">Choose a slot for your appointment.</p>
      <SlotPicker token={token} slots={res.slots} />
    </main>
  );
}
```

- [ ] **Step 2: Client component** — `apps/web/src/app/book/[token]/SlotPicker.tsx`:

```tsx
"use client";
import { useState, useTransition } from "react";
import { confirmSlot } from "@/lib/booking-action";
import { Button } from "@/components/ui/button";

export function SlotPicker({ token, slots }: { token: string; slots: { startsAt: string; endsAt: string }[] }) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (done) return <p className="rounded-md bg-green-50 p-4 text-green-800">You're booked! See you then.</p>;
  return (
    <div className="space-y-2">
      {error === "slot_taken" && <p className="text-sm text-red-600">That time was just taken — pick another.</p>}
      {slots.length === 0 && <p>No open times in the next two weeks. Please contact us.</p>}
      {slots.map((s) => (
        <Button key={s.startsAt} variant="outline" className="w-full justify-start" disabled={pending}
          onClick={() => start(async () => {
            const r = await confirmSlot(token, s.startsAt, s.endsAt);
            if ("ok" in r) setDone(true); else setError(r.error);
          })}>
          {new Date(s.startsAt).toLocaleString()}
        </Button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @savvy/web typecheck`
Expected: PASS (ensure `@/components/ui/button` exists; it does from earlier phases).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/book
git commit -m "feat(web): public token-gated slot-picker page (/book/[token])"
```

---

## Task 17: Internal `/schedule` agenda

**Files:**
- Create: `apps/web/src/app/(app)/schedule/page.tsx`
- Create: `apps/web/src/app/(app)/schedule/ScheduleClient.tsx`
- Modify: app nav (wherever `/comms`, `/jobs` links live)

- [ ] **Step 1: Server page** — groups appointments by day:

```tsx
import { listAppointments } from "@/lib/scheduling-queries";
import { ScheduleClient } from "./ScheduleClient";

export const dynamic = "force-dynamic";

export default async function SchedulePage() {
  const appts = await listAppointments();
  const groups = new Map<string, typeof appts>();
  for (const a of appts) {
    const day = a.startsAt.toISOString().slice(0, 10);
    (groups.get(day) ?? groups.set(day, []).get(day)!).push(a);
  }
  const days = [...groups.entries()].map(([day, items]) => ({
    day,
    items: items.map((i) => ({ ...i, startsAt: i.startsAt.toISOString(), endsAt: i.endsAt?.toISOString() ?? null })),
  }));
  return <ScheduleClient days={days} />;
}
```

- [ ] **Step 2: Client** — `ScheduleClient.tsx` renders day groups with per-row actions calling `cancelAction`/`markStatusAction` (from `scheduling-actions.ts`). Reschedule opens a simple datetime input → `rescheduleAction`. Keep it a clean agenda list (shadcn `Card`/`Button`/`Badge`), no drag grid. (Full code analogous to the `/comms` enrollments client — list rows + action buttons wrapped in `useTransition`; show a "slot taken" inline error if `rescheduleAction` returns `{ error: "slot_taken" }`.)

- [ ] **Step 3: Nav** — add a `Schedule` link next to `Comms`/`Jobs` in the app shell nav component.

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(app)/schedule" apps/web/src/components # nav file
git commit -m "feat(web): /schedule internal agenda with reschedule/cancel/status"
```

---

## Task 18: Settings — hours, reminders builder, Connect Google

**Files:**
- Create: `apps/web/src/app/(app)/settings/scheduling/page.tsx` + client
- Create: `apps/web/src/lib/settings-actions.ts` (save scheduling config)
- Create: `apps/web/src/app/api/nango/connect/route.ts` (Nango connect session)

- [ ] **Step 1: Save action** — `settings-actions.ts`: `saveSchedulingConfig(raw)` validates with `parseSchedulingConfig` (throws on bad input → return `{error}`), then `withTenant` updates `tenant.settings` jsonb merging `{ scheduling }`. `revalidatePath("/settings/scheduling")`.

```ts
"use server";
import { withTenant, tenant, eq } from "@savvy/db";
import { parseSchedulingConfig } from "@savvy/core";
import { getTenantId } from "./tenant";
import { revalidatePath } from "next/cache";

export async function saveSchedulingConfig(raw: unknown) {
  const tenantId = await getTenantId();
  let cfg; try { cfg = parseSchedulingConfig(raw); } catch { return { error: "invalid_config" as const }; }
  await withTenant(tenantId, async (tx) => {
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
    const next = { ...(t?.settings as object ?? {}), scheduling: cfg };
    await tx.update(tenant).set({ settings: next }).where(eq(tenant.id, tenantId));
  });
  revalidatePath("/settings/scheduling");
  return { ok: true as const };
}
```

> `tenant` has no `tenantIsolation` policy (it's the isolation root) but `withTenant` still sets the GUC; updating by `eq(tenant.id, tenantId)` is safe. If `tenant` updates fail under `savvy_app` grants, use `adminDb` here instead (document the choice in the commit).

- [ ] **Step 2: Settings UI** — a client form: weekly hours (open/close per day), `slotGranularityMin`, `bookingHorizonDays`, per-type duration/buffer, and a **reminder builder** (add/remove `{offsetH, channel}` rows — mirror the drip-step builder UI). Submit → `saveSchedulingConfig`. Plus a **Connect Google Calendar** button per current user that hits `/api/nango/connect`.

- [ ] **Step 3: Nango connect route** — `apps/web/src/app/api/nango/connect/route.ts`: creates a Nango Connect session for the current Clerk user and returns the auth URL (or session token for the Nango frontend SDK). On callback, store the resulting connection id on `user.gcalConnectionId`.

```ts
import { NextResponse } from "next/server";
export const runtime = "nodejs";
// POST: create a Nango connect session for google-calendar scoped to this user.
export async function POST() {
  const host = process.env.NANGO_HOST ?? "https://api.nango.dev";
  const res = await fetch(`${host}/connect/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.NANGO_SECRET_KEY ?? ""}`, "Content-Type": "application/json" },
    body: JSON.stringify({ allowed_integrations: [process.env.NANGO_GCAL_INTEGRATION_ID ?? "google-calendar"] }),
  });
  if (!res.ok) return NextResponse.json({ error: "nango_session_failed" }, { status: 502 });
  return NextResponse.json(await res.json());
}
```

> Storing the connection id back onto `user.gcalConnectionId` after the OAuth callback completes is the key wiring. If Nango's webhook/callback handling is more than a thin step, mark the persistence as a small follow-up and have the connect button set a placeholder connection id keyed by user id (`user-<id>`) so the push path is exercisable in dev. Keep this task's scope to: button → session → store id.

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(app)/settings/scheduling" apps/web/src/lib/settings-actions.ts apps/web/src/app/api/nango
git commit -m "feat(web): scheduling settings — hours, reminder builder, Connect Google Calendar"
```

---

## Task 19: Seed default scheduling settings

**Files:**
- Modify: `packages/db/src/seed.ts`

- [ ] **Step 1: Implement** — when seeding each demo tenant, set `settings.scheduling` to the defaults (so the seeded tenant books out of the box) and give the demo users a deterministic assignee. Reuse `parseSchedulingConfig(undefined)` for the default block:

```ts
import { parseSchedulingConfig } from "@savvy/core";
// when inserting/updating each tenant:
settings: { scheduling: parseSchedulingConfig(undefined) },
```

- [ ] **Step 2: Run seed**

```bash
pnpm db:reset
```

Expected: seeds without error; `select settings from tenant` shows the scheduling block.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/seed.ts
git commit -m "feat(db): seed default scheduling settings per tenant"
```

---

## Task 20: End-to-end test

**Files:**
- Create: `apps/web/tests/e2e/scheduling.spec.ts`

> Same harness as `comms.spec.ts` (Postgres + ai-stub + Inngest dev + Next, `TEST_MODE=1`). Calendar push is exercised only if the assignee has a `gcalConnectionId`; for the e2e, set a fake connection id on the test user and assert behavior through DB state rather than calling Google. Reminders use short offsets so the workflow can be observed, OR assert the reminder run was created/cancelled via the Inngest dev API.

- [ ] **Step 1: Write the e2e** covering the core Done-gate path:
  1. Seed a lead (or reuse `create-tenant.ts` tenant) with an assigned user + property coords.
  2. Generate a `/book/<token>` link (sign with `signPayloadToken` using the same secret the app uses), visit it, assert open slots render.
  3. Click the first slot → assert a `scheduled` appointment row exists for the tenant (DB query via admin) and appears on `/schedule`.
  4. Attempt to book the SAME slot for the same assignee via a second `confirmSlot` call → assert `{ error: "slot_taken" }` (the exclusion constraint backstop).
  5. Reschedule via `/schedule` (or `rescheduleAction`) → assert the appointment moved and the old time is free.
  6. Inbound CANCEL via `/api/twilio/inbound` (POST form) for the customer's phone → assert the appointment status flips to `canceled`.

- [ ] **Step 2: Run e2e** (recipe from the handoff):

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy AI_STUB_PORT=4010 INNGEST_DEV=1
node apps/web/tests/e2e/ai-stub.mjs &
npx --yes inngest-cli@latest dev -u http://localhost:3000/api/inngest --no-discovery &
pnpm --filter @savvy/web exec tsx tests/e2e/create-tenant.ts
export TEST_TENANT_ID="$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)")"
pnpm --filter @savvy/web exec playwright test scheduling
# cleanup: pkill -f ai-stub.mjs; pkill -f inngest-cli; pkill -f "next dev"
```

Expected: PASS.

- [ ] **Step 3: Full gate**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add apps/web/tests/e2e/scheduling.spec.ts
git commit -m "test(web): e2e — book via slot-picker, no-double-book, reschedule, inbound CANCEL"
```

---

## Final verification

- [ ] `pnpm typecheck && pnpm lint && pnpm test` green.
- [ ] e2e green (recipe above).
- [ ] `.env.example` documents Nango vars.
- [ ] Manual smoke: `pnpm db:reset && pnpm dev`, open `/schedule`, generate a `/book/<token>` link, book, see it on the agenda, reschedule, cancel.
- [ ] Spec Done-gates met: appointments created; **no double-booking** (constraint + test); GCal push best-effort when connected; configurable reminders fire + self-cancel; all tenant-scoped (RLS test extended).

## Notes for the executor
- **Sequence dependency:** Task 16 (slot-picker UI) is referenced by the Task 14 e2e update — build Task 16 before finalizing the Task 14 e2e, or land the Task 14 e2e change with Task 20.
- **`tenant` table writes** under `savvy_app`: if grants block the settings update, switch `saveSchedulingConfig` to `adminDb` and note it.
- **Carried Phase 3 follow-up:** Twilio webhook signature validation still absent on `api/twilio/*` (this phase extends inbound). Add as a pre-production task; out of scope here but flagged.
- **TCPA quiet-hours:** reminders send to real numbers — gate 9pm–8am before production (deferred, in spec §13).
