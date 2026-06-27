# Instant-Assign Shared Service + Human Quick-Book Screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human answering the phone create a lead and book the inspection live on one no-reload screen — recommend a rep (zip territory → round-robin), show two today-first slots, answer "who's free at 4?", and book atomically — all behind one shared service the Vapi path will later reuse.

**Architecture:** Approach A from the spec — one shared "intake-and-schedule" service is the only place assignment + availability + booking logic lives. It is assembled from the already-merged engine primitives (`pickAssignee` w/ zip territory, `rankSlots` w/ `todayCutoff`, `repsFreeAt`, `getRepBlocks`, `bookLeadSlot`, `createLeadForTenant`). Two new tenant-scoped DB readers (`recommendAssignee`, `repsAvailableAt`) carry the integration-testable logic; `slotsForRep` is a repId-keyed refactor of the existing `getRecommendedSlots`; `confirmIntakeBooking` is thin web orchestration. The quick-book screen (`/leads/quick`) is the first consumer.

**Tech Stack:** TypeScript, Next.js (App Router) + server actions, Drizzle ORM (Postgres + RLS), shadcn/ui (Sheet slide-over), Vitest (unit/integration), Playwright (e2e), pnpm + Turborepo.

**Spec:** `docs/superpowers/specs/2026-06-25-instant-assign-live-schedule-design.md` (sequencing items 2 + 3; items 4 settings-UI, 5 AI-wiring, 6 rep-block-UI are explicit follow-ups, out of scope here).

## Global Constraints

