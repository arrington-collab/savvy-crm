# Stage 4 — Drive-time-aware Assignment + getRecommendedSlots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assign each new lead to the rep who can reach the property soonest, and expose `getRecommendedSlots(leadId)` returning the top 2–3 inspection slots ranked by soonest-feasible + least drive time + same-day clustering.

**Architecture:** A new fail-open drive-time gateway (Google Distance Matrix, mirrors the StormProof env-or-fake pattern) feeds two deterministic consumers: a new opt-in `"proximity"` assignment strategy, and a new `rankSlots` ranking used by `getRecommendedSlots`. A pure `resolveRepOrigin` decides where to measure drive-time *from* (last same-day appt → rep base → tenant office). One migration adds `user.base_lat/base_lng/skills`. No LLM on this path.

**Tech Stack:** TypeScript, Zod v3, Drizzle ORM, Next.js server actions, Inngest, Vitest, pnpm + Turborepo. Worktree `~/Sites/savvy-stage4`, branch `feat/stage4-drivetime-scheduling`.

## Global Constraints

- **Deterministic only** on this path — no AI gateway calls in assignment, ranking, or drive-time.
- **Fail-open:** a missing/erroring drive-time provider returns `null` and callers fall back to haversine/load-balance — never block assignment or scheduling.
- **Tenant isolation** on every query (RLS via `withTenant`, or `adminDb` only where the existing assignment/booking code already does — match the surrounding file).
- **Config in jsonb:** tenant office + drive-time weights live in `tenant.settings.scheduling` (zod-defaulted); only `user.base_lat/base_lng/skills` are columns.
- **Drive-time provider key is server-side** `GOOGLE_MAPS_SERVER_KEY` — NEVER the browser `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`. Document it in `.env.example`; commit no secret.
- **Migration hygiene:** every generated `.sql` ships with its drizzle meta (`_journal.json` entry + `NNNN_snapshot.json`) in the same commit.
- **Local gating:** pure `@savvy/core` and `@savvy/integrations` unit tests + `pnpm typecheck` + `pnpm lint` run locally; DB-backed tests are gated by **CI** (local Postgres is unreliable here).

**Local gate commands** (from repo root `~/Sites/savvy-stage4`):
- `cd packages/core && npx vitest run` — pure core unit tests
- `cd packages/integrations && npx vitest run` — pure integration-gateway unit tests
- `pnpm typecheck` · `pnpm lint`

---

### Task 1: Drive-time gateway (`@savvy/integrations`)

**Files:**
- Create: `packages/integrations/src/distance.ts`
- Modify: `packages/integrations/src/index.ts`
- Test: `packages/integrations/src/distance.test.ts`

**Interfaces:**
- Produces: `type LatLng = { lat: number; lng: number }`; `interface DistanceGateway { driveMinutesMatrix(origins: LatLng[], dests: LatLng[]): Promise<(number | null)[][] | null> }`; `makeFakeDistance()`, `fakeDriveMinutes(a,b)`, singleton `distance`.

- [ ] **Step 1: Write the failing test**

Create `packages/integrations/src/distance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeFakeDistance, fakeDriveMinutes, type LatLng } from "./distance";

const mesa: LatLng = { lat: 33.42, lng: -111.83 };
const tempe: LatLng = { lat: 33.43, lng: -111.94 };
const far: LatLng = { lat: 34.5, lng: -112.5 };

describe("fakeDriveMinutes", () => {
  it("is zero for the same point", () => {
    expect(fakeDriveMinutes(mesa, mesa)).toBe(0);
  });
  it("grows with distance (nearer < farther)", () => {
    expect(fakeDriveMinutes(mesa, tempe)).toBeLessThan(fakeDriveMinutes(mesa, far));
  });
});

describe("makeFakeDistance", () => {
  it("returns a row-major minutes matrix [origins][dests]", async () => {
    const d = makeFakeDistance();
    const m = await d.driveMinutesMatrix([mesa, tempe], [far]);
    expect(m).not.toBeNull();
    expect(m!.length).toBe(2);
    expect(m![0].length).toBe(1);
    expect(typeof m![0][0]).toBe("number");
  });
  it("returns null for an empty origin or dest list", async () => {
    const d = makeFakeDistance();
    expect(await d.driveMinutesMatrix([], [far])).toBeNull();
    expect(await d.driveMinutesMatrix([mesa], [])).toBeNull();
  });
  it("counts calls (so callers can assert a single batched request)", async () => {
    const d = makeFakeDistance();
    await d.driveMinutesMatrix([mesa], [far]);
    await d.driveMinutesMatrix([tempe], [far]);
    expect(d.calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/integrations && npx vitest run src/distance.test.ts`
Expected: FAIL — cannot find module `./distance`.

- [ ] **Step 3: Implement the gateway**

Create `packages/integrations/src/distance.ts`:

