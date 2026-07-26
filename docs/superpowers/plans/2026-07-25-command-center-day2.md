# Command Center (Day 2) — Daily Flash & Exception Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Arrington's cockpit — an automatic end-of-day "Daily Flash" summary + a stateful "Exception Queue" — as a read model folding the Day-1 orchestrator event log into daily metrics.

**Architecture:** A new standalone `packages/command-center` package. Pure core (Denver day-window, a `projectDay` reducer over the event log, an exception-queue lifecycle, a Flash HTML/headline renderer, comparison deltas) drives an §8 acceptance test offline. A prerequisite event re-model extends Day-1's vocabulary. Slice 2 adds Drizzle persistence (daily_metrics + exception_queue, migration 0119), a db event-loader, a web Flash route, and mock scheduler/delivery seams.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), zod ^3.23, Vitest, Drizzle ORM ^0.36 + Postgres, native `Intl.DateTimeFormat` for timezone (no new dep), Next.js App Router (apps/web), pnpm + Turborepo.

## Global Constraints

- **Read-only over the Day-1 log** — never write business state, never call the six source tools. The only new writes are the projection row + exception-queue state.
- **Standalone package** `@savvy/command-center`, conventions copied from `packages/orchestrator`: `"type":"module"`, main/types → `./src/index.ts`, tsconfig extends `../../tsconfig.base.json`, deps `workspace:*`, `zod:"^3.23.0"`, `typescript:"^5.6.0"`, `vitest:"^2.1.0"`.
- **Money is integer cents** everywhere (`amountCents`, `contractValueCents`); the Flash converts to dollars only at render.
- **Timezone:** business day is **America/Denver**; timestamps stored/compared in UTC, bucketed to a `YYYY-MM-DD` Denver date via `Intl.DateTimeFormat`. Arizona (Arrington) has no DST — surface send time in AZ local in the headline. Use native `Intl` (the `packages/core/src/finance.ts` + `datetime.ts` precedent); **do not** add date-fns-tz/luxon.
- **Re-model blast-radius rule:** the event re-model edits `packages/orchestrator/src/events.ts`, `publishers.ts`, and Day-1 test files — but must **NOT** edit `triggers.ts`, `engine.ts`, or `packages/db/src/orchestrator/store.ts`/`index.ts` (owned by the concurrent follow-up task `task_71fda1bc`).
- **Idempotent + replayable:** one Flash per business date (upsert); `rebuild(date)` reproduces identical metrics. **Graceful with gaps:** a missing optional field renders "—" (never crashes); a zero-activity day still produces a valid "quiet day" Flash.
- **Minimal PII / no secrets:** aggregates + job ids only; the SMS headline carries no customer PII.
- **`noUncheckedIndexedAccess` is ON** — guard array/record index access. Run per-package tests via `pnpm --filter @savvy/<pkg> test`; typecheck via `pnpm --filter @savvy/<pkg> typecheck`.
- **Commit co-author:** `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. **Merges need Brett's explicit per-PR word.**
- **SEQUENCING:** do NOT start Task 1 until the follow-up task `task_71fda1bc` has merged to `main`; then rebase `command-center-day2` on the updated `main`. This keeps the re-model's test edits from colliding with the follow-up's edits to `engine.test.ts` / db `store.test.ts`.

---

## File Structure

**Slice 1 — event re-model + `packages/command-center` core:**
- `packages/orchestrator/src/events.ts` (modify) — add appointment events + `source`/`contractValueCents`/`amountCents`.
- `packages/orchestrator/src/publishers.ts` (modify) — publishers supply the new required fields.
- `packages/orchestrator/src/{events,engine,acceptance,publishers,triggers,store}.test.ts` (modify) — supply new required fields.
- `packages/command-center/package.json`, `tsconfig.json` — scaffold.
- `src/day-window.ts` — Denver business-day window + `businessDateOf`.
- `src/metrics.ts` — the `DailyMetrics` type (shared shape).
- `src/projection.ts` — `projectDay` reducer.
- `src/comparison.ts` — vs-yesterday / trailing-7 deltas.
- `src/exception-queue.ts` — lifecycle + in-memory store.
- `src/flash.ts` — HTML + headline renderers.
- `src/index.ts` — barrel.
- `src/*.test.ts` + `src/acceptance.test.ts`.

**Slice 2 — persistence + web + seams:**
- `packages/db/src/schema/command-center.ts` — `dailyMetrics` + `exceptionQueue` tables.
- `packages/db/drizzle/0119_*.sql` — generated migration.
- `packages/db/src/command-center/read.ts` — `loadEventsForDay` (new file; does not touch Day-1 store).
- `packages/db/src/command-center/store.ts` — `upsertDailyMetrics`/`getDailyMetrics` + exception-queue persistence.
- `packages/db/src/command-center/*.test.ts` — integration round-trip.
- `packages/command-center/src/seams.ts` — `FlashScheduler`/`FlashDelivery` interfaces + mock impls.
- `apps/web/src/app/(public)/flash/[token]/page.tsx` + `apps/web/src/app/api/flash/route.ts` — Flash HTML route + on-demand trigger.

---

# SLICE 1 — event re-model + core (offline)

## Task 1: Event vocabulary re-model

**Files:**
- Modify: `packages/orchestrator/src/events.ts`
- Modify: `packages/orchestrator/src/publishers.ts`
- Modify: `packages/orchestrator/src/events.test.ts`, `engine.test.ts`, `acceptance.test.ts`, `publishers.test.ts`, `triggers.test.ts`, `store.test.ts`
- Modify: `packages/db/src/orchestrator/store.test.ts`, `integration.test.ts`

**Interfaces:**
- Produces (new/changed `payloadSchemas` entries):
  - `"lead.created": { leadId: string; customerId: string; source: string }`
  - `"contract.signed": { jobId: string; customerId: string; contractValueCents: number }`
  - `"invoice.created": { invoiceId: string; jobId: string; amountCents: number }`
  - `"appointment.set": { appointmentId: string; leadId?: string; jobId?: string; scheduledAt: string }`
  - `"appointment.no_show": { appointmentId: string; jobId?: string }`
  - Publisher signature changes: `publishLeadCreated(o, { tenantId, leadId, customerId, source, actor? })`, `publishContractSigned(o, { tenantId, jobId, customerId, contractValueCents, actor? })`.

- [ ] **Step 1: Update the payload schemas (RED via existing tests)**

In `packages/orchestrator/src/events.ts`, change the three entries and add two, inside `payloadSchemas`:

```ts
  "lead.created": z.object({ leadId: z.string(), customerId: z.string(), source: z.string() }),
  ...
  "contract.signed": z.object({ jobId: z.string(), customerId: z.string(), contractValueCents: z.number().int() }),
  ...
  "invoice.created": z.object({ invoiceId: z.string(), jobId: z.string(), amountCents: z.number().int() }),
  "appointment.set": z.object({ appointmentId: z.string(), leadId: z.string().optional(), jobId: z.string().optional(), scheduledAt: z.string() }),
  "appointment.no_show": z.object({ appointmentId: z.string(), jobId: z.string().optional() }),
```

Leave `payment.received`/`supplement.approved` as `amountCents` (unchanged). Do NOT touch `triggers.ts`, `engine.ts`, `escalations.ts`, or the db store files.

- [ ] **Step 2: Run the orchestrator suite to see what the re-model broke**

Run: `pnpm --filter @savvy/orchestrator test`
Expected: FAILs in `events.test.ts`, `engine.test.ts`, `acceptance.test.ts`, `publishers.test.ts`, `triggers.test.ts`, `store.test.ts` — every `lead.created` payload now missing required `source`, every `contract.signed` missing `contractValueCents`. This failure list IS the blast radius.

- [ ] **Step 3: Update publishers to supply the new fields**

In `packages/orchestrator/src/publishers.ts`:

```ts
export function publishLeadCreated(
  o: Orchestrator, a: { tenantId: string; leadId: string; customerId: string; source: string; actor?: string },
): Promise<void> {
  return o.publish(makeEvent({
    type: "lead.created", source: "savvy", tenantId: a.tenantId,
    correlationId: a.leadId, idempotencyKey: `lead.created:${a.leadId}`,
    ...(a.actor ? { actor: a.actor } : {}),
    payload: { leadId: a.leadId, customerId: a.customerId, source: a.source },
  }));
}

export function publishContractSigned(
  o: Orchestrator, a: { tenantId: string; jobId: string; customerId: string; contractValueCents: number; actor?: string },
): Promise<void> {
  return o.publish(makeEvent({
    type: "contract.signed", source: "canvass", tenantId: a.tenantId,
    correlationId: a.jobId, idempotencyKey: `contract.signed:${a.jobId}`,
    ...(a.actor ? { actor: a.actor } : {}),
    payload: { jobId: a.jobId, customerId: a.customerId, contractValueCents: a.contractValueCents },
  }));
}
```

`publishPaymentReceived` is unchanged (still `amountCents`).

- [ ] **Step 4: Update every failing test to supply the new required fields**

For each failing construction, add the field. Examples:
- `lead.created` payloads: add `source: "web"` (or `"canvass"` where the test cares).
- `contract.signed` payloads: add `contractValueCents: 2400000`.
- `invoice.created` payloads (if any constructed directly): add `amountCents`.
- Publisher tests: pass `source` / `contractValueCents` in the args.

Do NOT weaken any assertion — only add the required fields. In `packages/db/src/orchestrator/store.test.ts` + `integration.test.ts`, the `ev()`/publish helpers building `lead.created` gain `source`.

- [ ] **Step 5: Run the full orchestrator + db-orchestrator suites GREEN**

Run:
```bash
pnpm --filter @savvy/orchestrator test
pnpm --filter @savvy/orchestrator typecheck
pnpm --filter @savvy/db test orchestrator
```
Expected: all green (orchestrator back to its full count; db orchestrator 5/5). Lint clean: `pnpm --filter @savvy/orchestrator lint`.

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src packages/db/src/orchestrator
git commit -m "feat(orchestrator): re-model event vocabulary for Command Center (appointments, source, contractValueCents, invoice amountCents)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: command-center scaffold + Denver day-window

**Files:**
- Create: `packages/command-center/package.json`, `tsconfig.json`
- Create: `packages/command-center/src/day-window.ts`, `src/index.ts`
- Test: `packages/command-center/src/day-window.test.ts`

**Interfaces:**
- Produces:
  - `denverDayWindow(businessDate: string): { startUtc: Date; endUtc: Date }` — the UTC instants bounding a Denver calendar day `[start, end)`.
  - `businessDateOf(occurredAtUtc: string | Date): string` — the `YYYY-MM-DD` Denver date an instant falls in.
  - `const BUSINESS_TZ = "America/Denver"`.

- [ ] **Step 1: Scaffold the package**

Create `packages/command-center/package.json`:
```json
{
  "name": "@savvy/command-center",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "lint": "eslint .", "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": { "@savvy/orchestrator": "workspace:*", "zod": "^3.23.0" },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.1.0" }
}
```
Create `packages/command-center/tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src"] }`. Run `pnpm install` from repo root.

- [ ] **Step 2: Write the failing test**

Create `packages/command-center/src/day-window.test.ts`:
```ts
import { it, expect } from "vitest";
import { denverDayWindow, businessDateOf } from "./day-window";

it("businessDateOf buckets a late-night MT instant into the correct Denver day", () => {
  // 2026-07-02 04:30 UTC = 2026-07-01 22:30 MDT → belongs to 2026-07-01
  expect(businessDateOf("2026-07-02T04:30:00Z")).toBe("2026-07-01");
  // 2026-07-02 07:00 UTC = 2026-07-02 01:00 MDT → belongs to 2026-07-02
  expect(businessDateOf("2026-07-02T07:00:00Z")).toBe("2026-07-02");
});

it("denverDayWindow returns a 24h UTC window for a summer (MDT, -6) date", () => {
  const { startUtc, endUtc } = denverDayWindow("2026-07-01");
  expect(startUtc.toISOString()).toBe("2026-07-01T06:00:00.000Z"); // 00:00 MDT
  expect(endUtc.toISOString()).toBe("2026-07-02T06:00:00.000Z");
});

it("an instant inside the window buckets to that date; the window is half-open", () => {
  const { startUtc, endUtc } = denverDayWindow("2026-07-01");
  expect(businessDateOf(startUtc)).toBe("2026-07-01");
  expect(businessDateOf(new Date(endUtc.getTime() - 1))).toBe("2026-07-01");
  expect(businessDateOf(endUtc)).toBe("2026-07-02"); // end is exclusive
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @savvy/command-center test day-window`
Expected: FAIL — `Cannot find module './day-window'`.

- [ ] **Step 4: Implement `day-window.ts`**

```ts
export const BUSINESS_TZ = "America/Denver";

// Parts of an instant, rendered in the business timezone, via native Intl
// (the finance.ts/datetime.ts precedent — no date-fns-tz dependency).
function denverParts(d: Date): { y: number; m: number; day: number; h: number; min: number; s: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(d)) if (part.type !== "literal") p[part.type] = part.value;
  // Intl can emit hour "24" at midnight; normalize to 0.
  const h = p.hour === "24" ? 0 : Number(p.hour);
  return { y: Number(p.year), m: Number(p.month), day: Number(p.day), h, min: Number(p.minute), s: Number(p.second) };
}

/** The YYYY-MM-DD Denver calendar date an instant falls in. */
export function businessDateOf(occurredAtUtc: string | Date): string {
  const d = typeof occurredAtUtc === "string" ? new Date(occurredAtUtc) : occurredAtUtc;
  const { y, m, day } = denverParts(d);
  return `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

/** The UTC instant that is 00:00:00 Denver on the given YYYY-MM-DD. */
function denverMidnightUtc(businessDate: string): Date {
  const [y, m, d] = businessDate.split("-").map(Number);
  // Guess local-noon UTC for the date, read back the Denver offset, then correct.
  // Two-pass is robust across DST boundaries.
  let guess = new Date(Date.UTC(y!, m! - 1, d!, 12, 0, 0));
  for (let i = 0; i < 2; i++) {
    const parts = denverParts(guess);
    const asUtcOfDenverWallClock = Date.UTC(parts.y, parts.m - 1, parts.day, parts.h, parts.min, parts.s);
    const offsetMs = asUtcOfDenverWallClock - guess.getTime(); // Denver = UTC + offsetMs
    // We want Denver wall clock = date 00:00:00 → its UTC = Date.UTC(date,0,0,0) - offsetMs
    guess = new Date(Date.UTC(y!, m! - 1, d!, 0, 0, 0) - offsetMs);
  }
  return guess;
}

export function denverDayWindow(businessDate: string): { startUtc: Date; endUtc: Date } {
  const startUtc = denverMidnightUtc(businessDate);
  const [y, m, d] = businessDate.split("-").map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1));
  const nextDate = `${next.getUTCFullYear()}-${(next.getUTCMonth() + 1).toString().padStart(2, "0")}-${next.getUTCDate().toString().padStart(2, "0")}`;
  return { startUtc, endUtc: denverMidnightUtc(nextDate) };
}
```

Create `src/index.ts`: `export * from "./day-window";`.

- [ ] **Step 5: Run GREEN + typecheck**

Run: `pnpm --filter @savvy/command-center test day-window && pnpm --filter @savvy/command-center typecheck`
Expected: PASS (3 tests), tsc clean. If a DST-boundary assertion is off, the two-pass offset correction is the place to look — do not hardcode -6/-7.

- [ ] **Step 6: Commit**

```bash
git add packages/command-center pnpm-lock.yaml
git commit -m "feat(command-center): package scaffold + Denver business-day window (native Intl)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: DailyMetrics type + projectDay reducer

**Files:**
- Create: `packages/command-center/src/metrics.ts`, `src/projection.ts`
- Modify: `packages/command-center/src/index.ts`
- Test: `packages/command-center/src/projection.test.ts`

**Interfaces:**
- Consumes: `businessDateOf` (Task 2); `DomainEvent`, `EventType`, `PayloadFor` from `@savvy/orchestrator`.
- Produces:
  - `interface DailyMetrics` (see code) — the canonical projected shape (Day-4 reads it too).
  - `projectDay(events: DomainEvent[], businessDate: string): DailyMetrics` — pure; filters events to the Denver date via `businessDateOf(e.occurredAt)`, folds them. Excludes `handler.failed` / lifecycle-only events from business metrics.

- [ ] **Step 1: Write the failing test**

Create `packages/command-center/src/projection.test.ts`:
```ts
import { it, expect } from "vitest";
import { projectDay } from "./projection";
import { makeEvent, type DomainEvent } from "@savvy/orchestrator";

const T = "11111111-1111-1111-1111-111111111111";
const D = "2026-07-01";
const at = (h: number, min = 0) => new Date(Date.UTC(2026, 6, 1, 6 + h, min)).toISOString(); // 6:00Z = 00:00 MDT
function ev<Tp extends Parameters<typeof makeEvent>[0]["type"]>(type: Tp, payload: unknown, occurredAt: string): DomainEvent {
  return makeEvent({ type, source: "savvy", tenantId: T, correlationId: "c", idempotencyKey: `${type}:${Math.random()}`, occurredAt, payload } as never);
}

it("folds top-line counts and money for the day", () => {
  const events: DomainEvent[] = [
    ev("lead.created", { leadId: "l1", customerId: "c1", source: "canvass" }, at(1)),
    ev("lead.created", { leadId: "l2", customerId: "c2", source: "web" }, at(1)),
    ev("lead.created", { leadId: "l3", customerId: "c3", source: "web" }, at(1)),
    ev("appointment.set", { appointmentId: "a1", scheduledAt: at(2) }, at(2)),
    ev("appointment.no_show", { appointmentId: "a2" }, at(3)),
    ev("contract.signed", { jobId: "j1", customerId: "c1", contractValueCents: 2400000 }, at(4)),
    ev("contract.signed", { jobId: "j2", customerId: "c2", contractValueCents: 1800000 }, at(4)),
    ev("job.completed", { jobId: "j1" }, at(5)),
    ev("invoice.created", { invoiceId: "i1", jobId: "j1", amountCents: 2400000 }, at(6)),
    ev("payment.received", { invoiceId: "i1", amountCents: 2400000 }, at(7)),
  ];
  const m = projectDay(events, D);
  expect(m.topLine.leadsTotal).toBe(3);
  expect(m.topLine.leadsBySource).toEqual({ canvass: 1, web: 2 });
  expect(m.topLine.appointmentsSet).toBe(1);
  expect(m.topLine.appointmentsNoShow).toBe(1);
  expect(m.topLine.contractsSigned).toBe(2);
  expect(m.topLine.contractValueCents).toBe(4200000);
  expect(m.topLine.jobsCompleted).toBe(1);
  expect(m.money.invoicedCents).toBe(2400000);
  expect(m.money.cashCollectedCents).toBe(2400000);
});

it("computes median speed-to-lead and % under 5 min; a lead with no first touch is excluded from median but counted in the SLA %", () => {
  const events: DomainEvent[] = [
    ev("lead.created", { leadId: "l1", customerId: "c1", source: "web" }, at(1, 0)),
    ev("lead.first_touch", { leadId: "l1", channel: "sms" }, at(1, 3)), // 3 min → under 5
    ev("lead.created", { leadId: "l2", customerId: "c2", source: "web" }, at(2, 0)),
    ev("lead.first_touch", { leadId: "l2", channel: "sms" }, at(2, 9)), // 9 min → over 5
    ev("lead.created", { leadId: "l3", customerId: "c3", source: "web" }, at(3, 0)), // never touched
  ];
  const m = projectDay(events, D);
  expect(m.speed.medianSpeedToLeadMs).toBe(6 * 60_000); // median of [3min, 9min] = 6min
  expect(m.speed.pctLeadsUnder5Min).toBeCloseTo(1 / 3); // 1 of 3 leads
});

it("a quiet day yields zeroed metrics, no crash", () => {
  const m = projectDay([], D);
  expect(m.businessDate).toBe(D);
  expect(m.topLine.leadsTotal).toBe(0);
  expect(m.speed.medianSpeedToLeadMs).toBeNull();
  expect(m.quality.avgStars).toBeNull();
});

it("ignores events from other days", () => {
  const other = new Date(Date.UTC(2026, 6, 3, 12)).toISOString();
  const m = projectDay([ev("lead.created", { leadId: "x", customerId: "c", source: "web" }, other)], D);
  expect(m.topLine.leadsTotal).toBe(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @savvy/command-center test projection`
Expected: FAIL — `Cannot find module './projection'`.

- [ ] **Step 3: Implement `metrics.ts` then `projection.ts`**

`packages/command-center/src/metrics.ts`:
```ts
export interface DailyMetrics {
  businessDate: string; // YYYY-MM-DD Denver
  topLine: {
    leadsTotal: number;
    leadsBySource: Record<string, number>;
    appointmentsSet: number;
    appointmentsNoShow: number;
    contractsSigned: number;
    contractValueCents: number;
    jobsCompleted: number;
  };
  money: {
    invoicedCents: number;
    cashCollectedCents: number;
    supplementsApprovedCents: number;
    arPastDue: { d30: number; d60: number; d90: number }; // counts by bucket
  };
  speed: { medianSpeedToLeadMs: number | null; pctLeadsUnder5Min: number | null };
  quality: { reviewsPosted: number; avgStars: number | null };
  production: { estimatesApproved: number; avgMarginPct: number | null; materialOrders: number };
}

export function emptyMetrics(businessDate: string): DailyMetrics {
  return {
    businessDate,
    topLine: { leadsTotal: 0, leadsBySource: {}, appointmentsSet: 0, appointmentsNoShow: 0, contractsSigned: 0, contractValueCents: 0, jobsCompleted: 0 },
    money: { invoicedCents: 0, cashCollectedCents: 0, supplementsApprovedCents: 0, arPastDue: { d30: 0, d60: 0, d90: 0 } },
    speed: { medianSpeedToLeadMs: null, pctLeadsUnder5Min: null },
    quality: { reviewsPosted: 0, avgStars: null },
    production: { estimatesApproved: 0, avgMarginPct: null, materialOrders: 0 },
  };
}
```

`packages/command-center/src/projection.ts`:
```ts
import type { DomainEvent, PayloadFor } from "@savvy/orchestrator";
import { businessDateOf } from "./day-window";
import { emptyMetrics, type DailyMetrics } from "./metrics";

const SLA_MS = 5 * 60_000;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function projectDay(events: DomainEvent[], businessDate: string): DailyMetrics {
  const day = events.filter((e) => businessDateOf(e.occurredAt) === businessDate);
  const m = emptyMetrics(businessDate);

  // speed-to-lead: pair lead.created with the first lead.first_touch by leadId (same day)
  const createdAt = new Map<string, number>();
  const firstTouchAt = new Map<string, number>();

  const stars: number[] = [];
  const margins: number[] = [];
  const pastDueByInvoice = new Map<string, number>(); // latest daysPastDue per invoice

  for (const e of day) {
    switch (e.type) {
      case "lead.created": {
        const p = e.payload as PayloadFor<"lead.created">;
        m.topLine.leadsTotal += 1;
        m.topLine.leadsBySource[p.source] = (m.topLine.leadsBySource[p.source] ?? 0) + 1;
        createdAt.set(p.leadId, Date.parse(e.occurredAt));
        break;
      }
      case "lead.first_touch": {
        const p = e.payload as PayloadFor<"lead.first_touch">;
        const t = Date.parse(e.occurredAt);
        if (!firstTouchAt.has(p.leadId) || t < firstTouchAt.get(p.leadId)!) firstTouchAt.set(p.leadId, t);
        break;
      }
      case "appointment.set": m.topLine.appointmentsSet += 1; break;
      case "appointment.no_show": m.topLine.appointmentsNoShow += 1; break;
      case "contract.signed": {
        const p = e.payload as PayloadFor<"contract.signed">;
        m.topLine.contractsSigned += 1;
        m.topLine.contractValueCents += p.contractValueCents;
        break;
      }
      case "job.completed": m.topLine.jobsCompleted += 1; break;
      case "invoice.created": {
        const p = e.payload as PayloadFor<"invoice.created">;
        m.money.invoicedCents += p.amountCents;
        break;
      }
      case "payment.received": {
        const p = e.payload as PayloadFor<"payment.received">;
        m.money.cashCollectedCents += p.amountCents;
        break;
      }
      case "supplement.approved": {
        const p = e.payload as PayloadFor<"supplement.approved">;
        m.money.supplementsApprovedCents += p.amountCents;
        break;
      }
      case "invoice.past_due": {
        const p = e.payload as PayloadFor<"invoice.past_due">;
        pastDueByInvoice.set(p.invoiceId, p.daysPastDue);
        break;
      }
      case "review.posted": {
        const p = e.payload as PayloadFor<"review.posted">;
        m.quality.reviewsPosted += 1;
        stars.push(p.stars);
        break;
      }
      case "estimate.approved": {
        const p = e.payload as PayloadFor<"estimate.approved">;
        m.production.estimatesApproved += 1;
        margins.push(p.marginPct);
        break;
      }
      case "material.order.created": m.production.materialOrders += 1; break;
      default: break; // lifecycle / system events don't contribute business metrics
    }
  }

  // AR buckets (30/60/90) from the latest past-due reading per invoice
  for (const days of pastDueByInvoice.values()) {
    if (days >= 90) m.money.arPastDue.d90 += 1;
    else if (days >= 60) m.money.arPastDue.d60 += 1;
    else if (days >= 30) m.money.arPastDue.d30 += 1;
  }

  // speed-to-lead
  const durations: number[] = [];
  let underSla = 0;
  for (const [leadId, created] of createdAt) {
    const touched = firstTouchAt.get(leadId);
    if (touched !== undefined) {
      const dur = touched - created;
      durations.push(dur);
      if (dur <= SLA_MS) underSla += 1;
    }
  }
  m.speed.medianSpeedToLeadMs = median(durations);
  m.speed.pctLeadsUnder5Min = createdAt.size === 0 ? null : underSla / createdAt.size;

  m.quality.avgStars = stars.length ? stars.reduce((a, b) => a + b, 0) / stars.length : null;
  m.production.avgMarginPct = margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : null;

  return m;
}
```

Add to `src/index.ts`: `export * from "./metrics";` and `export * from "./projection";`.

- [ ] **Step 4: Run GREEN + typecheck**

Run: `pnpm --filter @savvy/command-center test projection && pnpm --filter @savvy/command-center typecheck`
Expected: PASS (4 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/command-center/src
git commit -m "feat(command-center): DailyMetrics + projectDay reducer over the event log

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: comparison deltas

**Files:**
- Create: `packages/command-center/src/comparison.ts`
- Modify: `packages/command-center/src/index.ts`
- Test: `packages/command-center/src/comparison.test.ts`

**Interfaces:**
- Consumes: `DailyMetrics` (Task 3).
- Produces:
  - `interface FlashComparison { leadsTotalVsYesterday: number | null; contractValueVsTrailing7: number | null; cashCollectedVsTrailing7: number | null }`
  - `compareMetrics(today: DailyMetrics, yesterday: DailyMetrics | null, trailing7: DailyMetrics[]): FlashComparison` — deltas; missing history → `null` (no crash).

- [ ] **Step 1: Write the failing test**

```ts
import { it, expect } from "vitest";
import { compareMetrics } from "./comparison";
import { emptyMetrics } from "./metrics";

function withLeads(date: string, leads: number, contractCents = 0, cashCents = 0) {
  const m = emptyMetrics(date);
  m.topLine.leadsTotal = leads; m.topLine.contractValueCents = contractCents; m.money.cashCollectedCents = cashCents;
  return m;
}

it("computes vs-yesterday and vs-trailing-7-average", () => {
  const today = withLeads("2026-07-08", 10, 5_000_00, 4_000_00);
  const yest = withLeads("2026-07-07", 6);
  const trailing = [1, 2, 3, 4, 5, 6, 7].map((d) => withLeads(`2026-07-0${d}`, 0, 3_000_00, 2_000_00));
  const c = compareMetrics(today, yest, trailing);
  expect(c.leadsTotalVsYesterday).toBe(4);
  expect(c.contractValueVsTrailing7).toBe(5_000_00 - 3_000_00); // today − avg(3_000_00)
  expect(c.cashCollectedVsTrailing7).toBe(4_000_00 - 2_000_00);
});

it("returns null deltas when history is missing (no crash)", () => {
  const c = compareMetrics(withLeads("2026-07-01", 5), null, []);
  expect(c.leadsTotalVsYesterday).toBeNull();
  expect(c.contractValueVsTrailing7).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @savvy/command-center test comparison` → FAIL (module missing).

- [ ] **Step 3: Implement `comparison.ts`**

```ts
import type { DailyMetrics } from "./metrics";

export interface FlashComparison {
  leadsTotalVsYesterday: number | null;
  contractValueVsTrailing7: number | null;
  cashCollectedVsTrailing7: number | null;
}

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function compareMetrics(
  today: DailyMetrics, yesterday: DailyMetrics | null, trailing7: DailyMetrics[],
): FlashComparison {
  const cvAvg = avg(trailing7.map((m) => m.topLine.contractValueCents));
  const cashAvg = avg(trailing7.map((m) => m.money.cashCollectedCents));
  return {
    leadsTotalVsYesterday: yesterday ? today.topLine.leadsTotal - yesterday.topLine.leadsTotal : null,
    contractValueVsTrailing7: cvAvg === null ? null : today.topLine.contractValueCents - cvAvg,
    cashCollectedVsTrailing7: cashAvg === null ? null : today.money.cashCollectedCents - cashAvg,
  };
}
```
Add to `src/index.ts`: `export * from "./comparison";`.

- [ ] **Step 4: Run GREEN + typecheck** — PASS (2 tests), tsc clean.

- [ ] **Step 5: Commit**
```bash
git add packages/command-center/src
git commit -m "feat(command-center): comparison deltas (vs yesterday / trailing-7)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: exception-queue lifecycle + in-memory store

**Files:**
- Create: `packages/command-center/src/exception-queue.ts`
- Modify: `packages/command-center/src/index.ts`
- Test: `packages/command-center/src/exception-queue.test.ts`

**Interfaces:**
- Consumes: `EscalationRecord` from `@savvy/orchestrator`.
- Produces:
  - `type QueueState = "open" | "acknowledged" | "resolved" | "snoozed"`
  - `interface QueueItem { key: string; escalationId: string; idempotencyKey: string; ruleId: string; severity: string; reason: string; notify: string[]; assignee: string; state: QueueState; acknowledgedAt: string | null; resolvedAt: string | null; resolutionNote: string | null; snoozeUntil: string | null; createdAt: string }`
  - `class ExceptionQueue` with: `intake(esc: EscalationRecord, at: string): QueueItem` (idempotent on `escalationId:idempotencyKey`), `acknowledge(key, assignee, at)`, `resolve(key, note, at)`, `snooze(key, until, at)`, `needsYou(assignee, now): QueueItem[]` (state `open`, or `snoozed` past `snoozeUntil`, assigned to `assignee`), `openCount(now): { total: number; bySeverity: Record<string, number> }`, `all(): QueueItem[]`.
  - Intake sets `assignee` = first of `notify`, or `"unassigned"`.

- [ ] **Step 1: Write the failing test**

```ts
import { it, expect } from "vitest";
import { ExceptionQueue } from "./exception-queue";
import type { EscalationRecord } from "@savvy/orchestrator";

const T = "11111111-1111-1111-1111-111111111111";
function esc(over: Partial<EscalationRecord> = {}): EscalationRecord {
  return { tenantId: T, correlationId: "c", eventId: "e1", eventType: "estimate.approved",
    ruleId: "low-margin", severity: "high", reason: "18% margin", notify: ["arrington", "sales-manager"], ...over } as EscalationRecord;
}

it("intake is idempotent on (escalationId, idempotencyKey)", () => {
  const q = new ExceptionQueue();
  const e = { ...esc(), id: "esc1", idempotencyKey: "k1" } as never;
  q.intake(e, "2026-07-01T18:00:00Z");
  q.intake(e, "2026-07-01T18:00:00Z");
  expect(q.all()).toHaveLength(1);
});

it("routes assignee from notify[0] and surfaces arrington items in needsYou", () => {
  const q = new ExceptionQueue();
  q.intake({ ...esc(), id: "esc1", idempotencyKey: "k1" } as never, "2026-07-01T18:00:00Z");
  const mine = q.needsYou("arrington", new Date("2026-07-01T19:00:00Z"));
  expect(mine).toHaveLength(1);
  expect(mine[0]!.assignee).toBe("arrington");
});

it("acknowledge leaves open but keeps the record; resolve never deletes", () => {
  const q = new ExceptionQueue();
  const item = q.intake({ ...esc(), id: "esc1", idempotencyKey: "k1" } as never, "2026-07-01T18:00:00Z");
  q.acknowledge(item.key, "arrington", "2026-07-01T18:05:00Z");
  expect(q.needsYou("arrington", new Date("2026-07-01T19:00:00Z"))).toHaveLength(0); // acknowledged leaves open
  q.resolve(item.key, "fixed pricing", "2026-07-01T18:10:00Z");
  const all = q.all();
  expect(all).toHaveLength(1); // not deleted
  expect(all[0]!.state).toBe("resolved");
  expect(all[0]!.resolutionNote).toBe("fixed pricing");
});

it("snooze drops it off needsYou until snoozeUntil passes", () => {
  const q = new ExceptionQueue();
  const item = q.intake({ ...esc(), id: "esc1", idempotencyKey: "k1" } as never, "2026-07-01T18:00:00Z");
  q.snooze(item.key, "2026-07-02T18:00:00Z", "2026-07-01T18:05:00Z");
  expect(q.needsYou("arrington", new Date("2026-07-01T20:00:00Z"))).toHaveLength(0); // snoozed
  expect(q.needsYou("arrington", new Date("2026-07-03T00:00:00Z"))).toHaveLength(1); // snooze elapsed
  expect(q.all()).toHaveLength(1); // never deleted
});

it("openCount groups by severity", () => {
  const q = new ExceptionQueue();
  q.intake({ ...esc(), id: "a", idempotencyKey: "1", severity: "high" } as never, "2026-07-01T18:00:00Z");
  q.intake({ ...esc(), id: "b", idempotencyKey: "2", severity: "medium", notify: ["claims"] } as never, "2026-07-01T18:00:00Z");
  const c = q.openCount(new Date("2026-07-01T19:00:00Z"));
  expect(c.total).toBe(2);
  expect(c.bySeverity).toEqual({ high: 1, medium: 1 });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @savvy/command-center test exception-queue` → FAIL (module missing).

- [ ] **Step 3: Implement `exception-queue.ts`**

```ts
import type { EscalationRecord } from "@savvy/orchestrator";

export type QueueState = "open" | "acknowledged" | "resolved" | "snoozed";

export interface QueueItem {
  key: string; // `${escalationId}:${idempotencyKey}`
  escalationId: string;
  idempotencyKey: string;
  ruleId: string;
  severity: string;
  reason: string;
  notify: string[];
  assignee: string;
  state: QueueState;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  snoozeUntil: string | null;
  createdAt: string;
}

// EscalationRecord as delivered to the queue also carries the source escalation's
// own id + the triggering event's idempotencyKey (added by the intake caller).
type IntakeRecord = EscalationRecord & { id: string; idempotencyKey: string };

export class ExceptionQueue {
  private items = new Map<string, QueueItem>();

  intake(esc: IntakeRecord, at: string): QueueItem {
    const key = `${esc.id}:${esc.idempotencyKey}`;
    const existing = this.items.get(key);
    if (existing) return existing; // idempotent
    const item: QueueItem = {
      key, escalationId: esc.id, idempotencyKey: esc.idempotencyKey, ruleId: esc.ruleId,
      severity: esc.severity, reason: esc.reason, notify: esc.notify,
      assignee: esc.notify[0] ?? "unassigned",
      state: "open", acknowledgedAt: null, resolvedAt: null, resolutionNote: null, snoozeUntil: null, createdAt: at,
    };
    this.items.set(key, item);
    return item;
  }

  acknowledge(key: string, assignee: string, at: string): void {
    const it = this.items.get(key); if (!it) return;
    it.state = "acknowledged"; it.assignee = assignee; it.acknowledgedAt = at;
  }

  resolve(key: string, note: string, at: string): void {
    const it = this.items.get(key); if (!it) return;
    it.state = "resolved"; it.resolutionNote = note; it.resolvedAt = at;
  }

  snooze(key: string, until: string, at: string): void {
    const it = this.items.get(key); if (!it) return;
    it.state = "snoozed"; it.snoozeUntil = until; it.acknowledgedAt = at;
  }

  /** Items needing THIS assignee's attention now: open, or snoozed past their snoozeUntil. */
  needsYou(assignee: string, now: Date): QueueItem[] {
    return [...this.items.values()].filter((it) => it.assignee === assignee && this.isActive(it, now));
  }

  openCount(now: Date): { total: number; bySeverity: Record<string, number> } {
    const active = [...this.items.values()].filter((it) => this.isActive(it, now));
    const bySeverity: Record<string, number> = {};
    for (const it of active) bySeverity[it.severity] = (bySeverity[it.severity] ?? 0) + 1;
    return { total: active.length, bySeverity };
  }

  all(): QueueItem[] { return [...this.items.values()]; }

  // "Active" = needs attention: strictly open, or a snooze whose time has passed.
  // acknowledged/resolved are not active. A snooze still in the future is not active.
  private isActive(it: QueueItem, now: Date): boolean {
    if (it.state === "open") return true;
    if (it.state === "snoozed" && it.snoozeUntil && new Date(it.snoozeUntil) <= now) return true;
    return false;
  }
}
```
Add to `src/index.ts`: `export * from "./exception-queue";`.

- [ ] **Step 4: Run GREEN + typecheck** — PASS (5 tests), tsc clean.

- [ ] **Step 5: Commit**
```bash
git add packages/command-center/src
git commit -m "feat(command-center): exception-queue lifecycle (states, idempotent intake, routing)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Flash renderer (HTML + headline)

**Files:**
- Create: `packages/command-center/src/flash.ts`
- Modify: `packages/command-center/src/index.ts`
- Test: `packages/command-center/src/flash.test.ts`

**Interfaces:**
- Consumes: `DailyMetrics` (Task 3), `FlashComparison` (Task 4), `QueueItem` (Task 5).
- Produces:
  - `dollars(cents: number): string` — `"$24,000"` (whole dollars, thousands-grouped).
  - `renderFlashHeadline(metrics: DailyMetrics, needsYou: QueueItem[]): string` — one-line SMS text, ids/totals only.
  - `renderFlashHtml(metrics: DailyMetrics, needsYou: QueueItem[], comparison: FlashComparison, opts?: { flashUrl?: string }): string` — self-contained phone-first HTML; "Needs you" pinned top; missing values render "—".

- [ ] **Step 1: Write the failing test**

```ts
import { it, expect } from "vitest";
import { renderFlashHeadline, renderFlashHtml, dollars } from "./flash";
import { emptyMetrics } from "./metrics";

it("dollars formats cents to whole grouped dollars", () => {
  expect(dollars(2400000)).toBe("$24,000");
  expect(dollars(0)).toBe("$0");
});

it("headline carries totals + open-exception count, no PII", () => {
  const m = emptyMetrics("2026-07-01");
  m.topLine.leadsTotal = 5; m.topLine.contractsSigned = 2; m.topLine.contractValueCents = 4200000; m.money.cashCollectedCents = 2400000;
  const h = renderFlashHeadline(m, [{ severity: "high" } as never, { severity: "high" } as never]);
  expect(h).toContain("5 leads");
  expect(h).toContain("$42,000");
  expect(h).toContain("2 need you");
  expect(h).not.toMatch(/customer|@|\bcard\b/i);
});

it("quiet day headline says quiet, zero exceptions", () => {
  const h = renderFlashHeadline(emptyMetrics("2026-07-01"), []);
  expect(h.toLowerCase()).toContain("quiet");
});

it("HTML pins Needs you at top and renders — for null metrics", () => {
  const m = emptyMetrics("2026-07-01"); // medianSpeedToLeadMs null etc.
  const html = renderFlashHtml(m, [{ severity: "high", reason: "18% margin", ruleId: "low-margin" } as never], { leadsTotalVsYesterday: null, contractValueVsTrailing7: null, cashCollectedVsTrailing7: null });
  const needsIdx = html.indexOf("Needs you");
  const moneyIdx = html.indexOf("Cash collected");
  expect(needsIdx).toBeGreaterThanOrEqual(0);
  expect(needsIdx).toBeLessThan(moneyIdx); // pinned above money
  expect(html).toContain("—"); // null speed rendered as em dash
  expect(html).toContain("18% margin");
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @savvy/command-center test flash` → FAIL (module missing).

- [ ] **Step 3: Implement `flash.ts`**

```ts
import type { DailyMetrics } from "./metrics";
import type { FlashComparison } from "./comparison";
import type { QueueItem } from "./exception-queue";

export function dollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}
const dash = (v: number | null, fmt: (n: number) => string): string => (v === null ? "—" : fmt(v));

export function renderFlashHeadline(m: DailyMetrics, needsYou: QueueItem[]): string {
  const t = m.topLine;
  const quiet = t.leadsTotal === 0 && t.contractsSigned === 0 && m.money.cashCollectedCents === 0 && needsYou.length === 0;
  if (quiet) return `Savvy Daily Flash ${m.businessDate}: quiet day — nothing needs you.`;
  const need = needsYou.length ? `${needsYou.length} need you` : "0 need you";
  return `Savvy Daily Flash ${m.businessDate}: ${t.leadsTotal} leads, ${t.contractsSigned} signed (${dollars(t.contractValueCents)}), ${dollars(m.money.cashCollectedCents)} collected — ${need}.`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

export function renderFlashHtml(m: DailyMetrics, needsYou: QueueItem[], c: FlashComparison, opts: { flashUrl?: string } = {}): string {
  const t = m.topLine;
  const needsRows = needsYou.length
    ? needsYou.map((it) => `<li><b>[${esc(it.severity)}]</b> ${esc(it.reason)} <span class="rule">${esc(it.ruleId)}</span></li>`).join("")
    : `<li class="clear">All clear — the machine ran itself today.</li>`;
  const speed = m.speed.medianSpeedToLeadMs === null ? "—" : `${Math.round(m.speed.medianSpeedToLeadMs / 60000)}m`;
  const pct = m.speed.pctLeadsUnder5Min === null ? "—" : `${Math.round(m.speed.pctLeadsUnder5Min * 100)}%`;
  return `<!-- self-contained phone-first flash -->
<section class="flash" style="max-width:480px;margin:0 auto;font-family:system-ui,sans-serif">
  <header><h1>Daily Flash</h1><time>${esc(m.businessDate)} (Denver)</time></header>
  <div class="needs-you" style="background:#fff3f3;border:1px solid #f3caca;padding:12px;border-radius:8px">
    <h2>Needs you</h2><ul>${needsRows}</ul>
  </div>
  <div class="grid">
    <div><span>Leads</span><strong>${t.leadsTotal}</strong><em>${dash(c.leadsTotalVsYesterday, (n) => (n >= 0 ? `+${n}` : `${n}`))} vs yest</em></div>
    <div><span>Signed</span><strong>${t.contractsSigned} · ${dollars(t.contractValueCents)}</strong></div>
    <div><span>Appts</span><strong>${t.appointmentsSet} set · ${t.appointmentsNoShow} no-show</strong></div>
    <div><span>Jobs done</span><strong>${t.jobsCompleted}</strong></div>
    <div><span>Invoiced</span><strong>${dollars(m.money.invoicedCents)}</strong></div>
    <div><span>Cash collected</span><strong>${dollars(m.money.cashCollectedCents)}</strong></div>
    <div><span>Speed-to-lead</span><strong>${speed} · ${pct} &lt;5m</strong></div>
    <div><span>Reviews</span><strong>${m.quality.reviewsPosted} · ${dash(m.quality.avgStars, (n) => `${n.toFixed(1)}★`)}</strong></div>
  </div>
  ${opts.flashUrl ? `<a href="${esc(opts.flashUrl)}">see all</a>` : ""}
</section>`;
}
```
Add to `src/index.ts`: `export * from "./flash";`.

- [ ] **Step 4: Run GREEN + typecheck** — PASS (4 tests), tsc clean.

- [ ] **Step 5: Commit**
```bash
git add packages/command-center/src
git commit -m "feat(command-center): Flash renderer (phone-first HTML + SMS headline)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: §8 acceptance test + Slice 1 gate

**Files:**
- Create: `packages/command-center/src/acceptance.test.ts`

**Interfaces:**
- Consumes: everything above + `Orchestrator`, `InMemoryStore`, publishers, `evaluateEscalations` from `@savvy/orchestrator`.

The acceptance test drives events **through the real Day-1 `Orchestrator`** (into an `InMemoryStore`), reads the recorded `received`-outcome events back as the log, projects them, feeds the Day-1 escalations into the `ExceptionQueue`, renders the Flash, and asserts the eight §8 checks + prints the Flash and queue.

- [ ] **Step 1: Write the acceptance test**

```ts
import { it, expect } from "vitest";
import { Orchestrator, InMemoryStore, makeEvent, evaluateEscalations, type DomainEvent, type EscalationRecord } from "@savvy/orchestrator";
import { projectDay } from "./projection";
import { ExceptionQueue } from "./exception-queue";
import { renderFlashHeadline, renderFlashHtml } from "./flash";
import { compareMetrics } from "./comparison";
import { businessDateOf } from "./day-window";

const T = "11111111-1111-1111-1111-111111111111";
const D = "2026-07-01";
const at = (h: number, min = 0) => new Date(Date.UTC(2026, 6, 1, 6 + h, min)).toISOString();

// Publish helper that stamps occurredAt so events land on the Denver business day D.
async function fire(o: Orchestrator, type: DomainEvent["type"], payload: unknown, occurredAt: string, idem: string) {
  await o.publish(makeEvent({ type, source: "savvy", tenantId: T, correlationId: "job", idempotencyKey: idem, occurredAt, payload } as never));
}
// The event log Day-2 reads = the store's `received`-outcome audit rows.
function logFrom(store: InMemoryStore): DomainEvent[] {
  return store.audits.filter((a) => a.outcome === "received").map((a) => a.event);
}

it("§8 acceptance: a business day projects to a correct Flash + workable exception queue", async () => {
  const store = new InMemoryStore();
  const o = new Orchestrator({ store });

  // (1) counts
  await fire(o, "lead.created", { leadId: "l1", customerId: "c1", source: "canvass" }, at(1), "lc1");
  await fire(o, "lead.created", { leadId: "l2", customerId: "c2", source: "canvass" }, at(1), "lc2");
  await fire(o, "lead.created", { leadId: "l3", customerId: "c3", source: "web" }, at(1), "lc3");
  await fire(o, "lead.created", { leadId: "l4", customerId: "c4", source: "web" }, at(1), "lc4");
  await fire(o, "lead.created", { leadId: "l5", customerId: "c5", source: "web" }, at(1), "lc5");
  await fire(o, "lead.first_touch", { leadId: "l1", channel: "sms" }, at(1, 3), "ft1"); // 3m
  await fire(o, "lead.first_touch", { leadId: "l2", channel: "sms" }, at(1, 9), "ft2"); // 9m
  await fire(o, "appointment.set", { appointmentId: "a1", scheduledAt: at(2) }, at(2), "as1");
  await fire(o, "appointment.set", { appointmentId: "a2", scheduledAt: at(2) }, at(2), "as2");
  await fire(o, "appointment.set", { appointmentId: "a3", scheduledAt: at(2) }, at(2), "as3");
  await fire(o, "appointment.no_show", { appointmentId: "a4" }, at(3), "an1");
  await fire(o, "contract.signed", { jobId: "j1", customerId: "c1", contractValueCents: 2400000 }, at(4), "cs1");
  await fire(o, "contract.signed", { jobId: "j2", customerId: "c2", contractValueCents: 1800000 }, at(4), "cs2");
  await fire(o, "job.completed", { jobId: "j1" }, at(5), "jc1");
  // (2) money
  await fire(o, "invoice.created", { invoiceId: "i1", jobId: "j1", amountCents: 2400000 }, at(6), "ic1");
  await fire(o, "payment.received", { invoiceId: "i1", amountCents: 2400000 }, at(7), "pr1");
  // (4) escalation sources
  await fire(o, "estimate.approved", { estimateId: "e1", jobId: "j1", marginPct: 18 }, at(4, 30), "ea1"); // low-margin
  await fire(o, "invoice.past_due", { invoiceId: "i9", daysPastDue: 92 }, at(8), "pd1"); // collections-90
  await fire(o, "review.posted", { jobId: "j1", stars: 2 }, at(9), "rp1"); // negative-review

  const log = logFrom(store);
  const metrics = projectDay(log, D);

  // (1)
  expect(metrics.topLine.leadsTotal).toBe(5);
  expect(metrics.topLine.leadsBySource).toEqual({ canvass: 2, web: 3 });
  expect(metrics.topLine.appointmentsSet).toBe(3);
  expect(metrics.topLine.appointmentsNoShow).toBe(1);
  expect(metrics.topLine.contractsSigned).toBe(2);
  expect(metrics.topLine.contractValueCents).toBe(4200000);
  expect(metrics.topLine.jobsCompleted).toBe(1);
  // (2)
  expect(metrics.money.invoicedCents).toBe(2400000);
  expect(metrics.money.cashCollectedCents).toBe(2400000);
  // (3)
  expect(metrics.speed.medianSpeedToLeadMs).toBe(6 * 60000);
  expect(metrics.speed.pctLeadsUnder5Min).toBeCloseTo(1 / 5);

  // (4) exception queue from Day-1 escalations
  const queue = new ExceptionQueue();
  for (const e of log) {
    for (const hit of evaluateEscalations(e)) {
      const rec: EscalationRecord = { ...hit, tenantId: e.tenantId, correlationId: e.correlationId, eventId: e.id, eventType: e.type };
      queue.intake({ ...rec, id: `${hit.ruleId}:${e.id}`, idempotencyKey: e.idempotencyKey } as never, e.occurredAt);
    }
  }
  const now = new Date(at(18));
  const ruleIds = queue.all().map((i) => i.ruleId);
  expect(ruleIds).toEqual(expect.arrayContaining(["low-margin", "collections-90", "negative-review"]));
  const mine = queue.needsYou("arrington", now); // low-margin + collections-90 notify arrington
  expect(mine.map((i) => i.ruleId).sort()).toEqual(["collections-90", "low-margin"]);

  // (5) lifecycle
  const ackTarget = mine[0]!;
  queue.acknowledge(ackTarget.key, "arrington", at(18, 5));
  expect(queue.needsYou("arrington", now).map((i) => i.key)).not.toContain(ackTarget.key);
  const snoozeTarget = queue.needsYou("arrington", now)[0]!;
  queue.snooze(snoozeTarget.key, at(30), at(18, 6)); // tomorrow
  expect(queue.needsYou("arrington", now).map((i) => i.key)).not.toContain(snoozeTarget.key);
  expect(queue.all().length).toBe(ruleIds.length); // nothing deleted

  // (6) idempotency: re-project + re-intake same log → identical
  const metrics2 = projectDay(log, D);
  expect(metrics2).toEqual(metrics);
  const before = queue.all().length;
  for (const e of log) for (const hit of evaluateEscalations(e))
    queue.intake({ ...hit, tenantId: e.tenantId, correlationId: e.correlationId, eventId: e.id, eventType: e.type, id: `${hit.ruleId}:${e.id}`, idempotencyKey: e.idempotencyKey } as never, e.occurredAt);
  expect(queue.all().length).toBe(before); // no dupes

  // (7) replay
  expect(projectDay(logFrom(store), D)).toEqual(metrics);

  // print
  const flashNeeds = queue.needsYou("arrington", now);
  // eslint-disable-next-line no-console
  console.log("\n" + renderFlashHeadline(metrics, flashNeeds));
  // eslint-disable-next-line no-console
  console.log(renderFlashHtml(metrics, flashNeeds, compareMetrics(metrics, null, [])).slice(0, 200) + "…");
});

it("§8(8) quiet day: an empty log yields a valid quiet-day flash, no crash, zero exceptions", () => {
  const metrics = projectDay([], D);
  const queue = new ExceptionQueue();
  expect(queue.openCount(new Date(at(18))).total).toBe(0);
  const headline = renderFlashHeadline(metrics, []);
  expect(headline.toLowerCase()).toContain("quiet");
  expect(() => renderFlashHtml(metrics, [], { leadsTotalVsYesterday: null, contractValueVsTrailing7: null, cashCollectedVsTrailing7: null })).not.toThrow();
});
```

> Implementer note: if the recorded log's `businessDateOf` disagrees with `D` because `makeEvent` fills `occurredAt` from the injected value, confirm every `fire()` passes an explicit `occurredAt` in the 6:00–15:00 UTC band (00:00–09:00 MDT) so all events bucket to `2026-07-01`. Do not stamp with a live clock.

- [ ] **Step 2: Run the acceptance test** — `pnpm --filter @savvy/command-center test acceptance` → PASS, prints headline + HTML head.

- [ ] **Step 3: Slice 1 gate** — run:
```bash
pnpm --filter @savvy/command-center test
pnpm --filter @savvy/command-center typecheck
pnpm --filter @savvy/command-center lint
pnpm --filter @savvy/orchestrator test   # re-model still green
```
Expected: all green.

- [ ] **Step 4: Commit + open PR (STOP for Brett's word before merge)**
```bash
git add packages/command-center/src/acceptance.test.ts
git commit -m "test(command-center): §8 acceptance — day projection → flash + exception queue

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin command-center-day2
gh pr create --title "Command Center Day 2 — Slice 1: event re-model + flash/queue core" --body "Read model over the Day-1 event log. Event re-model (appointments, source, contractValueCents, invoice amountCents) + packages/command-center core (Denver day-window, projectDay, exception-queue lifecycle, flash renderer, comparison) + §8 acceptance test through the real bus. No DB yet — Slice 2 adds persistence + web.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
Report the PR link + CI status. Do NOT merge.

---

# SLICE 2 — persistence + web + seams

## Task 8: daily_metrics + exception_queue tables + migration 0119

**Files:**
- Create: `packages/db/src/schema/command-center.ts`
- Modify: `packages/db/src/schema/index.ts` (append `export * from "./command-center";`)
- Modify: `packages/db/package.json` (add `"@savvy/command-center": "workspace:*"`)
- Create: `packages/db/drizzle/0119_*.sql` (generated)

**Interfaces:**
- Produces: `dailyMetrics`, `exceptionQueue` Drizzle tables.

- [ ] **Step 1: Add the dep** — add `"@savvy/command-center": "workspace:*"` to `packages/db/package.json` dependencies; `pnpm install`.

- [ ] **Step 2: Write the schema**

`packages/db/src/schema/command-center.ts` (follow `import-record.ts` pattern):
```ts
import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

// One projected row per (tenant, business_date). Upserted; rebuildable from the log.
export const dailyMetrics = pgTable("daily_metrics", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  businessDate: text("business_date").notNull(), // YYYY-MM-DD Denver
  metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("daily_metrics_date_uq").on(t.tenantId, t.businessDate),
  tenantIsolation(),
]);

// Stateful layer over orchestrator_escalation. Unique per (tenant, escalation_key) = idempotent intake.
export const exceptionQueue = pgTable("exception_queue", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  escalationKey: text("escalation_key").notNull(), // `${escalationId}:${idempotencyKey}`
  ruleId: text("rule_id").notNull(),
  severity: text("severity").notNull(),
  reason: text("reason").notNull(),
  notify: jsonb("notify").$type<string[]>().default([]).notNull(),
  assignee: text("assignee").notNull(),
  state: text("state").notNull().default("open"), // open|acknowledged|resolved|snoozed
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolutionNote: text("resolution_note"),
  snoozeUntil: timestamp("snooze_until", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("exception_queue_key_uq").on(t.tenantId, t.escalationKey),
  index("exception_queue_state_idx").on(t.tenantId, t.state),
  tenantIsolation(),
]);
```

- [ ] **Step 3: Register + generate + apply** — append the barrel export; `pnpm db:generate` → `0119_*.sql`. Confirm it creates both tables, `ENABLE ROW LEVEL SECURITY`, the `tenant_isolation` policies, and the unique indexes. Apply locally: `pnpm db:migrate`; if the shared local DB has drift, apply the `0119_*.sql` directly as the `postgres` superuser then `GRANT SELECT, INSERT, UPDATE, DELETE ON daily_metrics, exception_queue TO savvy_app;`.

- [ ] **Step 4: Commit**
```bash
git add packages/db/src/schema packages/db/drizzle packages/db/package.json pnpm-lock.yaml
git commit -m "feat(db): daily_metrics + exception_queue tables (RLS), migration 0119

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: db event-loader + metrics/queue persistence + round-trip test

**Files:**
- Create: `packages/db/src/command-center/read.ts`, `packages/db/src/command-center/store.ts`
- Modify: `packages/db/src/index.ts` (export the new functions + tables)
- Test: `packages/db/src/command-center/store.test.ts`

**Interfaces:**
- Consumes: `denverDayWindow`/`businessDateOf`/`DailyMetrics`/`QueueItem` from `@savvy/command-center`; `orchestratorEvent` from the db schema; `dailyMetrics`/`exceptionQueue` (Task 8); `withTenant`.
- Produces:
  - `loadEventsForDay(tenantId: string, businessDate: string): Promise<DomainEvent[]>` — selects `orchestrator_event` `received` rows in the Denver window, maps to `DomainEvent[]`. **New file — does not edit Day-1's store.**
  - `upsertDailyMetrics(tenantId, metrics: DailyMetrics): Promise<void>` (conflict on `(tenant, business_date)` → update).
  - `getDailyMetrics(tenantId, businessDate): Promise<DailyMetrics | null>`.
  - `upsertQueueItem(tenantId, item: QueueItem): Promise<void>` (conflict on `(tenant, escalation_key)` → update state fields).
  - `listQueue(tenantId): Promise<QueueItem[]>`.

- [ ] **Step 1: Write the failing integration test** (real local pg; pattern from `packages/db/src/orchestrator/store.test.ts`)

```ts
import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeEvent } from "@savvy/orchestrator";
import { projectDay } from "@savvy/command-center";
import { adminDb, tenant } from "../index";
import { orchestratorEvent } from "../schema/orchestrator";
import { dailyMetrics, exceptionQueue } from "../schema/command-center";
import { loadEventsForDay, upsertDailyMetrics, getDailyMetrics } from "./store";

let tenantId: string;
const D = "2026-07-01";
const at = (h: number) => new Date(Date.UTC(2026, 6, 1, 6 + h)).toISOString();

beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "CC-Test", publicKey: `cc-${tenantId.slice(0,8)}` });
  // seed 2 received events on day D
  for (const [i, src] of [["l1","web"],["l2","canvass"]].entries()) {
    const e = makeEvent({ type: "lead.created", source: "savvy", tenantId, correlationId: "c", idempotencyKey: `k${i}`, occurredAt: at(1), payload: { leadId: src[0], customerId: "c", source: src[1] } } as never);
    await adminDb.insert(orchestratorEvent).values({ tenantId, eventId: e.id, eventType: e.type, version: e.version, source: e.source, correlationId: e.correlationId, idempotencyKey: e.idempotencyKey, agent: "system", outcome: "received", emitted: [], payload: e.payload as Record<string, unknown> });
  }
});
afterAll(async () => {
  await adminDb.delete(exceptionQueue).where(eq(exceptionQueue.tenantId, tenantId));
  await adminDb.delete(dailyMetrics).where(eq(dailyMetrics.tenantId, tenantId));
  await adminDb.delete(orchestratorEvent).where(eq(orchestratorEvent.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

it("loadEventsForDay returns the day's received events; projectDay folds them", async () => {
  const log = await loadEventsForDay(tenantId, D);
  expect(log).toHaveLength(2);
  const m = projectDay(log, D);
  expect(m.topLine.leadsTotal).toBe(2);
  expect(m.topLine.leadsBySource).toEqual({ web: 1, canvass: 1 });
});

it("upsert/getDailyMetrics round-trips and is idempotent by date", async () => {
  const m = projectDay(await loadEventsForDay(tenantId, D), D);
  await upsertDailyMetrics(tenantId, m);
  await upsertDailyMetrics(tenantId, m); // second upsert must not duplicate
  const rows = await adminDb.select().from(dailyMetrics).where(eq(dailyMetrics.tenantId, tenantId));
  expect(rows).toHaveLength(1);
  const got = await getDailyMetrics(tenantId, D);
  expect(got?.topLine.leadsTotal).toBe(2);
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @savvy/db test command-center/store` → FAIL (module missing).

- [ ] **Step 3: Implement `read.ts` + `store.ts`**

`packages/db/src/command-center/read.ts`:
```ts
import { and, eq, gte, lt } from "drizzle-orm";
import type { DomainEvent } from "@savvy/orchestrator";
import { denverDayWindow } from "@savvy/command-center";
import { withTenant } from "../tenant";
import { orchestratorEvent } from "../schema/orchestrator";

export async function loadEventsForDay(tenantId: string, businessDate: string): Promise<DomainEvent[]> {
  const { startUtc, endUtc } = denverDayWindow(businessDate);
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.select().from(orchestratorEvent).where(and(
      eq(orchestratorEvent.tenantId, tenantId),
      eq(orchestratorEvent.outcome, "received"),
      gte(orchestratorEvent.createdAt, startUtc),
      lt(orchestratorEvent.createdAt, endUtc),
    ));
    return rows.map((r) => ({
      id: r.eventId, type: r.eventType as DomainEvent["type"], version: r.version,
      occurredAt: r.createdAt.toISOString(), source: r.source as DomainEvent["source"],
      correlationId: r.correlationId, idempotencyKey: r.idempotencyKey,
      ...(r.actor ? { actor: r.actor } : {}), tenantId: r.tenantId, payload: (r.payload ?? {}) as never,
    }));
  });
}
```

> Implementer note: `orchestrator_event` has no `occurred_at` column (Day-1 gap), so the loader uses `created_at` (write time) for the window. For synchronous Day-1 dispatch write time ≈ occurrence time. If the follow-up task adds an `occurred_at` column, switch the window filter to it.

`packages/db/src/command-center/store.ts`:
```ts
import { and, eq } from "drizzle-orm";
import type { DailyMetrics, QueueItem } from "@savvy/command-center";
import { withTenant } from "../tenant";
import { dailyMetrics, exceptionQueue } from "../schema/command-center";
export { loadEventsForDay } from "./read";

export async function upsertDailyMetrics(tenantId: string, m: DailyMetrics): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.insert(dailyMetrics).values({ tenantId, businessDate: m.businessDate, metrics: m as unknown as Record<string, unknown> })
      .onConflictDoUpdate({ target: [dailyMetrics.tenantId, dailyMetrics.businessDate], set: { metrics: m as unknown as Record<string, unknown>, generatedAt: new Date() } });
  });
}

export async function getDailyMetrics(tenantId: string, businessDate: string): Promise<DailyMetrics | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.select().from(dailyMetrics).where(and(eq(dailyMetrics.tenantId, tenantId), eq(dailyMetrics.businessDate, businessDate)));
    return row ? (row.metrics as unknown as DailyMetrics) : null;
  });
}

export async function upsertQueueItem(tenantId: string, it: QueueItem): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.insert(exceptionQueue).values({
      tenantId, escalationKey: it.key, ruleId: it.ruleId, severity: it.severity, reason: it.reason,
      notify: it.notify, assignee: it.assignee, state: it.state,
      acknowledgedAt: it.acknowledgedAt ? new Date(it.acknowledgedAt) : null,
      resolvedAt: it.resolvedAt ? new Date(it.resolvedAt) : null,
      resolutionNote: it.resolutionNote, snoozeUntil: it.snoozeUntil ? new Date(it.snoozeUntil) : null,
    }).onConflictDoUpdate({ target: [exceptionQueue.tenantId, exceptionQueue.escalationKey], set: {
      state: it.state, assignee: it.assignee,
      acknowledgedAt: it.acknowledgedAt ? new Date(it.acknowledgedAt) : null,
      resolvedAt: it.resolvedAt ? new Date(it.resolvedAt) : null,
      resolutionNote: it.resolutionNote, snoozeUntil: it.snoozeUntil ? new Date(it.snoozeUntil) : null,
    } });
  });
}

export async function listQueue(tenantId: string): Promise<QueueItem[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.select().from(exceptionQueue).where(eq(exceptionQueue.tenantId, tenantId));
    return rows.map((r) => ({
      key: r.escalationKey, escalationId: r.escalationKey.split(":")[0] ?? r.escalationKey,
      idempotencyKey: r.escalationKey.split(":").slice(1).join(":"), ruleId: r.ruleId, severity: r.severity,
      reason: r.reason, notify: r.notify, assignee: r.assignee, state: r.state as QueueItem["state"],
      acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null, resolvedAt: r.resolvedAt?.toISOString() ?? null,
      resolutionNote: r.resolutionNote ?? null, snoozeUntil: r.snoozeUntil?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}
```

- [ ] **Step 4: Run GREEN** — `pnpm --filter @savvy/db test command-center/store` → PASS (2 tests). Add exports to `packages/db/src/index.ts`:
```ts
export { loadEventsForDay, upsertDailyMetrics, getDailyMetrics, upsertQueueItem, listQueue } from "./command-center/store";
export { dailyMetrics, exceptionQueue } from "./schema/command-center";
```

- [ ] **Step 5: Commit**
```bash
git add packages/db/src
git commit -m "feat(db): command-center event loader + metrics/queue persistence

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 10: web Flash route + on-demand trigger + mock seams

**Files:**
- Create: `packages/command-center/src/seams.ts` (+ export from index)
- Create: `apps/web/src/app/api/flash/route.ts` (on-demand "flash me now" — generates + returns the headline/url)
- Create: `apps/web/src/app/(public)/flash/[token]/page.tsx` (renders the Flash HTML for a signed token)
- Test: `packages/command-center/src/seams.test.ts`

**Interfaces:**
- Produces:
  - `interface FlashDelivery { send(msg: { headline: string; url: string; to: string }): Promise<void> }`; `class MockFlashDelivery implements FlashDelivery` with a public `sent: {...}[]`.
  - `interface FlashScheduler { schedule(hourDenver: number, run: () => Promise<void>): void; triggerNow(run: () => Promise<void>): Promise<void> }`; `class MockFlashScheduler` (records the configured hour; `triggerNow` just runs).
  - `generateFlash(tenantId, businessDate, deps): Promise<{ headline: string; html: string }>` — the composition root: `loadEventsForDay → projectDay → upsertDailyMetrics → listQueue → render`. Lives in web (API route) using the db + command-center exports; the seams package stays UI-free.

- [ ] **Step 1: Write the failing seams test**
```ts
import { it, expect } from "vitest";
import { MockFlashDelivery, MockFlashScheduler } from "./seams";

it("MockFlashDelivery records what it would send", async () => {
  const d = new MockFlashDelivery();
  await d.send({ headline: "hi", url: "https://x/flash/t", to: "+1555" });
  expect(d.sent).toHaveLength(1);
  expect(d.sent[0]!.headline).toBe("hi");
});

it("MockFlashScheduler stores the hour and triggerNow runs the job once", async () => {
  const s = new MockFlashScheduler();
  let ran = 0;
  s.schedule(18, async () => { ran++; });
  expect(s.hour).toBe(18);
  await s.triggerNow(async () => { ran++; });
  expect(ran).toBe(1);
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @savvy/command-center test seams` → FAIL.

- [ ] **Step 3: Implement `seams.ts`**
```ts
export interface FlashDelivery { send(msg: { headline: string; url: string; to: string }): Promise<void>; }
export class MockFlashDelivery implements FlashDelivery {
  readonly sent: { headline: string; url: string; to: string }[] = [];
  async send(msg: { headline: string; url: string; to: string }): Promise<void> { this.sent.push(msg); }
}
export interface FlashScheduler {
  schedule(hourDenver: number, run: () => Promise<void>): void;
  triggerNow(run: () => Promise<void>): Promise<void>;
}
export class MockFlashScheduler implements FlashScheduler {
  hour: number | null = null;
  schedule(hourDenver: number): void { this.hour = hourDenver; }
  async triggerNow(run: () => Promise<void>): Promise<void> { await run(); }
}
```
Add to `src/index.ts`: `export * from "./seams";`.

- [ ] **Step 4: Run GREEN** — `pnpm --filter @savvy/command-center test seams` → PASS (2). Typecheck clean.

- [ ] **Step 5: Web API route** — `apps/web/src/app/api/flash/route.ts` (follow an existing route's tenant-resolution + auth pattern, e.g. `apps/web/src/app/api/documents/.../route.ts`):
```ts
import { NextResponse } from "next/server";
import { getTenantId } from "@/lib/tenant";
import { loadEventsForDay, upsertDailyMetrics, listQueue } from "@savvy/db";
import { projectDay, businessDateOf, renderFlashHeadline, ExceptionQueue } from "@savvy/command-center";
export const runtime = "nodejs";

export async function POST() {
  const tenantId = await getTenantId();
  const today = businessDateOf(new Date());
  const metrics = projectDay(await loadEventsForDay(tenantId, today), today);
  await upsertDailyMetrics(tenantId, metrics);
  const queue = await listQueue(tenantId);
  const needsYou = queue.filter((i) => i.assignee === "arrington" && i.state === "open");
  return NextResponse.json({ businessDate: today, headline: renderFlashHeadline(metrics, needsYou as never), needsYou: needsYou.length });
}
```

- [ ] **Step 6: Web Flash page** — `apps/web/src/app/(public)/flash/[token]/page.tsx` renders `renderFlashHtml` for the signed token's tenant+date. Use `dangerouslySetInnerHTML` with the renderer's escaped output. Gate on a signed token (reuse the cert/estimate signed-link pattern in `apps/web`). Keep it a server component; no client JS needed.

- [ ] **Step 7: Verify the build** — `pnpm --filter @savvy/web typecheck` clean. (No e2e added in this task; the route is covered by the seam/store unit + integration tests.)

- [ ] **Step 8: Commit**
```bash
git add packages/command-center/src apps/web/src
git commit -m "feat(command-center): flash scheduler/delivery seams + web flash route (on-demand + signed page)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 11: Slice 2 gate — full suite + PR

- [ ] **Step 1: Full gate**
```bash
pnpm typecheck
pnpm lint
pnpm --filter @savvy/command-center test
pnpm --filter @savvy/db test command-center
pnpm --filter @savvy/orchestrator test
```
Expected: all green. (A pre-existing unrelated flake in `packages/db/tests/rederive-job-stages.test.ts` timing out on a bloated local DB is NOT this branch's regression — confirm the failure, if any, is that test and note it; CI on a fresh DB is authoritative.)

- [ ] **Step 2: Push + report** — `git push`; report the PR link + CI status and **stop for Brett's merge word.** Do not deploy — migration 0119 is applied locally only; prod apply happens when publishers are wired into real flows.

---

## Self-Review Notes (author)
- **Spec coverage:** re-model (Task 1) · Denver window §NFR (Task 2) · projection §4 (Task 3) · comparison "vs yesterday/7" (Task 4) · exception-queue lifecycle §5 (Task 5) · Flash HTML+headline §6 (Task 6) · §8 acceptance incl. quiet-day + idempotency + replay (Task 7) · persistence §Slice2 + mig 0119 (Task 8) · read-only event loader + upsert (Task 9) · scheduler/delivery seams + web route §6 (Task 10) · gate (Task 11). `speed-to-lead-breach` timer stays deferred (Day-1 note); SLA "bold flag > X hrs" is surface-only — `openCount`/`needsYou` expose the data, the bold-flag styling is a Day-4 polish, called out not silently dropped.
- **Type consistency:** `DailyMetrics` shape defined once (Task 3) and consumed by comparison/flash/store identically. `QueueItem` defined once (Task 5), persisted/reloaded in Task 9 with matching fields. `businessDateOf`/`denverDayWindow` signatures stable across Tasks 2/3/9.
- **Blast-radius rule enforced:** Task 1 touches only `events.ts`/publishers/tests (never triggers/engine/db-store); Task 9's loader is a new file, not a Day-1 store edit. Sequenced after `task_71fda1bc` merges.
- **noUncheckedIndexedAccess:** median/split/`notify[0]` accesses guarded or `!`-asserted after length checks.
