# Weather Auto-Reschedule + Notify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a scheduled crew install is at weather risk, automatically move it to the next safe, crew-free slot and notify the homeowner and crew — replacing today's flag-only behavior.

**Architecture:** Extend the existing hourly `weather-reschedule` cron. Add pure helpers in `@savvy/core` (config flag, slot picker, tz placement, copy builders), two readers in `@savvy/db` (crew-busy dates, crew contacts), and wire the action into `evaluateTenantWeather`. The Inngest wrapper emits `appointment/changed` for each moved appointment so the homeowner crew-day journey re-arms for the new date.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres + RLS), Inngest, Vitest, pnpm monorepo (`@savvy/core`, `@savvy/db`, `@savvy/agents`, `@savvy/integrations`).

## Global Constraints

- **Tenant isolation:** every query runs via `withTenant(tenantId, ...)` or is tenant-scoped; no raw cross-tenant reads. (`packages/db`)
- **No hard-coded model strings / provider calls** — N/A here (no AI in this slice).
- **Events emitted only from the orchestration layer**, never from `@savvy/db`. In this slice, `evaluateTenantWeather` returns moved ids and the Inngest wrapper (`weatherReschedule`) emits.
- **Weather uses `finance.timezone`** (`parseFinanceConfig(settings.finance).timezone`) — the tz the existing `evaluateTenantWeather` already operates in. Do NOT switch to `tenant.timezone` inside this function.
- **Homeowner SMS is TCPA-quiet-hours-safe:** send SMS only when NOT within quiet hours; email always sends. Quiet hours come from `parseHomeownerConfig(settings.homeowner).quietHours`.
- **Comms are fail-soft:** wrap sends in try/catch (missing creds must never fail the move); always log the attempt to `communication`.
- **Config default:** `autoReschedule` defaults `true`, gated behind existing `weather.enabled`.
- **Commit message trailer:** end every commit body with
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Test commands:** `pnpm --filter @savvy/core vitest run <file>` (pure); DB/agent integration tests run from their package with `pnpm vitest run <file>` and require the local Postgres test DB (already used by the existing `weather-reschedule.test.ts`).

---

### Task 1: Config flag `autoReschedule`

**Files:**
- Modify: `packages/core/src/weather-config.ts`
- Test: `packages/core/src/weather-config.test.ts`

**Interfaces:**
- Consumes: existing `parseWeatherConfig`, `WeatherConfig`.
- Produces: `WeatherConfig.autoReschedule: boolean` (default `true`).

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/weather-config.test.ts`:

```ts
it("defaults autoReschedule to true", () => {
  expect(parseWeatherConfig({}).autoReschedule).toBe(true);
});