```ts
export type LatLng = { lat: number; lng: number };

export interface DistanceGateway {
  // Drive-time MINUTES for each origin→dest pairing, row-major [origins][dests].
  // Any unresolvable pair is null; the whole call is null on transport/quota error (fail-open).
  driveMinutesMatrix(origins: LatLng[], dests: LatLng[]): Promise<(number | null)[][] | null>;
}

function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371; // km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Deterministic fake: 1.3× road factor over straight-line km at ~40 km/h ⇒ minutes = km * 1.95.
export function fakeDriveMinutes(a: LatLng, b: LatLng): number {
  return Math.round(haversineKm(a, b) * 1.95);
}

const SERVER_KEY = (): string => process.env.GOOGLE_MAPS_SERVER_KEY ?? "";

export const httpDistance: DistanceGateway = {
  async driveMinutesMatrix(origins, dests) {
    if (!SERVER_KEY() || origins.length === 0 || dests.length === 0) return null;
    try {
      const u = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
      u.searchParams.set("origins", origins.map((p) => `${p.lat},${p.lng}`).join("|"));
      u.searchParams.set("destinations", dests.map((p) => `${p.lat},${p.lng}`).join("|"));
      u.searchParams.set("departure_time", "now"); // duration_in_traffic when available
      u.searchParams.set("key", SERVER_KEY());
      const res = await fetch(u);
      if (!res.ok) return null;
      const data = (await res.json()) as {
        rows?: { elements?: { status?: string; duration_in_traffic?: { value: number }; duration?: { value: number } }[] }[];
      };
      const rows = data.rows ?? [];
      return origins.map((_, i) =>
        dests.map((__, j) => {
          const el = rows[i]?.elements?.[j];
          if (!el || el.status !== "OK") return null;
          const secs = el.duration_in_traffic?.value ?? el.duration?.value;
          return typeof secs === "number" ? Math.round(secs / 60) : null;
        }),
      );
    } catch {
      return null;
    }
  },
};

export function makeFakeDistance(): DistanceGateway & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    async driveMinutesMatrix(origins, dests) {
      state.calls++;
      if (origins.length === 0 || dests.length === 0) return null;
      return origins.map((o) => dests.map((d) => fakeDriveMinutes(o, d)));
    },
  };
}

// Use the real provider only when a server key is configured; otherwise the fake (dev/test).
export const distance: DistanceGateway = process.env.GOOGLE_MAPS_SERVER_KEY ? httpDistance : makeFakeDistance();
```

- [ ] **Step 4: Export from the package barrel**

In `packages/integrations/src/index.ts`, add after the `stormproof`/`storage` exports:

```ts
export { distance, httpDistance, makeFakeDistance, fakeDriveMinutes, type DistanceGateway, type LatLng } from "./distance";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/integrations && npx vitest run src/distance.test.ts`
Expected: PASS (6 assertions).

- [ ] **Step 6: Document the new env var**

In `.env.example`, add (no value):

```
# Server-side Google key with Distance Matrix API enabled (NOT the NEXT_PUBLIC browser key).
# Unset => drive-time falls back to straight-line distance (fail-open).
GOOGLE_MAPS_SERVER_KEY=
```

- [ ] **Step 7: Commit**

```bash
git add packages/integrations/src/distance.ts packages/integrations/src/distance.test.ts packages/integrations/src/index.ts .env.example
git commit -m "feat(integrations): drive-time gateway (Google Distance Matrix, fail-open fake)"
```

---

### Task 2: Rep-origin resolver (`@savvy/core`)

**Files:**
- Create: `packages/core/src/rep-origin.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/rep-origin.test.ts`

**Interfaces:**
- Produces: `type LatLng`, `type RepAppt = { startsAt: Date; endsAt: Date; lat: number; lng: number }`, `resolveRepOrigin(args): LatLng | null`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/rep-origin.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveRepOrigin, type RepAppt } from "./rep-origin";

const base = { lat: 33.3, lng: -111.8 };
const office = { lat: 33.4, lng: -111.9 };
const apptA: RepAppt = { startsAt: new Date("2026-07-01T15:00:00Z"), endsAt: new Date("2026-07-01T16:00:00Z"), lat: 33.5, lng: -111.7 };
const apptB: RepAppt = { startsAt: new Date("2026-07-01T17:00:00Z"), endsAt: new Date("2026-07-01T18:00:00Z"), lat: 33.6, lng: -111.6 };