- **Build off `origin/main`** (already has engine #47 + rep-alert #49). This worktree is branched from it.
- **Import-extension rule (differs by directory — match the file you edit):** `packages/core/*` → NO extension; `packages/db/src/schema/*` → NO extension; `packages/db/src/lifecycle/*` **source** → NO extension; `packages/db` **test** files → `.js` extension; `apps/web/*` → NO extension. *(A `.js` in a db source file passes `next build` but breaks the Turbopack e2e webServer — a real CI failure on this repo.)*
- **Single instances:** import drizzle operators (`eq`, `and`, `inArray`…) from `@savvy/db` and `z` from `@savvy/core`, never from `drizzle-orm`/`zod` directly. Within `packages/core` import `z` from `"./schemas"`.
- **Tenant isolation:** every new DB read/write goes through `withTenant(tenantId, …)` (RLS) or, for cross-table reads keyed by an already-resolved tenantId, `adminDb` filtered by `tenantId` (mirror the existing `getRecommendedSlots` pattern). Every new `packages/db` integration test asserts a cross-tenant read returns nothing.
- **Nothing persists until Confirm:** `recommendAssignee`, `slotsForRep`, `repsAvailableAt` are READ/preview only — zero writes. All persistence is in `confirmIntakeBooking`.
- **Quick-book leads use `source: "inbound-call"`** — a human answering an inbound call. This is deliberate: `runRepAlert` (rep-alert speed-to-lead, shipped in #49) skips `source === "inbound-call"`, so booking live does NOT fire a spurious "call now — speed to lead" text to the very rep who is on the phone.
- **DB tests prerequisite:** `pnpm db:up && pnpm --filter @savvy/db db:migrate` before running any `packages/db` test. (Local docker `savvy_db` is shared across worktrees; if `db:migrate` errors on an already-applied non-idempotent statement, the needed tables already exist — proceed to tests.)

---

## File Structure

| File | Responsibility | New/Modified |
|---|---|---|
| `packages/db/src/lifecycle/assignment.ts` | add `recommendAssignee(tenantId, geo)` reader (settings + candidates + `pickAssignee`) | Modify |
| `packages/db/src/lifecycle/assignment.test.ts` | integration tests: zip-territory pick + round-robin tiebreak + RLS isolation | Create (or modify if present) |
| `packages/core/src/lead-assignment.ts` | flip `parseAssignmentConfig` default `strategy` `off`→`territory` | Modify |
| `packages/core/src/lead-assignment.test.ts` | assert new default | Modify |
| `packages/db/src/lifecycle/availability.ts` | add `repsAvailableAt(tenantId, {startsAt,type})` reader (appts+blocks − `repsFreeAt`) | Modify |
| `packages/db/src/lifecycle/availability.test.ts` | integration tests: free/busy by appt + by block + RLS isolation | Modify |
| `packages/db/src/lifecycle/team.ts` | add `listAssignableReps(tx, tenantId)` → `{id,name}[]` (sales roles, active) | Create |
| `packages/db/src/index.ts` | export `recommendAssignee`, `repsAvailableAt`, `listAssignableReps` | Modify |
| `apps/web/src/lib/recommended-slots.ts` | extract repId-keyed `slotsForRep(...)`; `getRecommendedSlots(leadId)` delegates | Modify |
| `apps/web/src/lib/intake-schedule.ts` | the shared service's web entry: `previewAssignee`, `previewSlots`, `whoIsFree`, `confirmIntakeBooking` server actions | Create |
| `apps/web/src/app/(app)/leads/quick/QuickBook.tsx` | the slide-over quick-book client UI | Create |
| `apps/web/src/app/(app)/leads/quick/page.tsx` | server page hosting QuickBook (reps list) | Create |
| `apps/web/src/app/(app)/leads/NewCallButton.tsx` | "📞 New Call" entry that opens `/leads/quick` | Create |
| `apps/web/src/app/(app)/leads/page.tsx` | mount the New Call entry | Modify |
| `apps/web/tests/e2e/quick-book.spec.ts` | e2e: type → rep appears → slots → book; rep override; who's-free | Create |

---

### Task 1: `recommendAssignee` DB reader + default strategy → territory

**Files:**
- Modify: `packages/core/src/lead-assignment.ts` + `packages/core/src/lead-assignment.test.ts`
- Modify: `packages/db/src/lifecycle/assignment.ts`
- Create/Modify: `packages/db/src/lifecycle/assignment.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Consumes: `getAssignmentSettings(tenantId)`, `getAssignmentCandidates(tx, tenantId)` → `DbAssignmentCandidate[]`, `parseAssignmentConfig` + `pickAssignee` (`@savvy/core`), `withTenant`.
- Produces:
  - `parseAssignmentConfig(undefined).strategy === "territory"` (was `"off"`).
  - `recommendAssignee(tenantId: string, geo: { zip?: string | null; city?: string | null; state?: string | null }): Promise<string | null>` — RLS-scoped preview, NO write. Maps `DbAssignmentCandidate` → `AssignmentCandidate` and runs `pickAssignee`.

- [ ] **Step 1: Flip the default — write the failing core test**

In `packages/core/src/lead-assignment.test.ts`, add (match the file's `describe`/`it` or `test` style):

```typescript
import { parseAssignmentConfig } from "./lead-assignment";

test("defaults to territory strategy (zip→round-robin live booking)", () => {
  expect(parseAssignmentConfig(undefined).strategy).toBe("territory");
  expect(parseAssignmentConfig({ bogus: true }).strategy).toBe("territory");
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Received: "off"`)

Run: `pnpm --filter @savvy/core test src/lead-assignment.test.ts`

- [ ] **Step 3: Change the default**

In `packages/core/src/lead-assignment.ts`, change the fallback in `parseAssignmentConfig`:

```typescript
  return parsed.success ? parsed.data : { strategy: "territory" };
```

Also check the zod schema's own `.default(...)` for `strategy` (if `assignmentConfigSchema` defaults `strategy` to `"off"`, change that default to `"territory"` too, so a partial config with no strategy also lands on territory). Leave all other fields untouched.

- [ ] **Step 4: Run core test — expect PASS.** Run: `pnpm --filter @savvy/core test src/lead-assignment.test.ts`

- [ ] **Step 5: Write the failing DB integration test**

In `packages/db/src/lifecycle/assignment.test.ts` (create if absent — mirror an existing `packages/db` lifecycle test for tenant/user seeding helpers + `.js` import extensions), add:

```typescript
import { describe, it, expect } from "vitest";
import { withTenant } from "../tenant.js";
import { adminDb, tenant, user } from "../index.js";
import { recommendAssignee } from "./assignment.js";

async function mkTenant(name: string) {
  const [t] = await adminDb.insert(tenant).values({ name, publicKey: `k-${name}-${Date.now()}`, clerkOrgId: `org-${name}-${Date.now()}` }).returning();
  return t!.id;
}
async function mkRep(tenantId: string, name: string) {
  return withTenant(tenantId, async (tx) => {
    const [u] = await tx.insert(user).values({ tenantId, name, email: "", role: "rep", clerkUserId: null }).returning({ id: user.id });
    return u!.id;
  });
}

describe("recommendAssignee", () => {
  it("returns the rep whose zip-territory rule matches", async () => {
    const tid = await mkTenant("rec-zip");
    const a = await mkRep(tid, "Ann");
    const b = await mkRep(tid, "Bob");
    await adminDb.update(tenant).set({ settings: { assignment: { strategy: "territory", territoryRules: [{ zip: "85203", userId: b }] } } }).where(eq(tenant.id, tid));
    const picked = await recommendAssignee(tid, { zip: "85203", city: "Mesa", state: "AZ" });
    expect(picked).toBe(b);
    expect([a, b]).toContain(picked);
  });

  it("falls back to round-robin when no rule matches", async () => {
    const tid = await mkTenant("rec-rr");
    const a = await mkRep(tid, "Ann");
    await adminDb.update(tenant).set({ settings: { assignment: { strategy: "territory", territoryRules: [] } } }).where(eq(tenant.id, tid));
    const picked = await recommendAssignee(tid, { zip: "99999", city: null, state: null });
    expect(picked).toBe(a); // only rep → round-robin returns them
  });

  it("never picks another tenant's rep (RLS)", async () => {
    const t1 = await mkTenant("rec-iso1");
    const t2 = await mkTenant("rec-iso2");
    const foreign = await mkRep(t2, "Foreign");
    await adminDb.update(tenant).set({ settings: { assignment: { strategy: "territory", territoryRules: [{ zip: "85203", userId: foreign }] } } }).where(eq(tenant.id, t1));
    const picked = await recommendAssignee(t1, { zip: "85203", city: "Mesa", state: "AZ" });
    expect(picked).not.toBe(foreign); // t1 has no reps → null
    expect(picked).toBeNull();
  });
});
```

Add `eq` to the import from `../index.js` if not already there.

- [ ] **Step 6: Run it — expect FAIL** (`recommendAssignee` not exported).

Run: `pnpm db:up && pnpm --filter @savvy/db db:migrate && pnpm --filter @savvy/db test src/lifecycle/assignment.test.ts`

- [ ] **Step 7: Implement `recommendAssignee`**

In `packages/db/src/lifecycle/assignment.ts` add (note NO `.js` in db **source** files; import core via the package root):

```typescript
import { parseAssignmentConfig, pickAssignee, type AssignmentCandidate } from "@savvy/core";

/** Preview the recommended rep for a lead's geo, per the tenant's strategy
 *  (default territory: zip → round-robin). RLS-scoped read, no write. */
export async function recommendAssignee(
  tenantId: string,
  geo: { zip?: string | null; city?: string | null; state?: string | null },
): Promise<string | null> {
  const config = parseAssignmentConfig(await getAssignmentSettings(tenantId));
  const candidates = await withTenant(tenantId, (tx) => getAssignmentCandidates(tx, tenantId));
  const pool: AssignmentCandidate[] = candidates.map((c) => ({
    userId: c.userId,
    openLeadCount: c.openLeadCount,
    lastAssignedAt: c.lastAssignedAt,
    skills: c.skills,
  }));
  return pickAssignee({
    strategy: config.strategy,
    config,
    candidates: pool,
    lead: { state: geo.state ?? null, city: geo.city ?? null, zip: geo.zip ?? null, score: null, lane: null },
  });
}
```

Confirm `withTenant` + `getAssignmentSettings` + `getAssignmentCandidates` are in-scope (same file / already imported). Add `withTenant` import from `../tenant` (no extension) if needed.

- [ ] **Step 8: Export it.** In `packages/db/src/index.ts`, add `recommendAssignee` to the existing `export { … } from "./lifecycle/assignment.js"` line. *(index re-exports use `.js` — match the existing lines in that file.)*

- [ ] **Step 9: Run DB test — expect PASS.** Run: `pnpm --filter @savvy/db test src/lifecycle/assignment.test.ts`

- [ ] **Step 10: Typecheck + commit**

```bash
pnpm --filter @savvy/core typecheck && pnpm --filter @savvy/db typecheck
git add packages/core/src/lead-assignment.ts packages/core/src/lead-assignment.test.ts packages/db/src/lifecycle/assignment.ts packages/db/src/lifecycle/assignment.test.ts packages/db/src/index.ts
git commit -m "feat(db): recommendAssignee preview reader + default strategy territory"
```

---

### Task 2: `repsAvailableAt` DB reader

**Files:**
- Modify: `packages/db/src/lifecycle/availability.ts` + `packages/db/src/lifecycle/availability.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Consumes: `getRepBlocks(tx, {tenantId,userId,from,to})`, `getAssignmentCandidates`, `repsFreeAt` (`@savvy/core`), `parseSchedulingConfig` (`@savvy/core`) + `getAssignmentSettings`/tenant settings for the type duration, `appointment`/`job` tables, `withTenant`.
- Produces: `repsAvailableAt(tenantId: string, args: { startsAt: Date; type?: "inspection" | "cm" | "crew" }): Promise<string[]>` — userIds of reps with NO scheduled appt and NO block overlapping `[startsAt, startsAt + duration + buffer)`. RLS-scoped read.

- [ ] **Step 1: Write the failing integration test**

In `packages/db/src/lifecycle/availability.test.ts`, add (reuse the file's existing seed helpers if present; otherwise add tenant/user/job/appointment/block inserts mirroring the `getRepBlocks` test already in this file):

```typescript
import { repsAvailableAt } from "./availability.js";

describe("repsAvailableAt", () => {
  // Pick a window far in the future, inside default business hours, to avoid horizon/now edges.
  const at = new Date("2026-09-14T17:00:00Z"); // Mon 10:00 America/Phoenix

  it("excludes a rep with an overlapping scheduled appointment, keeps a free rep", async () => {
    const tid = await mkTenant("free-appt");
    const busyRep = await mkRep(tid, "Busy");
    const freeRep = await mkRep(tid, "Free");
    // a scheduled appt for busyRep covering `at` (needs a job for the FK)
    await seedScheduledAppt(tid, busyRep, "2026-09-14T16:30:00Z", "2026-09-14T17:30:00Z");
    const free = await repsAvailableAt(tid, { startsAt: at, type: "inspection" });
    expect(free).toContain(freeRep);
    expect(free).not.toContain(busyRep);
  });

  it("excludes a rep who blocked that time", async () => {
    const tid = await mkTenant("free-block");
    const rep = await mkRep(tid, "Blocker");
    await withTenant(tid, (tx) => tx.insert(repAvailabilityBlock).values({
      tenantId: tid, userId: rep, startsAt: new Date("2026-09-14T16:00:00Z"), endsAt: new Date("2026-09-14T18:00:00Z"),
    }));
    const free = await repsAvailableAt(tid, { startsAt: at, type: "inspection" });
    expect(free).not.toContain(rep);
  });

  it("does not see another tenant's reps (RLS)", async () => {
    const t1 = await mkTenant("free-iso1");
    const t2 = await mkTenant("free-iso2");
    const foreign = await mkRep(t2, "Foreign");
    const free = await repsAvailableAt(t1, { startsAt: at, type: "inspection" });
    expect(free).not.toContain(foreign);
  });
});
```

Provide `seedScheduledAppt(tenantId, userId, startIso, endIso)` (insert a minimal `job` then a `scheduled` `appointment` with `assigneeUserId`) and import `repAvailabilityBlock` from `../index.js`. Reuse `mkTenant`/`mkRep` from Task 1's test (duplicate the small helpers here — db test files are independent).

- [ ] **Step 2: Run it — expect FAIL** (`repsAvailableAt` not exported).

Run: `pnpm --filter @savvy/db test src/lifecycle/availability.test.ts`

- [ ] **Step 3: Implement `repsAvailableAt`**

In `packages/db/src/lifecycle/availability.ts` add (db source = NO `.js`; core via package root):

```typescript
import { repsFreeAt, parseSchedulingConfig, type RepBusy } from "@savvy/core";
import { getAssignmentCandidates, getAssignmentSettings } from "./assignment";
import { appointment, job } from "../schema";
import { and, eq } from "drizzle-orm";

/** Reps with no scheduled appointment and no block overlapping the requested window.
 *  Window = [startsAt, startsAt + duration + buffer) for the appointment type. RLS-scoped. */
export async function repsAvailableAt(
  tenantId: string,
  args: { startsAt: Date; type?: "inspection" | "cm" | "crew" },
): Promise<string[]> {
  const type = args.type ?? "inspection";
  const settings = (await getAssignmentSettings(tenantId)) as never;
  const cfg = parseSchedulingConfig((settings as { scheduling?: unknown } | null)?.scheduling ?? undefined);
  const t = cfg.types[type];
  const startsAt = args.startsAt;
  const endsAt = new Date(startsAt.getTime() + (t.durationMin + t.bufferMin) * 60_000);

  return withTenant(tenantId, async (tx) => {
    const candidates = await getAssignmentCandidates(tx, tenantId);
    const reps: RepBusy[] = await Promise.all(
      candidates.map(async (c) => {
        const appts = await tx
          .select({ startsAt: appointment.startsAt, endsAt: appointment.endsAt })
          .from(appointment)
          .where(and(eq(appointment.assigneeUserId, c.userId), eq(appointment.status, "scheduled")));
        const blocks = await getRepBlocks(tx, { tenantId, userId: c.userId, from: startsAt, to: endsAt });
        return { userId: c.userId, busy: [...appts, ...blocks] };
      }),
    );
    return repsFreeAt({ requested: { startsAt, endsAt }, reps });
  });
}
```

Notes: import `eq`/`and` from `drizzle-orm` is fine **inside `packages/db`** (it owns the single instance and re-exports it). Confirm `getSchedulingConfig` shape: `cfg.types[type]` has `durationMin`+`bufferMin` (it does — `parseSchedulingConfig`). `getRepBlocks` already filters to overlap; appts are filtered in JS by `repsFreeAt` (edge-touch not an overlap).

- [ ] **Step 4: Export it.** In `packages/db/src/index.ts` add `repsAvailableAt` to the `export { … } from "./lifecycle/availability.js"` line (alongside `getRepBlocks`).

- [ ] **Step 5: Run DB test — expect PASS.** Run: `pnpm --filter @savvy/db test src/lifecycle/availability.test.ts`

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm --filter @savvy/db typecheck
git add packages/db/src/lifecycle/availability.ts packages/db/src/lifecycle/availability.test.ts packages/db/src/index.ts
git commit -m "feat(db): repsAvailableAt — who's free at an exact time (appts+blocks)"
```

---

### Task 3: `slotsForRep` — repId-keyed, today-first slots

**Files:**
- Modify: `apps/web/src/lib/recommended-slots.ts`

**Interfaces:**
- Consumes: `parseSchedulingConfig`, `parseFinanceConfig`, `computeOpenSlots`, `rankSlots`, `resolveRepOrigin`, `spokenSlotLabel`, `toCivilDate`, `zonedTimeToUtc`, `type LatLng` (`@savvy/core`); `distance` (`@savvy/integrations`); `adminDb`, tables (`@savvy/db`).
- Produces:
  - `slotsForRep(args: { tenantId: string; repId: string; type?: "inspection" | "cm" | "crew"; limit?: number; todayFirst?: boolean; clusterAround?: LatLng | null }): Promise<{ slots: RecommendedSlot[] }>` — today-first when `todayFirst` (default true). No `error` branch (caller guarantees repId).
  - `getRecommendedSlots(leadId, opts?)` keeps its existing signature/return, now delegating to `slotsForRep`.
  - `RecommendedSlot = { startsAt: string; endsAt: string; driveMinutes: number | null; label: string }` (unchanged).

- [ ] **Step 1: Refactor `recommended-slots.ts` — extract `slotsForRep`**

Replace the body of the file with the version below. It lifts everything from "load tenant settings" onward into `slotsForRep(tenantId, repId, clusterAround, …)`, adds the `todayFirst` cutoff, and reduces `getRecommendedSlots` to a lead→repId resolver that delegates. (No behavior change for existing callers except the today-first bias, which is intended.)

```typescript
"use server";
import { adminDb, lead, user, property, appointment, job, tenant, eq, and } from "@savvy/db";
import { parseSchedulingConfig, parseFinanceConfig, computeOpenSlots, rankSlots, resolveRepOrigin, spokenSlotLabel, toCivilDate, zonedTimeToUtc, type LatLng } from "@savvy/core";
import { distance } from "@savvy/integrations";

type RecommendedSlot = { startsAt: string; endsAt: string; driveMinutes: number | null; label: string };

/** A rep's next open inspection times, drive-time aware, today/soonest first.
 *  Preview only — no writes. `clusterAround` (the prospect's property) sharpens
 *  drive-time + clustering when known. */
export async function slotsForRep(args: {
  tenantId: string;
  repId: string;
  type?: "inspection" | "cm" | "crew";
  limit?: number;
  todayFirst?: boolean;
  clusterAround?: LatLng | null;
}): Promise<{ slots: RecommendedSlot[] }> {
  const { tenantId, repId } = args;
  const type = args.type ?? "inspection";
  const limit = args.limit ?? 2;
  const todayFirst = args.todayFirst ?? true;
  const destPoint = args.clusterAround ?? null;

  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const cfg = parseSchedulingConfig((t?.settings as { scheduling?: unknown } | null)?.scheduling);
  const tz = parseFinanceConfig((t?.settings as { finance?: unknown } | null)?.finance).timezone;

  const horizonEnd = new Date(Date.now() + cfg.bookingHorizonDays * 86_400_000);
  const apptRows = await adminDb
    .select({ startsAt: appointment.startsAt, endsAt: appointment.endsAt, lat: property.lat, lng: property.lng })
    .from(appointment)
    .leftJoin(job, eq(appointment.jobId, job.id))
    .leftJoin(property, eq(job.propertyId, property.id))
    .where(and(eq(appointment.tenantId, tenantId), eq(appointment.assigneeUserId, repId), eq(appointment.status, "scheduled")));
  const busy = apptRows
    .filter((r) => r.startsAt >= new Date() && r.startsAt < horizonEnd)
    .map((r) => ({ startsAt: r.startsAt, endsAt: r.endsAt, lat: r.lat == null ? undefined : Number(r.lat), lng: r.lng == null ? undefined : Number(r.lng) }));

  const slots = computeOpenSlots({
    config: cfg, type, existingAppts: busy, fromDate: new Date(), now: new Date(), tz,
    clusterAround: destPoint ?? undefined,
  })
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .slice(0, 12);

  const [u] = await adminDb.select({ baseLat: user.baseLat, baseLng: user.baseLng }).from(user).where(and(eq(user.id, repId), eq(user.tenantId, tenantId)));
  const repBase: LatLng | null = u?.baseLat != null && u?.baseLng != null ? { lat: Number(u.baseLat), lng: Number(u.baseLng) } : null;
  const officeRaw = (t?.settings as { scheduling?: { office?: { lat?: number; lng?: number } } } | null)?.scheduling?.office;
  const tenantOffice: LatLng | null = officeRaw && typeof officeRaw.lat === "number" && typeof officeRaw.lng === "number" ? { lat: officeRaw.lat, lng: officeRaw.lng } : null;

  const sameDay = (day: Date) => busy.filter(
    (b) => b.lat != null && b.lng != null && b.startsAt.toISOString().slice(0, 10) === day.toISOString().slice(0, 10),
  ).map((b) => ({ startsAt: b.startsAt, endsAt: b.endsAt, lat: b.lat as number, lng: b.lng as number }));

  const origins = slots.map((s) => resolveRepOrigin({ sameDayAppts: sameDay(s.startsAt), reference: s.startsAt, repBase, tenantOffice }));
  const idxWithOrigin = origins.map((o, i) => ({ o, i })).filter((x): x is { o: LatLng; i: number } => x.o != null);
  const matrix = destPoint && idxWithOrigin.length ? await distance.driveMinutesMatrix(idxWithOrigin.map((x) => x.o), [destPoint]) : null;
  const driveBySlot: (number | null)[] = slots.map(() => null);
  idxWithOrigin.forEach((x, k) => { driveBySlot[x.i] = matrix ? (matrix[k]?.[0] ?? null) : null; });

  // today-first: bonus any slot starting on/before tenant-local end-of-today.
  const nowIso = new Date().toISOString();
  const todayCutoff = todayFirst ? new Date(zonedTimeToUtc(toCivilDate(nowIso, tz), 23 * 60 + 59, tz)) : undefined;

  const ranked = rankSlots({ slots, driveMinutesBySlotIndex: driveBySlot, weights: cfg.driveTime, todayCutoff }).slice(0, limit);
  return {
    slots: ranked.map((s) => ({
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      driveMinutes: s.driveMinutes,
      label: spokenSlotLabel(s.startsAt.toISOString(), tz, nowIso),
    })),
  };
}

/** Lead-keyed wrapper (existing callers): resolve the lead's tenant + assignee +
 *  property cluster point, then delegate to slotsForRep. Default limit stays 3. */
export async function getRecommendedSlots(
  leadId: string,
  opts?: { type?: "inspection" | "cm" | "crew"; limit?: number },
): Promise<{ error: "no_lead" | "no_assignee" } | { slots: RecommendedSlot[] }> {
  const [l] = await adminDb
    .select({ tenantId: lead.tenantId, assignedUserId: lead.assignedUserId, propertyId: lead.propertyId })
    .from(lead)
    .where(eq(lead.id, leadId));
  if (!l) return { error: "no_lead" };
  if (!l.assignedUserId) return { error: "no_assignee" };

  const dest = l.propertyId
    ? (await adminDb.select({ lat: property.lat, lng: property.lng }).from(property).where(eq(property.id, l.propertyId)))[0]
    : undefined;
  const clusterAround: LatLng | null = dest && dest.lat != null && dest.lng != null ? { lat: Number(dest.lat), lng: Number(dest.lng) } : null;

  return slotsForRep({ tenantId: l.tenantId, repId: l.assignedUserId, type: opts?.type, limit: opts?.limit ?? 3, todayFirst: true, clusterAround });
}
```

- [ ] **Step 2: Typecheck the web package**

Run: `pnpm --filter @savvy/web typecheck`
Expected: clean. (The pure today-first ranking is already unit-tested in `packages/core/src/scheduling.test.ts`; `slotsForRep`'s wiring is covered by the Task 5 e2e. Existing `getRecommendedSlots` callers keep their contract.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/recommended-slots.ts
git commit -m "refactor(web): extract slotsForRep (repId + today-first) from getRecommendedSlots"
```

---

### Task 4: Shared service web entry — `intake-schedule.ts` + `listAssignableReps`

**Files:**
- Create: `packages/db/src/lifecycle/team.ts` + export in `packages/db/src/index.ts`
- Create: `apps/web/src/lib/intake-schedule.ts`

**Interfaces:**
- Consumes: `recommendAssignee`, `repsAvailableAt`, `createLeadForTenant` (`@/lib/intake`), `setLeadOwner`, `bookLeadSlot`, `markLeadContacted`, `withTenant`, `inngest` (`@savvy/agents`), `slotsForRep` (Task 3), `normalizePhone` (`@savvy/core`), `leadIntakeSchema`/`z`.
- Produces (all server actions; `tenantId` resolved internally via `getTenantId()`):
  - `previewAssignee(geo: { zip?: string; city?: string; state?: string }): Promise<{ repId: string | null }>`
  - `previewSlots(input: { repId: string; clusterAround?: { lat: number; lng: number } | null }): Promise<{ slots: { startsAt: string; endsAt: string; label: string }[] }>`
  - `whoIsFree(input: { startsAt: string }): Promise<{ reps: { id: string; name: string }[] }>`
  - `listReps(): Promise<{ id: string; name: string }[]>`
  - `confirmIntakeBooking(input: ConfirmInput): Promise<{ ok: true; leadId: string; appointmentId: string; jobId: string } | { error: "slot_taken" | "no_assignee" | "invalid" }>` where
    `ConfirmInput = { contact: { name: string; phone?: string; email?: string }; address: { address: string; city?: string; state?: string; zip?: string; county?: string; line1?: string; lat?: number; lng?: number }; repId: string; startsAt: string; endsAt: string }`.

- [ ] **Step 1: Add `listAssignableReps` DB reader**

Create `packages/db/src/lifecycle/team.ts` (db source = NO `.js`):

```typescript
import { withTenant } from "../tenant";
import { user } from "../schema";
import { and, inArray, isNull, asc } from "drizzle-orm";

/** Active sales reps eligible for assignment/booking, id+name, alpha by name. */
export async function listAssignableReps(tenantId: string): Promise<{ id: string; name: string }[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({ id: user.id, name: user.name })
      .from(user)
      .where(and(inArray(user.role, ["owner", "admin", "rep"]), isNull(user.deactivatedAt)))
      .orderBy(asc(user.name)),
  );
}
```

Export from `packages/db/src/index.ts`: `export { listAssignableReps } from "./lifecycle/team.js";`

- [ ] **Step 2: Create the service module**

Create `apps/web/src/lib/intake-schedule.ts` (apps/web = NO extension):

```typescript
"use server";
import { recommendAssignee, repsAvailableAt, listAssignableReps, setLeadOwner, bookLeadSlot, markLeadContacted, withTenant } from "@savvy/db";
import { leadIntakeObject, z } from "@savvy/core";
import { inngest } from "@savvy/agents";
import { getTenantId } from "./tenant";
import { createLeadForTenant } from "./intake";
import { slotsForRep } from "./recommended-slots";

export async function listReps(): Promise<{ id: string; name: string }[]> {
  return listAssignableReps(await getTenantId());
}

export async function previewAssignee(geo: { zip?: string; city?: string; state?: string }): Promise<{ repId: string | null }> {
  const repId = await recommendAssignee(await getTenantId(), geo);
  return { repId };
}

export async function previewSlots(input: { repId: string; clusterAround?: { lat: number; lng: number } | null }): Promise<{ slots: { startsAt: string; endsAt: string; label: string }[] }> {
  const { slots } = await slotsForRep({ tenantId: await getTenantId(), repId: input.repId, todayFirst: true, limit: 2, clusterAround: input.clusterAround ?? null });
  return { slots: slots.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt, label: s.label })) };
}

export async function whoIsFree(input: { startsAt: string }): Promise<{ reps: { id: string; name: string }[] }> {
  const tenantId = await getTenantId();
  const freeIds = await repsAvailableAt(tenantId, { startsAt: new Date(input.startsAt), type: "inspection" });
  const all = await listAssignableReps(tenantId);
  const set = new Set(freeIds);
  return { reps: all.filter((r) => set.has(r.id)) };
}

const confirmSchema = z.object({
  contact: z.object({ name: z.string().min(1), phone: z.string().optional(), email: z.string().optional() }),
  address: z.object({
    address: z.string().min(3), city: z.string().optional(), state: z.string().optional(), zip: z.string().optional(),
    county: z.string().optional(), line1: z.string().optional(), lat: z.number().optional(), lng: z.number().optional(),
  }),
  repId: z.string().min(1),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
});

export async function confirmIntakeBooking(input: unknown): Promise<{ ok: true; leadId: string; appointmentId: string; jobId: string } | { error: "slot_taken" | "no_assignee" | "invalid" }> {
  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const { contact, address, repId, startsAt, endsAt } = parsed.data;
  const tenantId = await getTenantId();

  // 1. Create/dedupe customer+property+lead (source inbound-call → rep-alert skips). Emits lead/created.
  const intake = leadIntakeObject.safeParse({
    name: contact.name, phone: contact.phone || undefined, email: contact.email || undefined,
    address: address.address, source: "inbound-call",
    city: address.city, state: address.state, zip: address.zip, county: address.county, line1: address.line1,
    lat: address.lat, lng: address.lng,
  });
  if (!intake.success) return { error: "invalid" };
  const leadId = await createLeadForTenant(tenantId, intake.data);

  // 2. Assign the chosen rep + mark contacted (the human IS the first touch → cancels speed-to-lead).
  await withTenant(tenantId, async (tx) => {
    await setLeadOwner(tx, { tenantId, leadId, userId: repId });
    await markLeadContacted(tx, { tenantId, leadId });
  });
  await inngest.send({ name: "lead/contacted", data: { tenantId, leadId } });

  // 3. Book the slot atomically (exclusion constraint guards double-booking).
  const booked = await bookLeadSlot({ leadId, startsAt, endsAt });
  if ("error" in booked) return booked.error === "slot_taken" ? { error: "slot_taken" } : { error: "no_assignee" };
  await inngest.send({ name: "appointment/booked", data: { tenantId, appointmentId: booked.appointmentId, jobId: booked.jobId, leadId } });
  return { ok: true, leadId, appointmentId: booked.appointmentId, jobId: booked.jobId };
}
```

Notes:
- `leadIntakeObject` is the non-refined object (so `.safeParse` with our explicit shape works); it still applies phone/email normalization. If only `leadIntakeSchema` (refined) is exported, import that instead — the refine (`phone || email`) is desired here too.
- On `slot_taken` the lead is intentionally persisted (a real prospect); the screen re-offers slots and re-calls `confirmIntakeBooking`, which **dedupes** the customer/property/lead (same phone/email) so no duplicate is created — effectively idempotent.
- `markLeadContacted` + `lead/contacted` cancels the rep-alert/speed-to-lead escalation for this lead.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @savvy/db typecheck && pnpm --filter @savvy/web typecheck`
Expected: clean. If `createLeadForTenant`'s input type rejects `source: "inbound-call"`, confirm `leadIntakeObject`/schema's `source` is a free `z.string()` (it is, per the interface map) — no enum.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/lifecycle/team.ts packages/db/src/index.ts apps/web/src/lib/intake-schedule.ts
git commit -m "feat(web): intake-and-schedule shared service (preview + confirmIntakeBooking)"
```

---

### Task 5: Human quick-book screen `/leads/quick`

**Files:**
- Create: `apps/web/src/app/(app)/leads/quick/page.tsx`
- Create: `apps/web/src/app/(app)/leads/quick/QuickBook.tsx`
- Create: `apps/web/src/app/(app)/leads/NewCallButton.tsx`
- Modify: `apps/web/src/app/(app)/leads/page.tsx` (mount the entry)
- Create: `apps/web/tests/e2e/quick-book.spec.ts`

**Interfaces:**
- Consumes: `previewAssignee`, `previewSlots`, `whoIsFree`, `listReps`, `confirmIntakeBooking` (Task 4); `AddressAutocomplete` + `ParsedAddress` (`@/components/AddressAutocomplete`); `normalizePhone`/`formatPhoneDisplay` (`@savvy/core`); shadcn `Card`/`Input`/`Button`/`Sheet` (check `@/components/ui` for an existing `sheet`; if absent, use a simple full route page instead of a slide-over — do NOT add a new dependency).
- Produces: a working screen at `/leads/quick` and a `data-testid="new-call"` entry on `/leads`.

- [ ] **Step 1: Server page — load reps**

Create `apps/web/src/app/(app)/leads/quick/page.tsx`:

```tsx
import { PageHeader } from "@/components/cockpit/PageHeader";
import { listReps } from "@/lib/intake-schedule";
import { QuickBook } from "./QuickBook";

export const dynamic = "force-dynamic";

export default async function QuickBookPage() {
  const reps = await listReps();
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Leads" title="New call — book it now" />
      <QuickBook reps={reps} />
    </div>
  );
}
```

- [ ] **Step 2: Client screen**

Create `apps/web/src/app/(app)/leads/quick/QuickBook.tsx`. Behavior: type name/phone → autocomplete address (`onPick` captures structured city/zip/lat/lng) → on pick, call `previewAssignee({zip,city,state})` → set recommended rep → `previewSlots({repId, clusterAround})` → render 2 slot buttons. Rep dropdown (override) re-runs `previewSlots`. A "Who's free at…" datetime-local + button calls `whoIsFree` and lists free reps (tap sets rep). "Confirm & Book" calls `confirmIntakeBooking`; on `slot_taken` toast + re-run `previewSlots`; on `ok` toast + route to `/leads/<leadId>` (or `/jobs/<jobId>`). Use `useTransition`, `toast` from `sonner`, and `router.push`. Mirror `NewLeadForm.tsx` for the autocomplete + phone-normalize wiring. Give the key controls `data-testid`s: `qb-name`, `qb-phone`, `qb-rep`, `qb-slot` (on each slot button), `qb-confirm`, `qb-whosfree-time`, `qb-whosfree-run`, `qb-free-rep`.

(Full component body — write it to match the codebase's existing client-form idioms in `NewLeadForm.tsx`; keep it one focused file. No new deps.)

- [ ] **Step 3: Entry button + mount**

Create `apps/web/src/app/(app)/leads/NewCallButton.tsx`:

```tsx
"use client";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export function NewCallButton() {
  return <Button asChild data-testid="new-call"><Link href="/leads/quick">📞 New Call</Link></Button>;
}
```

In `apps/web/src/app/(app)/leads/page.tsx`, render `<NewCallButton />` in the header area (next to any existing "New Lead" link). Import it at the top.

- [ ] **Step 4: e2e**

Create `apps/web/tests/e2e/quick-book.spec.ts`. In TEST_MODE (no Clerk), seed a tenant + at least two reps + a territory rule via `@savvy/db` (mirror `team.spec.ts`'s tenant-file read + direct inserts), then:

```typescript
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, user, adminDb, tenant, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("quick-book: type → rep recommended → slot → book", async ({ page }) => {
  // seed two reps + a zip territory rule pointing at rep B
  const reps = await withTenant(tenantId, async (tx) => {
    const a = (await tx.insert(user).values({ tenantId, name: "QB Ann", email: "", role: "rep", clerkUserId: null }).returning({ id: user.id }))[0]!.id;
    const b = (await tx.insert(user).values({ tenantId, name: "QB Bob", email: "", role: "rep", clerkUserId: null }).returning({ id: user.id }))[0]!.id;
    return { a, b };
  });
  await adminDb.update(tenant).set({ settings: { assignment: { strategy: "territory", territoryRules: [{ zip: "85203", userId: reps.b }] } } }).where(eq(tenant.id, tenantId));

  await page.goto("/leads/quick");
  await expect(page.getByRole("heading", { name: /book it now/i })).toBeVisible();
  await page.getByTestId("qb-name").fill("Dale Homeowner");
  await page.getByTestId("qb-phone").fill("(480) 555-0142");
  // The address autocomplete needs Places; in TEST_MODE it degrades to a plain input.
  // Drive the zip directly via the manual city/zip fallback fields the form exposes when no Places key.
  // → assert a rep recommendation appears and at least one slot button renders, then book.
  // (Exact selectors per the QuickBook component; this is the e2e contract.)
});
```

Keep the e2e focused on the contract: rep recommendation surfaces, a slot is offered, Confirm books (assert a `job`/`appointment` row appears for the tenant, like `team.spec.ts` asserts DB state). Because Google Places is unavailable in TEST_MODE, the QuickBook component MUST expose manual city/state/zip inputs as a fallback (also good UX) — wire `previewAssignee` off those when present. Add `data-testid="qb-zip"` etc. accordingly.

- [ ] **Step 5: Typecheck + lint + commit**

```bash
pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint
git add apps/web/src/app/\(app\)/leads apps/web/tests/e2e/quick-book.spec.ts
git commit -m "feat(web): /leads/quick instant-book screen (recommend rep, today-first slots, who's-free, book)"
```

---

### Task 6: Final verification

- [ ] **Step 1: Full suite + typecheck + lint**

```bash
pnpm db:up && pnpm --filter @savvy/db db:migrate
pnpm test && pnpm typecheck && pnpm lint
```
Expected: all green (lint may show the pre-existing `pipeline.spec.ts` unused-`adminDb` warning only).

- [ ] **Step 2: Boot the app (Turbopack e2e parity)** — guards the `.js`-import CI failure class.

```bash
cd apps/web && ./node_modules/.bin/next dev -p 3008
```
Hit `/leads/quick` and `/leads` — confirm no module-not-found. (Or run the new e2e spec, which boots Turbopack.)

- [ ] **Step 3: Run the quick-book e2e**

```bash
cd apps/web && npx tsx tests/e2e/create-tenant.ts
export TEST_TENANT_ID=$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)")
./node_modules/.bin/playwright test tests/e2e/quick-book.spec.ts
```
Expected: PASS.

---

## Self-Review (completed by plan author)

- **Spec coverage (§4.1 shared service):** `recommendAssignee` → Task 1; `slotsForRep` → Task 3; `repsAvailableAt` → Task 2; `confirmIntakeBooking` → Task 4. §5 data-model: zip territories + round-robin tiebreak + `rep_availability_block` + today-first ranking all shipped in engine #47 (merged) — Task 1 only flips the default `strategy`→`territory` (spec §5.1, deferred from the engine plan to here). §6 quick-book screen + flow → Task 5. §7 AI/Vapi path, §settings UI, §rep-block UI → explicit follow-ups (noted in header). §8 edge cases: slot-taken re-check (bookLeadSlot exclusion + dedupe on re-confirm) Task 4; nobody-free (`whoIsFree` returns [] → screen falls back to `previewSlots`) Task 5; no-zip-match → round-robin (Task 1 test); strategy off / no reps → manual dropdown (Task 5 rep list always present).
- **Placeholder scan:** Task 5 Step 2 (QuickBook body) and Step 4 (e2e selectors) are intentionally contract-level rather than full verbatim code because the component is a UI assembly of already-specified server actions + the existing `NewLeadForm`/`AddressAutocomplete` idioms; every server-action signature it calls is fully typed in Task 4. All logic-bearing tasks (1–4) have complete code. This is the correct altitude for "assemble an established UI pattern."
- **Type consistency:** `recommendAssignee(tenantId, {zip,city,state})`, `repsAvailableAt(tenantId, {startsAt,type})`, `slotsForRep({tenantId,repId,…})`, `confirmIntakeBooking(input)` signatures match across the service module (Task 4) and their definitions (Tasks 1–3). `RecommendedSlot` shape unchanged. `previewSlots`/`whoIsFree`/`listReps` return shapes match what QuickBook (Task 5) consumes.
- **Atomicity note:** `confirmIntakeBooking` is create-lead-then-book across two txs, not one. This is acceptable: `createLeadForTenant` dedupes (re-confirm after a `slot_taken` reuses the same lead/customer/property), and `bookLeadSlot`'s exclusion constraint prevents double-booking. True single-tx atomicity would require duplicating the dedupe logic into a db-layer fusion — deferred (YAGNI) unless a real duplicate-lead issue appears.
- **Rep-alert interaction:** quick-book `source: "inbound-call"` makes `runRepAlert` skip (no spurious "call now" text to the booking rep), and `markLeadContacted` + `lead/contacted` cancels the speed-to-lead clock. Verified against the shipped #49 logic.