it("respects autoReschedule=false", () => {
  expect(parseWeatherConfig({ autoReschedule: false }).autoReschedule).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && pnpm vitest run src/weather-config.test.ts`
Expected: FAIL — `autoReschedule` is `undefined`.

- [ ] **Step 3: Add the field**

In `packages/core/src/weather-config.ts`, add to `weatherSchema` (after `lookAheadDays`):

```ts
  autoReschedule: z.boolean().default(true),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && pnpm vitest run src/weather-config.test.ts`
Expected: PASS (all weather-config tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/weather-config.ts packages/core/src/weather-config.test.ts
git commit -m "feat(weather): autoReschedule config flag (default on)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: tz helper `instantAtLocalTimeOnDate`

**Files:**
- Modify: `packages/core/src/tz.ts`
- Test: `packages/core/src/tz.test.ts`

**Interfaces:**
- Consumes: existing private `tzOffsetMs`, `hourInTimeZone`.
- Produces: `instantAtLocalTimeOnDate(targetCivilDate: string, sourceLocalTime: Date, tz: string): Date` — the UTC instant whose wall-clock time in `tz` is the same hour:minute:second as `sourceLocalTime`, but on calendar day `targetCivilDate` (`YYYY-MM-DD`).

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/tz.test.ts` (import `instantAtLocalTimeOnDate`, `hourInTimeZone`, and `toCivilDate` from `./schedule-view` if not already imported — check existing imports and reuse):

```ts
it("places the source wall-clock time onto a different calendar day", () => {
  const tz = "America/Phoenix";
  // A source instant whose Phoenix wall-clock time is 09:30 on 2026-07-06.
  const source = instantAtLocalTimeOnDate("2026-07-06", new Date("2026-01-01T16:30:00Z"), tz);
  const moved = instantAtLocalTimeOnDate("2026-07-13", source, tz);
  // moved must read 09:30 local on 2026-07-13
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(moved);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  expect(`${get("year")}-${get("month")}-${get("day")}`).toBe("2026-07-13");
  expect(`${get("hour")}:${get("minute")}`).toBe("09:30");
});
```

Note: Phoenix has no DST, so 16:30Z == 09:30 MST year-round — the test is deterministic.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run src/tz.test.ts`
Expected: FAIL — `instantAtLocalTimeOnDate is not a function`.

- [ ] **Step 3: Implement**

Add to `packages/core/src/tz.ts` (after `instantAtLocalHourOnDayOf`; it can reuse the module-private `tzOffsetMs`):

```ts
/**
 * The UTC instant whose wall-clock reading in `tz` is the same hour:minute:second
 * as `sourceLocalTime`, but on calendar day `targetCivilDate` (YYYY-MM-DD).
 * Used to move an appointment to a new day while preserving its time-of-day.
 */
export function instantAtLocalTimeOnDate(targetCivilDate: string, sourceLocalTime: Date, tz: string): Date {
  const [y, m, d] = targetCivilDate.split("-").map(Number);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", second: "numeric", hour12: false }).formatToParts(sourceLocalTime);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const hour = get("hour") % 24; // normalize a "24" midnight
  const guess = Date.UTC(y, m - 1, d, hour, get("minute"), get("second"));
  const offset = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - offset);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run src/tz.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tz.ts packages/core/src/tz.test.ts
git commit -m "feat(tz): instantAtLocalTimeOnDate — move time-of-day to a new day

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Pure slot picker `pickRescheduleSlot`

**Files:**
- Modify: `packages/core/src/weather-config.ts`
- Test: `packages/core/src/weather-config.test.ts`

**Interfaces:**
- Consumes: `assessWeatherRisk`, `WeatherConfig`.
- Produces:
  ```ts
  pickRescheduleSlot(input: {
    days: { date: string; maxWindMph: number; precipProbability: number }[];
    originalCivilDate: string;         // YYYY-MM-DD
    crewBusyDates: Set<string>;        // YYYY-MM-DD the crew already works
    cfg: WeatherConfig;
  }): string | null                    // earliest safe+free day strictly after original, else null
  ```

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/weather-config.test.ts`:

```ts
const cfg = parseWeatherConfig({ maxWindMph: 25, maxPrecipPct: 60 });
const clear = (date: string) => ({ date, maxWindMph: 5, precipProbability: 10 });
const rainy = (date: string) => ({ date, maxWindMph: 5, precipProbability: 90 });

it("picks the earliest safe, crew-free day after the original", () => {
  const got = pickRescheduleSlot({
    days: [rainy("2026-07-06"), rainy("2026-07-07"), clear("2026-07-08"), clear("2026-07-09")],
    originalCivilDate: "2026-07-06", crewBusyDates: new Set(), cfg,
  });
  expect(got).toBe("2026-07-08");
});

it("skips days the crew is already booked", () => {
  const got = pickRescheduleSlot({
    days: [clear("2026-07-07"), clear("2026-07-08")],
    originalCivilDate: "2026-07-06", crewBusyDates: new Set(["2026-07-07"]), cfg,
  });
  expect(got).toBe("2026-07-08");
});

it("never picks the original day or earlier", () => {
  const got = pickRescheduleSlot({
    days: [clear("2026-07-05"), clear("2026-07-06")],
    originalCivilDate: "2026-07-06", crewBusyDates: new Set(), cfg,
  });
  expect(got).toBeNull();
});

it("returns null when every later day is at-risk or busy", () => {
  const got = pickRescheduleSlot({
    days: [rainy("2026-07-07"), clear("2026-07-08")],
    originalCivilDate: "2026-07-06", crewBusyDates: new Set(["2026-07-08"]), cfg,
  });
  expect(got).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && pnpm vitest run src/weather-config.test.ts`
Expected: FAIL — `pickRescheduleSlot is not a function`.

- [ ] **Step 3: Implement**

Add to `packages/core/src/weather-config.ts`:

```ts
/** Earliest safe, crew-free forecast day strictly after the original date, or null. */
export function pickRescheduleSlot(input: {
  days: { date: string; maxWindMph: number; precipProbability: number }[];
  originalCivilDate: string;
  crewBusyDates: Set<string>;
  cfg: WeatherConfig;
}): string | null {
  const sorted = [...input.days].sort((a, b) => a.date.localeCompare(b.date));
  for (const day of sorted) {
    if (day.date <= input.originalCivilDate) continue;
    if (input.crewBusyDates.has(day.date)) continue;
    if (assessWeatherRisk(day, input.cfg).atRisk) continue;
    return day.date;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && pnpm vitest run src/weather-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/weather-config.ts packages/core/src/weather-config.test.ts
git commit -m "feat(weather): pickRescheduleSlot — earliest safe, crew-free day

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Copy builders + short-date formatter

**Files:**
- Create: `packages/core/src/weather-notify.ts`
- Create: `packages/core/src/weather-notify.test.ts`
- Modify: `packages/core/src/index.ts` (export the new module)

**Interfaces:**
- Produces:
  ```ts
  formatShortDate(civilDate: string): string                 // "2026-07-08" -> "Wed 7/8"
  buildWeatherMoveHomeownerBody(i: { originalLabel: string; targetLabel: string; reason: string }): string
  buildWeatherMoveCrewBody(i: { address: string; originalLabel: string; targetLabel: string; reason: string }): string
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/weather-notify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatShortDate, buildWeatherMoveHomeownerBody, buildWeatherMoveCrewBody } from "./weather-notify";

describe("weather-notify", () => {
  it("formats a civil date as 'Wkd M/D'", () => {
    expect(formatShortDate("2026-07-08")).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) 7\/8$/);
  });

  it("builds a homeowner move body with both dates and the reason", () => {
    const body = buildWeatherMoveHomeownerBody({ originalLabel: "Mon 7/6", targetLabel: "Wed 7/8", reason: "Rain 90%" });
    expect(body).toContain("Mon 7/6");
    expect(body).toContain("Wed 7/8");
    expect(body).toContain("Rain 90%");
  });

  it("builds a crew move body with address and target date", () => {
    const body = buildWeatherMoveCrewBody({ address: "123 Main St", originalLabel: "Mon 7/6", targetLabel: "Wed 7/8", reason: "Rain 90%" });
    expect(body).toContain("123 Main St");
    expect(body).toContain("Wed 7/8");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && pnpm vitest run src/weather-notify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/core/src/weather-notify.ts`:

```ts
/** "2026-07-08" -> "Wed 7/8". Civil date is already tz-resolved, so format in UTC. */
export function formatShortDate(civilDate: string): string {
  const [y, m, d] = civilDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(dt);
  return `${wd} ${m}/${d}`;
}

export function buildWeatherMoveHomeownerBody(i: { originalLabel: string; targetLabel: string; reason: string }): string {
  return `Heads up — weather (${i.reason}) is expected ${i.originalLabel}, so we've moved your roof install to ${i.targetLabel}. We'll be in touch as the day approaches.`;
}

export function buildWeatherMoveCrewBody(i: { address: string; originalLabel: string; targetLabel: string; reason: string }): string {
  return `Weather move: ${i.address} install → ${i.targetLabel} (was ${i.originalLabel} — ${i.reason}).`;
}
```

- [ ] **Step 4: Export from the core barrel**

In `packages/core/src/index.ts`, add alongside the other `export * from "./..."` lines:

```ts
export * from "./weather-notify";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/core && pnpm vitest run src/weather-notify.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/weather-notify.ts packages/core/src/weather-notify.test.ts packages/core/src/index.ts
git commit -m "feat(weather): move-notification copy builders + short-date formatter

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: DB readers — crew-busy starts + crew contacts

**Files:**
- Modify: `packages/db/src/lifecycle/appointments.ts` (add `getCrewBusyStarts`)
- Modify: `packages/db/src/lifecycle/crew.ts` (**already exists** — add `getCrewContacts`; it already imports `crew, crewMember, user` from `../schema/index` and `and, eq` from `drizzle-orm`)
- Modify: `packages/db/src/index.ts` (extend two **named** export lists — the barrel does not `export *` these lifecycle modules)
- Test: `packages/db/src/lifecycle/crew-readers.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  getCrewBusyStarts(input: { tenantId: string; crewId: string; from: Date; to: Date; excludeAppointmentId: string }): Promise<Date[]>
  getCrewContacts(input: { tenantId: string; crewId: string }): Promise<{ phone: string | null; email: string }[]>
  ```

- [ ] **Step 1: Write the failing integration test**

Create `packages/db/src/lifecycle/crew-readers.test.ts` (mirrors the seeding style of `packages/agents/src/functions/weather-reschedule.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { adminDb, tenant, customer, property, job, appointment, user, crew, crewMember } from "../index";
import { getCrewBusyStarts, getCrewContacts } from "../index";

async function seed() {
  const [t] = await adminDb.insert(tenant).values({ name: "CR", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` }).returning();
  const tenantId = t!.id;
  const [cr] = await adminDb.insert(crew).values({ tenantId, name: "Blue Crew" }).returning();
  const [u] = await adminDb.insert(user).values({ tenantId, email: `crew-${crypto.randomUUID()}@ex.com`, phone: "+15551230000", role: "crew", name: "Lead Hand" }).returning();
  await adminDb.insert(crewMember).values({ tenantId, crewId: cr!.id, userId: u!.id });
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "C" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 A St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  return { tenantId, crewId: cr!.id, jobId: j!.id, customerId: c!.id, email: u!.email };
}

describe("crew readers", () => {
  it("getCrewBusyStarts returns scheduled crew appt starts, excluding one", async () => {
    const { tenantId, crewId, jobId, customerId } = await seed();
    const base = new Date(Date.now() + 3 * 86_400_000);
    const [keep] = await adminDb.insert(appointment).values({ tenantId, jobId, customerId, crewId, type: "crew", status: "scheduled", startsAt: base, endsAt: new Date(base.getTime() + 3_600_000) }).returning();
    const excl = new Date(base.getTime() + 86_400_000);
    const [drop] = await adminDb.insert(appointment).values({ tenantId, jobId, customerId, crewId, type: "crew", status: "scheduled", startsAt: excl, endsAt: new Date(excl.getTime() + 3_600_000) }).returning();

    const starts = await getCrewBusyStarts({ tenantId, crewId, from: new Date(Date.now()), to: new Date(Date.now() + 30 * 86_400_000), excludeAppointmentId: drop!.id });
    expect(starts.map((d) => d.getTime())).toContain(keep!.startsAt.getTime());
    expect(starts.map((d) => d.getTime())).not.toContain(drop!.startsAt.getTime());
  });

  it("getCrewContacts returns member users' phone + email", async () => {
    const { tenantId, crewId, email } = await seed();
    const contacts = await getCrewContacts({ tenantId, crewId });
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.email).toBe(email);
    expect(contacts[0]!.phone).toBe("+15551230000");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/db && pnpm vitest run src/lifecycle/crew-readers.test.ts`
Expected: FAIL — `getCrewBusyStarts` / `getCrewContacts` not exported.

- [ ] **Step 3a: Implement `getCrewBusyStarts`**

In `packages/db/src/lifecycle/appointments.ts`, extend the drizzle import to include `gte, lte, ne`:

```ts
import { eq, and, isNull, inArray, gte, lte, ne } from "drizzle-orm";
```

Add (near `getBusyIntervals`):

```ts
/** Start times of a crew's other scheduled crew appts in [from,to] — excludes `excludeAppointmentId`. */
export async function getCrewBusyStarts(input: {
  tenantId: string; crewId: string; from: Date; to: Date; excludeAppointmentId: string;
}): Promise<Date[]> {
  return withTenant(input.tenantId, async (tx) => {
    const rows = await tx.select({ startsAt: appointment.startsAt })
      .from(appointment)
      .where(and(
        eq(appointment.crewId, input.crewId),
        eq(appointment.type, "crew"),
        eq(appointment.status, "scheduled"),
        gte(appointment.startsAt, input.from),
        lte(appointment.startsAt, input.to),
        ne(appointment.id, input.excludeAppointmentId),
      ));
    return rows.map((r) => r.startsAt);
  });
}
```

- [ ] **Step 3b: Implement `getCrewContacts`**

Append to the **existing** `packages/db/src/lifecycle/crew.ts` (imports `crew, crewMember, user` and `and, eq` are already present at the top of the file):

```ts
/** Phone/email of every member user of a crew (for crew notifications). */
export async function getCrewContacts(input: { tenantId: string; crewId: string }): Promise<{ phone: string | null; email: string }[]> {
  return withTenant(input.tenantId, async (tx) => {
    const rows = await tx.select({ phone: user.phone, email: user.email })
      .from(crewMember)
      .innerJoin(user, eq(user.id, crewMember.userId))
      .where(and(eq(crewMember.tenantId, input.tenantId), eq(crewMember.crewId, input.crewId)));
    return rows.map((r) => ({ phone: r.phone, email: r.email }));
  });
}
```

- [ ] **Step 3c: Extend the two named export lists in the db barrel**

`packages/db/src/index.ts` exports these lifecycle modules via **named lists**, not `export *`. Add `getCrewBusyStarts` to the appointments export block:

```ts
export {
  bookAppointment, rescheduleAppointment, reassignAppointment, cancelAppointment, setAppointmentStatus,
  getBusyIntervals, getCrewBusyStarts, convertLeadToJob, setAppointmentWeatherFlag, SlotTakenError, NoAssigneeError,
} from "./lifecycle/appointments";
```

And add `getCrewContacts` to the existing crew export line (currently `export { createCrew, listCrews, renameCrew, setCrewActive, setCrewLocation, setCrewPinHash, getCrewLoginCandidates, addCrewMember, removeCrewMember, listCrewIdsForUser, type CrewRow } from "./lifecycle/crew";`):

```ts
export { createCrew, listCrews, renameCrew, setCrewActive, setCrewLocation, setCrewPinHash, getCrewLoginCandidates, addCrewMember, removeCrewMember, listCrewIdsForUser, getCrewContacts, type CrewRow } from "./lifecycle/crew";
```

The schema tables `crew`, `crewMember`, `user` are already exported via `export * from "./schema/index"`, so the test's `import { ..., user, crew, crewMember } from "../index"` resolves without changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/db && pnpm vitest run src/lifecycle/crew-readers.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/appointments.ts packages/db/src/lifecycle/crew.ts packages/db/src/index.ts packages/db/src/lifecycle/crew-readers.test.ts
git commit -m "feat(db): crew-busy starts + crew contacts readers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Wire auto-reschedule + notify into `evaluateTenantWeather`

**Files:**
- Modify: `packages/agents/src/functions/weather-reschedule.ts`
- Test: `packages/agents/src/functions/weather-reschedule.test.ts`

**Interfaces:**
- Consumes: `pickRescheduleSlot`, `instantAtLocalTimeOnDate`, `formatShortDate`, `buildWeatherMoveHomeownerBody`, `buildWeatherMoveCrewBody`, `parseHomeownerConfig`, `parseEmailConfig`, `isWithinQuietHours` (all `@savvy/core`); `rescheduleAppointment`, `setAppointmentWeatherFlag`, `getCrewBusyStarts`, `getCrewContacts`, `SlotTakenError`, schema tables (`@savvy/db`); `getTenantSms` (`../telephony`); `getEmailSender` (`@savvy/integrations`).
- Produces: `evaluateTenantWeather(...) => Promise<{ flagged: number; cleared: number; rescheduled: number; rescheduledAppointmentIds: string[] }>`; `weatherReschedule` wrapper emits `appointment/changed` per moved id.

**Design notes for the implementer:**
- The existing per-appt loop currently selects `{ id, startsAt, lat, lng }`. Extend the query to also select `appointment.crewId`, `appointment.endsAt`, `job.customerId`, `customer.phone`, `customer.email`, `customer.smsOptOut`, `customer.emailOptOut`, and `property.address` (join `customer` on `job.customerId`). Keep the existing `job`/`property` joins.
- Keep using `tz = parseFinanceConfig(settings.finance).timezone` (already computed). Parse `homeowner`/`email` config once from `settings`.
- Decision per at-risk appt:
  1. If `!cfg.autoReschedule` OR `r.crewId == null` → `setAppointmentWeatherFlag({ tenantId, appointmentId, note: risk.reason })`; `flagged++`; continue.
  2. Build `crewBusyDates`: `new Set((await getCrewBusyStarts({ tenantId, crewId: r.crewId, from: now, to: windowEnd, excludeAppointmentId: r.id })).map((d) => toCivilDate(d.toISOString(), tz)))`.
  3. Loop: `const target = pickRescheduleSlot({ days, originalCivilDate: apptDate, crewBusyDates, cfg });` — if `null` → flag-only fallback, `flagged++`, break to next appt.
  4. `const newStart = instantAtLocalTimeOnDate(target, r.startsAt, tz);` `const newEnd = new Date(newStart.getTime() + (r.endsAt.getTime() - r.startsAt.getTime()));`
  5. `try { await rescheduleAppointment({ tenantId, appointmentId: r.id, startsAt: newStart, endsAt: newEnd }); } catch (e) { if (e instanceof SlotTakenError) { crewBusyDates.add(target); continue the loop; } throw e; }`
  6. On success: `await setAppointmentWeatherFlag({ tenantId, appointmentId: r.id, note: null });` then send notifications (below), `rescheduled++`, push `r.id`, break to next appt.
- Notifications helper (fail-soft): compute `originalLabel = formatShortDate(apptDate)`, `targetLabel = formatShortDate(target)`, `reason = risk.reason`.
  - Homeowner: `body = buildWeatherMoveHomeownerBody({ originalLabel, targetLabel, reason })`. If `phone && !smsOptOut && !isWithinQuietHours(now, tz, homeownerCfg.quietHours)` → `try { const { sender, from } = await getTenantSms(tenantId); await sender.sendSms({ to: phone, from, body }); } catch {}` then always insert a `communication` row (`channel: "sms"`, `direction: "outbound"`, `to: phone`, `jobId`, `customerId`, `body`, `aiHandled: false`). If `email && !emailOptOut` → `try { await getEmailSender({ gmailConnectionId }).sendEmail({ to: email, from: process.env.EMAIL_FROM ?? "noreply@example.com", subject: "Your roofing install has moved", html: `<p>${body}</p>` }); } catch {}` then insert a `communication` row (`channel: "email"`).
  - Crew: `crewBody = buildWeatherMoveCrewBody({ address, originalLabel, targetLabel, reason })`. For each contact from `getCrewContacts({ tenantId, crewId: r.crewId })`: if `contact.phone` → `try { getTenantSms + sendSms } catch {}` + `communication` row (`customerId: null`, `to: contact.phone`, `channel: "sms"`); else if `contact.email` → email + `communication` row (`customerId: null`, `channel: "email"`). Quiet hours do NOT gate crew (operational), but reuse the same fail-soft send.
- The wrapper: after each `step.run("weather-${id}", ...)` returns `res`, loop `for (const apptId of res.rescheduledAppointmentIds) await step.sendEvent(\`wx-moved-${apptId}\`, { name: "appointment/changed", data: { appointmentId: apptId, tenantId: id, reason: "weather_rescheduled" } });`. Accumulate `flagged/cleared/rescheduled` into the return.

- [ ] **Step 1: Update the two existing tests for the new return shape**

In `packages/agents/src/functions/weather-reschedule.test.ts`, change the disabled-tenant assertion from
`expect(r).toEqual({ flagged: 0, cleared: 0 })` to
`expect(r).toEqual({ flagged: 0, cleared: 0, rescheduled: 0, rescheduledAppointmentIds: [] })`.

The first test ("flags an at-risk crew appt…") seeds an appointment with **no `crewId`**, so with `autoReschedule` defaulting on it still takes the flag-only path — `r1.flagged` stays `1`. Leave it as-is (it now also guards the "missing crewId → flag-only" branch).

- [ ] **Step 2: Write the new failing test**

Add to `packages/agents/src/functions/weather-reschedule.test.ts`. Extend the `seed()` helper (or add a `seedWithCrew()`) to also create a `crew`, a `crew_member` user with phone+email, set the appointment's `crewId`, and give the customer a `phone` + `email`. Import `crew, crewMember, user` from `@savvy/db`.

```ts
it("auto-reschedules an at-risk crew appt to the next safe, crew-free day and notifies", async () => {
  const s = await seedWithCrew();               // appt has crewId; customer has phone+email
  const now = new Date();
  // apptDate is at-risk; the day after is clear.
  const nextDay = toCivilDate(new Date(new Date(`${s.apptDate}T12:00:00Z`).getTime() + 86_400_000).toISOString(), s.tz);
  const r = await evaluateTenantWeather(
    s.tenantId,
    stub([{ date: s.apptDate, maxWindMph: 5, precipProbability: 90 }, { date: nextDay, maxWindMph: 5, precipProbability: 0 }]),
    now,
  );

  expect(r.rescheduled).toBe(1);
  expect(r.rescheduledAppointmentIds).toEqual([s.apptId]);

  const [a] = await withTenant(s.tenantId, (tx) => tx.select({ startsAt: appointment.startsAt, note: appointment.weatherNote }).from(appointment).where(eq(appointment.id, s.apptId)));
  expect(toCivilDate(a!.startsAt.toISOString(), s.tz)).toBe(nextDay); // moved
  expect(a!.note).toBeNull();                                         // flag cleared

  const comms = await withTenant(s.tenantId, (tx) => tx.select({ ch: communication.channel, to: communication.to }).from(communication).where(eq(communication.jobId, s.jobId)));
  // homeowner sms+email + at least the crew member
  expect(comms.length).toBeGreaterThanOrEqual(2);
});

it("falls back to flag-only when no safe day exists in the window", async () => {
  const s = await seedWithCrew();
  const r = await evaluateTenantWeather(s.tenantId, stub([{ date: s.apptDate, maxWindMph: 5, precipProbability: 90 }]), new Date());
  expect(r.rescheduled).toBe(0);
  expect(r.flagged).toBe(1);
  const [a] = await withTenant(s.tenantId, (tx) => tx.select({ note: appointment.weatherNote }).from(appointment).where(eq(appointment.id, s.apptId)));
  expect(a!.note).toBe("Rain 90%");
});
```

Note on quiet hours: the homeowner-config default quiet hours are 21:00–08:00. To keep the SMS-comm assertion deterministic regardless of when CI runs, set the seeded tenant's `settings.homeowner.quietHours` to a window that excludes "now" — e.g. `{ startHour: 3, endHour: 4 }` — OR relax the assertion to `>= 2` (homeowner email + crew), which does not depend on the SMS gate. Use the relaxed `>= 2` assertion (email + crew always send) to avoid time-of-day flakiness.

- [ ] **Step 3: Run the tests to verify the new ones fail**

Run: `cd packages/agents && pnpm vitest run src/functions/weather-reschedule.test.ts`
Expected: the two new tests FAIL (`r.rescheduled` undefined / appt not moved); the updated disabled test may fail until Step 4.

- [ ] **Step 4: Implement**

Edit `packages/agents/src/functions/weather-reschedule.ts` per the design notes above: extend imports, enriched query, the per-appt decision branch, the fail-soft notification helper, the extended return shape, and the wrapper's `appointment/changed` emission. Keep functions focused — extract a `notifyWeatherMove(...)` helper within the file so `evaluateTenantWeather`'s loop stays readable (under ~50 lines).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/agents && pnpm vitest run src/functions/weather-reschedule.test.ts`
Expected: PASS (all tests — the 2 original updated + 2 new).

- [ ] **Step 6: Typecheck the touched packages**

Run: `pnpm --filter @savvy/core --filter @savvy/db --filter @savvy/agents typecheck` (or the repo's `pnpm typecheck` if per-filter is unavailable).
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/agents/src/functions/weather-reschedule.ts packages/agents/src/functions/weather-reschedule.test.ts
git commit -m "feat(weather): auto-reschedule at-risk crew installs + notify homeowner/crew

When autoReschedule is on and a safe, crew-free day exists in the forecast
window, move the install there, clear the weather flag, notify homeowner
(quiet-hours-safe) and crew, and emit appointment/changed so the homeowner
journey re-arms. Falls back to flag-only when no safe slot or no crew.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Config `autoReschedule` default ON → Task 1. ✓
- `pickRescheduleSlot` (safe + crew-free) → Task 3 (+ crew-busy reader Task 5). ✓
- `instantAtLocalTimeOnDate` → Task 2. ✓
- Copy builders → Task 4. ✓
- Crew-busy + crew-contacts readers → Task 5. ✓
- Extended `evaluateTenantWeather`: move, clear flag, notify homeowner (quiet-hours) + crew, event emission, fallbacks (no slot / no crew / SlotTaken) → Task 6. ✓
- Return counters `{ flagged, cleared, rescheduled, rescheduledAppointmentIds }` → Task 6. ✓
- Error handling (forecast failure unchanged, SlotTaken retry, fail-soft comms) → Task 6 design notes + existing code. ✓

**Placeholder scan:** No TBD/TODO. Each code step shows full code with exact barrel edits (verified against the actual `packages/core/src/index.ts` star-exports and `packages/db/src/index.ts` named-export lists). `lifecycle/crew.ts` already exists — Task 5 appends to it rather than creating it.

**Type consistency:** `pickRescheduleSlot` input `{ days, originalCivilDate, crewBusyDates, cfg }` is identical in Task 3 def and Task 6 call. `getCrewBusyStarts`/`getCrewContacts` signatures match between Task 5 def and Task 6 consumption. `instantAtLocalTimeOnDate(target, source, tz)` matches. Return shape `{ flagged, cleared, rescheduled, rescheduledAppointmentIds }` is consistent across Task 6 tests, wrapper, and spec.

## Out of scope (v1)
Thrash-protection column; Assisted/propose mode; multi-crew reassignment; non-crew appointment types. (Per spec.)