describe("resolveRepOrigin", () => {
  const ref = new Date("2026-07-01T18:30:00Z");

  it("uses the latest same-day appointment that ends before the reference time", () => {
    expect(resolveRepOrigin({ sameDayAppts: [apptA, apptB], reference: ref, repBase: base, tenantOffice: office }))
      .toEqual({ lat: 33.6, lng: -111.6 });
  });
  it("ignores appointments that end after the reference time", () => {
    const early = new Date("2026-07-01T16:30:00Z"); // only apptA has ended
    expect(resolveRepOrigin({ sameDayAppts: [apptA, apptB], reference: early, repBase: base, tenantOffice: office }))
      .toEqual({ lat: 33.5, lng: -111.7 });
  });
  it("falls back to the rep base when no appointment has ended", () => {
    const dawn = new Date("2026-07-01T14:00:00Z");
    expect(resolveRepOrigin({ sameDayAppts: [apptA, apptB], reference: dawn, repBase: base, tenantOffice: office }))
      .toEqual(base);
  });
  it("falls back to the tenant office when there is no base", () => {
    expect(resolveRepOrigin({ sameDayAppts: [], reference: ref, repBase: null, tenantOffice: office }))
      .toEqual(office);
  });
  it("returns null when nothing is resolvable", () => {
    expect(resolveRepOrigin({ sameDayAppts: [], reference: ref, repBase: null, tenantOffice: null }))
      .toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx vitest run src/rep-origin.test.ts`
Expected: FAIL — cannot find module `./rep-origin`.

- [ ] **Step 3: Implement the resolver**

Create `packages/core/src/rep-origin.ts`:

```ts
export type LatLng = { lat: number; lng: number };
export type RepAppt = { startsAt: Date; endsAt: Date; lat: number; lng: number };

// Where to measure drive-time FROM, as of `reference`:
//   last same-day appointment ending before reference → rep base → tenant office → null.
export function resolveRepOrigin(args: {
  sameDayAppts: RepAppt[];
  reference: Date;
  repBase: LatLng | null;
  tenantOffice: LatLng | null;
}): LatLng | null {
  const { sameDayAppts, reference, repBase, tenantOffice } = args;
  const prior = sameDayAppts
    .filter((a) => a.endsAt.getTime() <= reference.getTime())
    .sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime())[0];
  if (prior) return { lat: prior.lat, lng: prior.lng };
  if (repBase) return repBase;
  if (tenantOffice) return tenantOffice;
  return null;
}
```

- [ ] **Step 4: Export from the barrel**

In `packages/core/src/index.ts`, add:

```ts
export * from "./rep-origin";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run src/rep-origin.test.ts`
Expected: PASS (5 assertions).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/rep-origin.ts packages/core/src/rep-origin.test.ts packages/core/src/index.ts
git commit -m "feat(core): resolveRepOrigin (last-appt → base → office)"
```

---

### Task 3: Scheduling config (office + drive weights) and `rankSlots` (`@savvy/core`)

**Files:**
- Modify: `packages/core/src/scheduling.ts`
- Test: `packages/core/src/scheduling.test.ts` (append; create if absent)

**Interfaces:**
- Consumes: `type Slot = { startsAt: Date; endsAt: Date; score: number }` (existing, from `computeOpenSlots`).
- Produces: `SchedulingConfig.office?: LatLng`, `SchedulingConfig.driveTime: { wSoon; wDrive; wCluster; driveHalfMin }`; `type RankedSlot = Slot & { driveMinutes: number | null }`; `rankSlots(args): RankedSlot[]`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/scheduling.test.ts` (create the file with this content if it doesn't exist):

```ts
import { describe, it, expect } from "vitest";
import { rankSlots, parseSchedulingConfig, type Slot } from "./scheduling";

const mk = (iso: string, score = 0): Slot => ({ startsAt: new Date(iso), endsAt: new Date(iso), score });

describe("parseSchedulingConfig drive-time defaults", () => {
  it("defaults driveTime weights and leaves office undefined", () => {
    const c = parseSchedulingConfig({});
    expect(c.driveTime).toEqual({ wSoon: 0.5, wDrive: 0.3, wCluster: 0.2, driveHalfMin: 20 });
    expect(c.office).toBeUndefined();
  });
  it("accepts a configured office and weight overrides", () => {
    const c = parseSchedulingConfig({ office: { lat: 33.4, lng: -111.9 }, driveTime: { wDrive: 0.6 } });
    expect(c.office).toEqual({ lat: 33.4, lng: -111.9 });
    expect(c.driveTime.wDrive).toBe(0.6);
    expect(c.driveTime.driveHalfMin).toBe(20); // untouched default
  });
});

describe("rankSlots", () => {
  const weights = { wSoon: 0.5, wDrive: 0.3, wCluster: 0.2, driveHalfMin: 20 };
  const a = mk("2026-07-01T15:00:00Z");
  const b = mk("2026-07-01T17:00:00Z");

  it("prefers the soonest slot when drive time is equal", () => {
    const r = rankSlots({ slots: [b, a], driveMinutesBySlotIndex: [10, 10], weights });
    expect(r[0].startsAt.toISOString()).toBe("2026-07-01T15:00:00.000Z");
  });
  it("prefers the nearer slot when start times are equal", () => {
    const a2 = mk("2026-07-01T15:00:00Z");
    const r = rankSlots({ slots: [a, a2], driveMinutesBySlotIndex: [40, 5], weights });
    expect(r[0].driveMinutes).toBe(5);
  });
  it("ranks on soon+cluster only when drive time is unknown (null)", () => {
    const near = mk("2026-07-01T17:00:00Z", 1); // later but high cluster score
    const r = rankSlots({ slots: [a, near], driveMinutesBySlotIndex: [null, null], weights });
    expect(r[0].driveMinutes).toBeNull();
    expect(r).toHaveLength(2);
  });
  it("attaches driveMinutes to each ranked slot", () => {
    const r = rankSlots({ slots: [a], driveMinutesBySlotIndex: [12], weights });
    expect(r[0].driveMinutes).toBe(12);
  });
  it("returns [] for no slots", () => {
    expect(rankSlots({ slots: [], driveMinutesBySlotIndex: [], weights })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run src/scheduling.test.ts`
Expected: FAIL — `rankSlots` not exported; `driveTime` missing on parsed config.

- [ ] **Step 3: Extend the config schema + type + parser**

In `packages/core/src/scheduling.ts`:

(a) After the `reminderCfg` declaration (~line 11) add:

```ts
const latLngCfg = z.object({ lat: z.number(), lng: z.number() });
const driveTimeCfg = z.object({
  wSoon: z.number().default(0.5),
  wDrive: z.number().default(0.3),
  wCluster: z.number().default(0.2),
  driveHalfMin: z.number().positive().default(20),
});
const DRIVE_DEFAULTS = { wSoon: 0.5, wDrive: 0.3, wCluster: 0.2, driveHalfMin: 20 } as const;
```

(b) In the `schema = z.object({ ... })` block, add two keys:

```ts
  office: latLngCfg.optional(),
  driveTime: driveTimeCfg.default({}),
```

(c) In the `SchedulingConfig` type, add:

```ts
  office?: { lat: number; lng: number };
  driveTime: { wSoon: number; wDrive: number; wCluster: number; driveHalfMin: number };
```

(d) In `parseSchedulingConfig`'s returned object, add:

```ts
    office: p.office,
    driveTime: { ...DRIVE_DEFAULTS, ...p.driveTime },
```

- [ ] **Step 4: Add `rankSlots`**

Append to `packages/core/src/scheduling.ts`:

```ts
export type RankedSlot = Slot & { driveMinutes: number | null };

// Blend the existing slot score (clustering) with soonest-feasible + drive-time, deterministically.
// When a slot's driveMinutes is null, its drive weight is dropped and the remaining weights renormalize.
export function rankSlots(args: {
  slots: Slot[];
  driveMinutesBySlotIndex: (number | null)[];
  weights: SchedulingConfig["driveTime"];
}): RankedSlot[] {
  const { slots, driveMinutesBySlotIndex, weights } = args;
  if (slots.length === 0) return [];
  const times = slots.map((s) => s.startsAt.getTime());
  const earliest = Math.min(...times);
  const span = Math.max(1, Math.max(...times) - earliest);

  return slots
    .map((s, i) => {
      const soonScore = 1 - (s.startsAt.getTime() - earliest) / span; // 1 (soonest) .. 0
      const dm = driveMinutesBySlotIndex[i] ?? null;
      const driveScore = dm == null ? 0 : 1 / (1 + dm / weights.driveHalfMin);
      const wDrive = dm == null ? 0 : weights.wDrive;
      const norm = weights.wSoon + weights.wCluster + wDrive;
      const final = (weights.wSoon * soonScore + weights.wCluster * s.score + wDrive * driveScore) / norm;
      return { startsAt: s.startsAt, endsAt: s.endsAt, score: final, driveMinutes: dm };
    })
    .sort((a, b) => b.score - a.score || a.startsAt.getTime() - b.startsAt.getTime());
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run src/scheduling.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck (the config-shape change ripples)**

Run: `pnpm typecheck`
Expected: PASS. If `parseSchedulingConfig` consumers break on the new required `driveTime`, they only read it via the parser, so no call-site change is needed.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/scheduling.ts packages/core/src/scheduling.test.ts
git commit -m "feat(core): scheduling office + drive-time weights + rankSlots"
```

---

### Task 4: Schema migration — `user.base_lat/base_lng/skills`

**Files:**
- Modify: `packages/db/src/schema/tenancy.ts`
- Generate: `packages/db/drizzle/NNNN_*.sql` + `packages/db/drizzle/meta/*`

**Interfaces:**
- Produces: `user.baseLat: number | null`, `user.baseLng: number | null`, `user.skills: string[]` (default `[]`).

- [ ] **Step 1: Add the columns to the Drizzle schema**

In `packages/db/src/schema/tenancy.ts`, in the `user` table definition, add after `gcalConnectionId` (and ensure `doublePrecision` is imported from `drizzle-orm/pg-core`):

```ts
  baseLat: doublePrecision("base_lat"),
  baseLng: doublePrecision("base_lng"),
  skills: text("skills").array().notNull().default([]),
```

If `doublePrecision` or `text` isn't already imported at the top of the file, add it to the existing `drizzle-orm/pg-core` import.

- [ ] **Step 2: Generate the migration + meta**

Run: `pnpm db:generate`
Expected: a new `packages/db/drizzle/NNNN_*.sql` adding the three columns, plus an updated `meta/_journal.json` and a new `meta/NNNN_snapshot.json`.

- [ ] **Step 3: Verify the migration SQL**

Run: `ls packages/db/drizzle/*.sql | tail -1` then open it.
Expected: it contains `ADD COLUMN "base_lat" double precision`, `"base_lng" double precision`, and `"skills" text[] DEFAULT '{}' NOT NULL` (or Drizzle's equivalent). Confirm `meta/_journal.json` has a new entry and the matching `NNNN_snapshot.json` exists.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit (SQL + meta together)**

```bash
git add packages/db/src/schema/tenancy.ts packages/db/drizzle
git commit -m "feat(db): user.base_lat/base_lng/skills for proximity assignment"
```

---

### Task 5: `"proximity"` assignment strategy (`@savvy/core`)

**Files:**
- Modify: `packages/core/src/lead-assignment.ts`
- Modify: `packages/core/src/pick-assignee.ts`
- Test: `packages/core/src/pick-assignee.test.ts` (append; create if absent)

**Interfaces:**
- Consumes: `AssignmentConfig`, existing `pickAssignee` opts.
- Produces: `"proximity"` added to `ASSIGNMENT_STRATEGY`; `AssignmentCandidate` gains `skills?: string[]` and `driveMinutes?: number | null`; `pickAssignee` opts `lead` gains `lane?: string | null`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/pick-assignee.test.ts` (create with this content if absent):

```ts
import { describe, it, expect } from "vitest";
import { pickAssignee, type AssignmentCandidate } from "./pick-assignee";

const lead = { state: "AZ", city: "Mesa", score: 70, lane: null as string | null };
const cfg = { strategy: "proximity" as const };

const cand = (over: Partial<AssignmentCandidate>): AssignmentCandidate => ({
  userId: "u", openLeadCount: 0, lastAssignedAt: null, ...over,
});

describe("pickAssignee proximity", () => {
  it("chooses the rep with the smallest drive time", () => {
    const cands = [cand({ userId: "near", driveMinutes: 8 }), cand({ userId: "far", driveMinutes: 40 })];
    expect(pickAssignee({ strategy: "proximity", config: cfg, candidates: cands, lead })).toBe("near");
  });
  it("breaks a drive-time tie by least open leads", () => {
    const cands = [cand({ userId: "busy", driveMinutes: 10, openLeadCount: 5 }), cand({ userId: "free", driveMinutes: 10, openLeadCount: 1 })];
    expect(pickAssignee({ strategy: "proximity", config: cfg, candidates: cands, lead })).toBe("free");
  });
  it("ranks reps with a known drive time ahead of reps with none", () => {
    const cands = [cand({ userId: "unknown", driveMinutes: null }), cand({ userId: "known", driveMinutes: 25 })];
    expect(pickAssignee({ strategy: "proximity", config: cfg, candidates: cands, lead })).toBe("known");
  });
  it("restricts to skilled reps when the lane needs a skill and one exists", () => {
    const tileLead = { ...lead, lane: "tile" };
    const cands = [cand({ userId: "generalist", driveMinutes: 5, skills: [] }), cand({ userId: "tiler", driveMinutes: 30, skills: ["tile"] })];
    expect(pickAssignee({ strategy: "proximity", config: cfg, candidates: cands, lead: tileLead })).toBe("tiler");
  });
  it("ignores the skill filter when no rep has the skill", () => {
    const tileLead = { ...lead, lane: "tile" };
    const cands = [cand({ userId: "a", driveMinutes: 5, skills: [] }), cand({ userId: "b", driveMinutes: 30, skills: [] })];
    expect(pickAssignee({ strategy: "proximity", config: cfg, candidates: cands, lead: tileLead })).toBe("a");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run src/pick-assignee.test.ts`
Expected: FAIL — `"proximity"` not assignable; `driveMinutes`/`skills`/`lane` not on the types.

- [ ] **Step 3: Add `"proximity"` to the strategy union**

In `packages/core/src/lead-assignment.ts` line 3, extend the array:

```ts
export const ASSIGNMENT_STRATEGY = ["off", "round_robin", "least_loaded", "territory", "score", "proximity"] as const;
```

(The `assignmentConfigSchema` enum derives from this array, so it now accepts `"proximity"` automatically.)

- [ ] **Step 4: Extend the candidate type and add the proximity branch**

In `packages/core/src/pick-assignee.ts`:

(a) Replace the `AssignmentCandidate` type:

```ts
export type AssignmentCandidate = {
  userId: string;
  openLeadCount: number;
  lastAssignedAt: string | null;
  driveMinutes?: number | null;
  skills?: string[];
};
```

(b) In the `pickAssignee` opts, change the `lead` field type to include `lane`:

```ts
  lead: { state: string | null; city: string | null; score: number | null; lane?: string | null };
```

(c) Add the proximity branch immediately before the final `return null;`:

```ts
  if (strategy === "proximity") {
    let pool = candidates;
    if (lead.lane) {
      const skilled = candidates.filter((c) => (c.skills ?? []).includes(lead.lane!));
      if (skilled.length > 0) pool = skilled;
    }
    const ranked = [...pool].sort((a, b) => {
      const da = a.driveMinutes ?? Number.POSITIVE_INFINITY;
      const db = b.driveMinutes ?? Number.POSITIVE_INFINITY;
      return da - db || a.openLeadCount - b.openLeadCount || ts(a.lastAssignedAt) - ts(b.lastAssignedAt);
    });
    return ranked[0]?.userId ?? null;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run src/pick-assignee.test.ts`
Expected: PASS (5 proximity assertions; existing strategy tests still green).

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (The `lead-intake.ts` call site passes a `lead` object without `lane` — fine, it's optional. It will be set in Task 7.)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/lead-assignment.ts packages/core/src/pick-assignee.ts packages/core/src/pick-assignee.test.ts
git commit -m "feat(core): proximity assignment strategy (min drive-time, soft skill match)"
```

---

### Task 6: DB loaders — candidate base/skills, same-day appts, tenant office (`@savvy/db`)

**Files:**
- Modify: `packages/db/src/lifecycle/assignment.ts`
- Test: `packages/db/src/lifecycle/assignment.test.ts` (append a CI-gated integration test; create if absent)

**Interfaces:**
- Consumes: `RepAppt` shape `{ startsAt: Date; endsAt: Date; lat: number; lng: number }` (from `@savvy/core`).
- Produces: `DbAssignmentCandidate` gains `baseLat: number | null`, `baseLng: number | null`, `skills: string[]`; new `getRepSameDayAppts(tx, tenantId, ref): Promise<Map<string, RepAppt[]>>`; new `getSchedulingOffice(tenantId): Promise<{ lat: number; lng: number } | null>`.

- [ ] **Step 1: Extend `getAssignmentCandidates` to carry base + skills**

In `packages/db/src/lifecycle/assignment.ts`:

(a) Extend the `DbAssignmentCandidate` type:

```ts
export type DbAssignmentCandidate = {
  userId: string;
  role: string;
  openLeadCount: number;
  lastAssignedAt: string | null;
  baseLat: number | null;
  baseLng: number | null;
  skills: string[];
};
```

(b) In the `users` select, add the new columns:

```ts
  const users = await tx
    .select({ id: user.id, role: user.role, baseLat: user.baseLat, baseLng: user.baseLng, skills: user.skills })
    .from(user)
    .where(and(eq(user.tenantId, tenantId), isNull(user.deactivatedAt), inArray(user.role, [...SALES_ROLES])));
```

(c) In the `return users.map(...)`, add the three fields (note `baseLat/baseLng` come back as `string | number | null` from `double precision` — coerce):

```ts
  return users.map((u) => ({
    userId: u.id,
    role: u.role,
    openLeadCount: statById.get(u.id)?.openCount ?? 0,
    lastAssignedAt: statById.get(u.id)?.lastAssignedAt ?? null,
    baseLat: u.baseLat == null ? null : Number(u.baseLat),
    baseLng: u.baseLng == null ? null : Number(u.baseLng),
    skills: u.skills ?? [],
  }));
```

- [ ] **Step 2: Add `getRepSameDayAppts` and `getSchedulingOffice`**

Add these imports at the top (extend existing import lines — `appointment`, `job`, `property` from the schema; `gte`/`lt` from `drizzle-orm`):

```ts
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { user, lead, job, property, appointment } from "../schema/index";
```

Append these functions:

```ts
// A rep's scheduled appointments on the same UTC day as `ref`, with the property location,
// via appointment → job → property. Returned grouped by assignee userId.
export async function getRepSameDayAppts(
  tx: Tx,
  tenantId: string,
  ref: Date,
): Promise<Map<string, { startsAt: Date; endsAt: Date; lat: number; lng: number }[]>> {
  const dayStart = new Date(ref); dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  const rows = await tx
    .select({
      userId: appointment.assigneeUserId,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      lat: property.lat,
      lng: property.lng,
    })
    .from(appointment)
    .leftJoin(job, eq(appointment.jobId, job.id))
    .leftJoin(property, eq(job.propertyId, property.id))
    .where(
      and(
        eq(appointment.tenantId, tenantId),
        eq(appointment.status, "scheduled"),
        gte(appointment.startsAt, dayStart),
        lt(appointment.startsAt, dayEnd),
      ),
    );
  const out = new Map<string, { startsAt: Date; endsAt: Date; lat: number; lng: number }[]>();
  for (const r of rows) {
    if (!r.userId || r.lat == null || r.lng == null) continue;
    const list = out.get(r.userId) ?? [];
    list.push({ startsAt: r.startsAt, endsAt: r.endsAt, lat: Number(r.lat), lng: Number(r.lng) });
    out.set(r.userId, list);
  }
  return out;
}

// Tenant office origin from settings.scheduling.office (jsonb), if configured.
export async function getSchedulingOffice(tenantId: string): Promise<{ lat: number; lng: number } | null> {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const office = ((t?.settings as { scheduling?: { office?: unknown } } | null)?.scheduling?.office) as
    | { lat?: number; lng?: number }
    | undefined;
  return office && typeof office.lat === "number" && typeof office.lng === "number"
    ? { lat: office.lat, lng: office.lng }
    : null;
}
```

- [ ] **Step 3: Export the new functions**

Confirm `packages/db/src/index.ts` re-exports the lifecycle barrel (it already exports `getAssignmentCandidates`). If it names symbols individually, add `getRepSameDayAppts` and `getSchedulingOffice`.
Run: `grep -n "getAssignmentCandidates\|lifecycle/assignment" packages/db/src/index.ts`

- [ ] **Step 4: Write a CI-gated integration test**

Append to `packages/db/src/lifecycle/assignment.test.ts` (follow the file's existing tenant/seed harness; if the file doesn't exist, mirror another `lifecycle/*.test.ts` setup). The test seeds a tenant + user with `baseLat/baseLng/skills`, asserts `getAssignmentCandidates` returns them, and seeds one scheduled appointment (job→property with lat/lng) and asserts `getRepSameDayAppts` groups it under the assignee. Use the same DB bootstrap as the sibling lifecycle tests.

> If no local Postgres is available, this test is **expected to be run by CI**. Do not block the task on a local DB connection error — note it in the report and proceed.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/assignment.ts packages/db/src/lifecycle/assignment.test.ts packages/db/src/index.ts
git commit -m "feat(db): candidate base/skills + same-day appts + tenant office loaders"
```

---

### Task 7: Wire proximity into `runLeadAssignment` (`@savvy/agents`)

**Files:**
- Modify: `packages/agents/src/functions/lead-intake.ts`
- Test: `packages/agents/src/functions/lead-intake.test.ts` (extend; CI-gated DB path)

**Interfaces:**
- Consumes: `distance` (from `@savvy/integrations`), `resolveRepOrigin` (from `@savvy/core`), `getRepSameDayAppts`, `getSchedulingOffice` (from `@savvy/db`), extended `getAssignmentCandidates`.

- [ ] **Step 1: Add imports**

In `packages/agents/src/functions/lead-intake.ts`:

(a) Add to the `@savvy/core` import: `resolveRepOrigin`.
(b) Add to the `@savvy/db` import: `getRepSameDayAppts`, `getSchedulingOffice`, `property`.
(c) Add a new import (mirror how `stormProof`/`enrichProperty` get their gateway — `distance` comes from `@savvy/integrations`):

```ts
import { distance, type LatLng } from "@savvy/integrations";
```

- [ ] **Step 2: Replace the body of `runLeadAssignment` to support proximity**

Replace the `withTenant(...)` block inside `runLeadAssignment` (currently lines ~98–110) with:

```ts
  return withTenant(tenantId, async (tx) => {
    const [l] = await tx
      .select({ assignedUserId: lead.assignedUserId, score: lead.score, propertyId: lead.propertyId })
      .from(lead)
      .where(eq(lead.id, leadId));
    if (!l) return { assigned: null, reason: "no-lead" };
    if (l.assignedUserId) return { assigned: null, reason: "already-assigned" };

    let candidates = await getAssignmentCandidates(tx, tenantId);
    let lane: string | null = null;

    if (config.strategy === "proximity") {
      // Destination = the lead's property; lane derives from roof type until Phase B models it.
      const dest = l.propertyId
        ? (await tx.select({ lat: property.lat, lng: property.lng, roofType: property.roofType }).from(property).where(eq(property.id, l.propertyId)))[0]
        : undefined;
      const destPoint: LatLng | null =
        dest && dest.lat != null && dest.lng != null ? { lat: Number(dest.lat), lng: Number(dest.lng) } : null;
      lane = dest?.roofType === "tile" ? "tile" : null;

      if (destPoint) {
        const now = new Date();
        const office = await getSchedulingOffice(tenantId);
        const apptsByUser = await getRepSameDayAppts(tx, tenantId, now);
        const resolved = candidates.map((c) => ({
          c,
          origin: resolveRepOrigin({
            sameDayAppts: apptsByUser.get(c.userId) ?? [],
            reference: now,
            repBase: c.baseLat != null && c.baseLng != null ? { lat: c.baseLat, lng: c.baseLng } : null,
            tenantOffice: office,
          }),
        }));
        const withOrigin = resolved.filter((r): r is { c: typeof r.c; origin: LatLng } => r.origin != null);
        const matrix = await distance.driveMinutesMatrix(withOrigin.map((r) => r.origin), [destPoint]);
        const dmByUser = new Map<string, number | null>();
        withOrigin.forEach((r, i) => dmByUser.set(r.c.userId, matrix ? matrix[i][0] : null));
        candidates = candidates.map((c) => ({ ...c, driveMinutes: dmByUser.get(c.userId) ?? null }));
      }
    }

    const userId = pickAssignee({
      strategy: config.strategy,
      config,
      candidates,
      lead: { state: leadCtx.state, city: leadCtx.city, score: l.score, lane },
    });
    if (!userId) return { assigned: null, reason: "no-candidate" };
    await setLeadOwner(tx, { tenantId, leadId, userId });
    return { assigned: userId, reason: "assigned" };
  });
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (`getAssignmentCandidates` now returns the extended shape; `pickAssignee` accepts `driveMinutes`/`lane`.)

- [ ] **Step 4: Extend the workflow test (CI-gated)**

In `packages/agents/src/functions/lead-intake.test.ts`, add a case: seed a tenant with `settings.assignment = { strategy: "proximity" }`, two reps with different `baseLat/baseLng`, and a lead whose property has lat/lng; assert the **nearer** rep (by the fake drive-time) is assigned. The fake `distance` is active because `GOOGLE_MAPS_SERVER_KEY` is unset in test. Reuse the file's existing seed harness.

> CI-gated: if local Postgres is unavailable, note it and rely on CI. Do not weaken the assertion.

- [ ] **Step 5: Run the agents unit tests that don't need a DB**

Run: `cd packages/agents && npx vitest run src/functions/lead-intake.test.ts`
Expected: PASS for any non-DB cases; DB-backed cases may error on connection locally — that's CI's job. Report what ran.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/functions/lead-intake.ts packages/agents/src/functions/lead-intake.test.ts
git commit -m "feat(agents): proximity-aware lead assignment via drive-time matrix"
```

---

### Task 8: `getRecommendedSlots(leadId)` server action (`apps/web`)

**Files:**
- Create: `apps/web/src/lib/recommended-slots.ts`
- Test: `apps/web/src/lib/recommended-slots.test.ts` (CI-gated; the ranking math is already unit-tested in Task 3)

**Interfaces:**
- Consumes: `parseSchedulingConfig`, `computeOpenSlots`, `rankSlots`, `resolveRepOrigin` (`@savvy/core`); `distance` (`@savvy/integrations`); `adminDb`, `lead`, `job`, `user`, `property`, `appointment`, `tenant`, `eq`, `and` (`@savvy/db`).
- Produces: `getRecommendedSlots(leadId, opts?): Promise<{ error: string } | { slots: { startsAt: string; endsAt: string; driveMinutes: number | null }[] }>`.

- [ ] **Step 1: Implement the action**

Create `apps/web/src/lib/recommended-slots.ts` (mirrors `booking-action.ts`'s `loadBusy`/settings pattern):

```ts
"use server";
import { adminDb, lead, user, property, appointment, job, tenant, eq, and } from "@savvy/db";
import { parseSchedulingConfig, computeOpenSlots, rankSlots, resolveRepOrigin, type LatLng } from "@savvy/core";
import { distance } from "@savvy/integrations";

type RecommendedSlot = { startsAt: string; endsAt: string; driveMinutes: number | null };

export async function getRecommendedSlots(
  leadId: string,
  opts?: { type?: "inspection" | "cm" | "crew"; limit?: number },
): Promise<{ error: "no_lead" | "no_assignee" } | { slots: RecommendedSlot[] }> {
  const type = opts?.type ?? "inspection";
  const limit = opts?.limit ?? 3;

  const [l] = await adminDb
    .select({ tenantId: lead.tenantId, assignedUserId: lead.assignedUserId, propertyId: lead.propertyId })
    .from(lead)
    .where(eq(lead.id, leadId));
  if (!l) return { error: "no_lead" };
  if (!l.assignedUserId) return { error: "no_assignee" };

  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, l.tenantId));
  const cfg = parseSchedulingConfig((t?.settings as { scheduling?: unknown } | null)?.scheduling);

  // Destination + cluster point = the lead's property.
  const dest = l.propertyId
    ? (await adminDb.select({ lat: property.lat, lng: property.lng }).from(property).where(eq(property.id, l.propertyId)))[0]
    : undefined;
  const destPoint: LatLng | null = dest && dest.lat != null && dest.lng != null ? { lat: Number(dest.lat), lng: Number(dest.lng) } : null;

  // Assignee's scheduled appts (with location) across the horizon — used for both busy + origin.
  const horizonEnd = new Date(Date.now() + cfg.bookingHorizonDays * 86_400_000);
  const apptRows = await adminDb
    .select({ startsAt: appointment.startsAt, endsAt: appointment.endsAt, lat: property.lat, lng: property.lng })
    .from(appointment)
    .leftJoin(job, eq(appointment.jobId, job.id))
    .leftJoin(property, eq(job.propertyId, property.id))
    .where(and(eq(appointment.tenantId, l.tenantId), eq(appointment.assigneeUserId, l.assignedUserId), eq(appointment.status, "scheduled")));
  const busy = apptRows
    .filter((r) => r.startsAt >= new Date() && r.startsAt < horizonEnd)
    .map((r) => ({ startsAt: r.startsAt, endsAt: r.endsAt, lat: r.lat == null ? undefined : Number(r.lat), lng: r.lng == null ? undefined : Number(r.lng) }));

  const slots = computeOpenSlots({
    config: cfg, type, existingAppts: busy, fromDate: new Date(), now: new Date(),
    clusterAround: destPoint ?? undefined,
  }).slice(0, 12);

  // Rep base + tenant office for the origin fallback chain.
  const [u] = await adminDb.select({ baseLat: user.baseLat, baseLng: user.baseLng }).from(user).where(eq(user.id, l.assignedUserId));
  const repBase: LatLng | null = u?.baseLat != null && u?.baseLng != null ? { lat: Number(u.baseLat), lng: Number(u.baseLng) } : null;
  const officeRaw = (t?.settings as { scheduling?: { office?: { lat?: number; lng?: number } } } | null)?.scheduling?.office;
  const tenantOffice: LatLng | null = officeRaw && typeof officeRaw.lat === "number" && typeof officeRaw.lng === "number" ? { lat: officeRaw.lat, lng: officeRaw.lng } : null;

  const sameDay = (day: Date) => busy.filter(
    (b) => b.lat != null && b.lng != null && b.startsAt.toISOString().slice(0, 10) === day.toISOString().slice(0, 10),
  ).map((b) => ({ startsAt: b.startsAt, endsAt: b.endsAt, lat: b.lat as number, lng: b.lng as number }));

  // Per-slot origin, then one batched drive-time call.
  const origins = slots.map((s) => resolveRepOrigin({ sameDayAppts: sameDay(s.startsAt), reference: s.startsAt, repBase, tenantOffice }));
  const idxWithOrigin = origins.map((o, i) => ({ o, i })).filter((x): x is { o: LatLng; i: number } => x.o != null);
  const matrix = destPoint && idxWithOrigin.length ? await distance.driveMinutesMatrix(idxWithOrigin.map((x) => x.o), [destPoint]) : null;
  const driveBySlot: (number | null)[] = slots.map(() => null);
  idxWithOrigin.forEach((x, k) => { driveBySlot[x.i] = matrix ? matrix[k][0] : null; });

  const ranked = rankSlots({ slots, driveMinutesBySlotIndex: driveBySlot, weights: cfg.driveTime }).slice(0, limit);
  return { slots: ranked.map((s) => ({ startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString(), driveMinutes: s.driveMinutes })) };
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Add a CI-gated smoke test**

Create `apps/web/src/lib/recommended-slots.test.ts`: seed a tenant (scheduling config with inspection type), an assigned rep with a base location, and a lead with a property; assert `getRecommendedSlots(leadId)` returns ≤3 slots each carrying a `driveMinutes` number (fake provider active in test). Also assert the `no_assignee` path for an unassigned lead. Mirror the seed harness used by other `apps/web` server-action tests.

> CI-gated: skip locally if Postgres is unavailable; note it and rely on CI.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/recommended-slots.ts apps/web/src/lib/recommended-slots.test.ts
git commit -m "feat(web): getRecommendedSlots(leadId) — drive-time-ranked top slots"
```

---

### Task 9: Pipeline doc (how it works + how to tune)

**Files:**
- Create: `docs/lead-pipeline-stage4.md`

- [ ] **Step 1: Write the doc**

Create `docs/lead-pipeline-stage4.md` covering: the chain position (Stage 4 of the lead-intake pipeline), the drive-time gateway + fail-open behavior, the `"proximity"` strategy and how to enable it (`tenant.settings.assignment.strategy = "proximity"`), the origin fallback chain, `getRecommendedSlots` and who consumes it, the tunable config (`tenant.settings.scheduling.office`, `tenant.settings.scheduling.driveTime` weights with their defaults and meaning, `user.base_lat/base_lng/skills`), and the `GOOGLE_MAPS_SERVER_KEY` requirement (with the note that without it, ranking degrades to straight-line distance). Keep it to ~1 page.

- [ ] **Step 2: Commit**

```bash
git add docs/lead-pipeline-stage4.md
git commit -m "docs: Stage 4 drive-time scheduling — how it works and how to tune"
```

---

### Task 10: Full gate, push, PR, CI

**Files:** none (verification + integration)

- [ ] **Step 1: Run the full local gate**

```bash
cd ~/Sites/savvy-stage4
( cd packages/core && npx vitest run )
( cd packages/integrations && npx vitest run )
pnpm typecheck
pnpm lint
```
Expected: all PASS. Fix any failure before continuing.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feat/stage4-drivetime-scheduling
```

- [ ] **Step 3: Open the PR against main**

```bash
gh pr create --base main --title "Stage 4: drive-time-aware assignment + getRecommendedSlots" --body "$(cat <<'EOF'
## Summary
- New fail-open drive-time gateway (Google Distance Matrix; fake fallback) in `@savvy/integrations`.
- `resolveRepOrigin` (last same-day appt → rep base → tenant office) + `rankSlots` (soonest + drive + clustering) in `@savvy/core`.
- New opt-in `"proximity"` assignment strategy (min drive-time, tie→least-loaded, soft tile-skill match).
- `getRecommendedSlots(leadId)` server action returning the top 2–3 drive-time-ranked slots.
- Migration: `user.base_lat/base_lng/skills`. Office + drive weights live in `tenant.settings.scheduling` jsonb.

## Config dependency
Distance Matrix needs a **server-side** `GOOGLE_MAPS_SERVER_KEY` (NOT the browser `NEXT_PUBLIC_` key). Unset ⇒ ranking degrades to straight-line distance (fail-open). Documented in `.env.example`.

## Tests
- Core unit: rep-origin fallback chain, rankSlots boundaries (soon vs drive vs null), proximity strategy tie-breaks + skill filter, scheduling config defaults.
- Integration gateway unit: fake matrix shape, null propagation, distance monotonicity.
- CI-gated DB: candidate base/skills + same-day appts loaders, proximity assignment picks nearer rep, getRecommendedSlots smoke.

## Out of scope
Rep base/skills editing UI, lane modeling on the lead (Phase B derives tile inline), SLA/3-min clock/cadence (Phase C), AI voice agent (Phase D), drive-time caching.
EOF
)"
```

- [ ] **Step 4: Watch CI**

```bash
gh pr checks --watch
```
Expected: all green. If red, **fix-forward** on `feat/stage4-drivetime-scheduling`, push, re-watch. After any merge later, check `gh run list --branch main` (a green PR can land on a red main in this repo).

- [ ] **Step 5: Report back**

Summarize the PR number, CI status, and the config dependency (`GOOGLE_MAPS_SERVER_KEY`). **Do not merge until Brett says so.**

---

## Self-Review

**Spec coverage:**
- Drive-time gateway (Google Distance Matrix, fail-open) → Task 1. ✅
- Origin resolver (last-appt → base → office) → Task 2. ✅
- `getRecommendedSlots` top 2–3 with drive-time → Task 8 (ranking math Task 3). ✅
- Proximity assignment (min drive, tie→least-loaded, soft skill) → Tasks 5, 7. ✅
- Schema `user.base_lat/base_lng/skills`; office + weights in jsonb → Task 4 + Task 3. ✅
- DB loaders (candidate base/skills, same-day appts, office) → Task 6. ✅
- Config dependency `GOOGLE_MAPS_SERVER_KEY` documented → Task 1 (`.env.example`) + Task 9 (doc). ✅
- Fail-open everywhere (matrix null → haversine/load-balance) → Tasks 1, 3 (rankSlots null path), 7 (driveMinutes null). ✅
- Out-of-scope items (UI, lanes, SLA, voice, caching) → not implemented, noted in PR body. ✅

**Placeholder scan:** No TBD/TODO. Tasks 6/7/8 DB *tests* are described (not full code) because they depend on each file's existing seed harness, which the implementer reads in-file; every *implementation* step shows complete code. ✅

**Type consistency:** `LatLng` is structurally identical across `@savvy/core` and `@savvy/integrations` (TS structural typing makes them interchangeable at call sites). `RepAppt`/same-day-appt shape `{startsAt,endsAt,lat,lng}` matches between Task 2 (resolver), Task 6 (`getRepSameDayAppts`), and Task 8 (`sameDay`). `AssignmentCandidate.driveMinutes?/skills?` (Task 5) match what Task 7 sets. `SchedulingConfig.driveTime` (Task 3) is consumed by `rankSlots` (Task 3) and Task 8. `"proximity"` added to the strategy union (Task 5) is the value branched on in Task 7. ✅
