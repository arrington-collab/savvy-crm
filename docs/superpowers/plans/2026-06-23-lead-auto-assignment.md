# Lead Auto-Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically assign a new lead to a sales rep inside the `lead-intake` Inngest workflow, using a per-tenant manager-chosen strategy (off / round-robin / least-loaded / territory / score), configurable from a settings page.

**Architecture:** A pure `pickAssignee` engine in `@savvy/core` (strategy → rep, fully unit-tested) + a tenant-scoped candidate query in `@savvy/db` + a durable `assign-lead` step in `@savvy/agents` that runs after scoring (opt-in, never overrides a manual owner) + an admin settings UI writing `tenant.settings.assignment`.

**Tech Stack:** TypeScript · Drizzle/Postgres (RLS) · Inngest · zod · Next.js App Router · Vitest + Playwright.

**Reference spec:** `docs/superpowers/specs/2026-06-23-lead-auto-assignment-design.md`

**Repo conventions:** no `.js` extensions in source; `@savvy/*` re-export via `src/index.ts`; `pnpm vitest run <path>` for one test; apps/web is Playwright-only; run a local prod build before the PR (CI never does). No migration in this feature (reuses `tenant.settings` jsonb + existing `lead.assignedUserId`).

---

## SLICE 1 — Engine (pure, `@savvy/core`)

### Task 1: Config type + schema + `parseAssignmentConfig`

**Files:**
- Create: `packages/core/src/lead-assignment.ts`
- Test: `packages/core/src/lead-assignment.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/lead-assignment.test.ts
import { describe, it, expect } from "vitest";
import { parseAssignmentConfig, assignmentConfigSchema } from "./lead-assignment";

describe("parseAssignmentConfig", () => {
  it("defaults to off for null/garbage", () => {
    expect(parseAssignmentConfig(null).strategy).toBe("off");
    expect(parseAssignmentConfig({ strategy: "nonsense" }).strategy).toBe("off");
    expect(parseAssignmentConfig(undefined).strategy).toBe("off");
  });
  it("accepts a valid territory config", () => {
    const c = parseAssignmentConfig({ strategy: "territory", territoryRules: [{ state: "AZ", city: "Mesa", userId: "u1" }] });
    expect(c.strategy).toBe("territory");
    expect(c.territoryRules?.[0]?.userId).toBe("u1");
  });
  it("accepts a valid score config", () => {
    const c = parseAssignmentConfig({ strategy: "score", scoreTiers: [{ minScore: 80, userIds: ["u1", "u2"] }] });
    expect(c.scoreTiers?.[0]?.minScore).toBe(80);
  });
});

describe("assignmentConfigSchema", () => {
  it("rejects an out-of-range minScore", () => {
    expect(assignmentConfigSchema.safeParse({ strategy: "score", scoreTiers: [{ minScore: 200, userIds: ["u1"] }] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/lead-assignment.test.ts`
Expected: FAIL (unresolved import).

- [ ] **Step 3: Implement**

```ts
// packages/core/src/lead-assignment.ts
import { z } from "./schemas";

export const ASSIGNMENT_STRATEGY = ["off", "round_robin", "least_loaded", "territory", "score"] as const;
export type AssignmentStrategy = (typeof ASSIGNMENT_STRATEGY)[number];

export type AssignmentConfig = {
  strategy: AssignmentStrategy;
  territoryRules?: { state: string; city?: string; userId: string }[];
  scoreTiers?: { minScore: number; userIds: string[] }[];
};

export const assignmentConfigSchema = z.object({
  strategy: z.enum(ASSIGNMENT_STRATEGY),
  territoryRules: z
    .array(z.object({ state: z.string().min(1).max(40), city: z.string().max(120).optional(), userId: z.string().min(1) }))
    .optional(),
  scoreTiers: z
    .array(z.object({ minScore: z.number().int().min(0).max(100), userIds: z.array(z.string().min(1)) }))
    .optional(),
});

export function parseAssignmentConfig(raw: unknown): AssignmentConfig {
  const parsed = assignmentConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : { strategy: "off" };
}
```

Add `export * from "./lead-assignment";` to `packages/core/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/lead-assignment.test.ts`
Expected: PASS (4 tests). Then `pnpm --filter @savvy/core typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/lead-assignment.ts packages/core/src/lead-assignment.test.ts packages/core/src/index.ts
git commit -m "feat(core): AssignmentConfig + parseAssignmentConfig + schema"
```

---

### Task 2: `pickAssignee` engine (all strategies)

**Files:**
- Create: `packages/core/src/pick-assignee.ts`
- Test: `packages/core/src/pick-assignee.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/pick-assignee.test.ts
import { describe, it, expect } from "vitest";
import { pickAssignee, type AssignmentCandidate } from "./pick-assignee";
import type { AssignmentConfig } from "./lead-assignment";

const c = (userId: string, openLeadCount: number, lastAssignedAt: string | null): AssignmentCandidate =>
  ({ userId, openLeadCount, lastAssignedAt });
const lead = { state: "AZ", city: "Mesa", score: 70 };

describe("pickAssignee", () => {
  const cands = [c("a", 5, "2026-01-01"), c("b", 2, "2026-02-01"), c("d", 2, "2026-01-15")];

  it("returns null when off or no candidates", () => {
    expect(pickAssignee({ strategy: "off", config: { strategy: "off" }, candidates: cands, lead })).toBeNull();
    expect(pickAssignee({ strategy: "least_loaded", config: { strategy: "least_loaded" }, candidates: [], lead })).toBeNull();
  });
  it("least_loaded picks fewest open, tie -> oldest lastAssignedAt", () => {
    // b and d both have 2 open; d assigned earlier (2026-01-15 < 2026-02-01) -> d
    expect(pickAssignee({ strategy: "least_loaded", config: { strategy: "least_loaded" }, candidates: cands, lead })).toBe("d");
  });
  it("round_robin picks the least-recently-assigned (null = never -> first)", () => {
    const withNever = [c("a", 9, "2026-03-01"), c("z", 0, null)];
    expect(pickAssignee({ strategy: "round_robin", config: { strategy: "round_robin" }, candidates: withNever, lead })).toBe("z");
  });
  it("territory: city+state rule beats state-only; falls back to least_loaded on no match", () => {
    const config: AssignmentConfig = { strategy: "territory", territoryRules: [
      { state: "AZ", userId: "a" },
      { state: "AZ", city: "Mesa", userId: "b" },
    ] };
    expect(pickAssignee({ strategy: "territory", config, candidates: cands, lead })).toBe("b"); // city match wins
    const noMatch = pickAssignee({ strategy: "territory", config, candidates: cands, lead: { state: "TX", city: "Austin", score: 50 } });
    expect(noMatch).toBe("d"); // fallback least_loaded
  });
  it("score: highest tier the lead meets; within tier least_loaded; fallback when no tier", () => {
    const config: AssignmentConfig = { strategy: "score", scoreTiers: [
      { minScore: 80, userIds: ["a"] },
      { minScore: 50, userIds: ["b", "d"] },
    ] };
    expect(pickAssignee({ strategy: "score", config, candidates: cands, lead })).toBe("d"); // 70 -> tier 50, least-loaded of b/d
    const hot = pickAssignee({ strategy: "score", config, candidates: cands, lead: { ...lead, score: 95 } });
    expect(hot).toBe("a"); // tier 80
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/pick-assignee.test.ts`
Expected: FAIL (unresolved import).

- [ ] **Step 3: Implement**

```ts
// packages/core/src/pick-assignee.ts
import type { AssignmentConfig } from "./lead-assignment";

export type AssignmentCandidate = { userId: string; openLeadCount: number; lastAssignedAt: string | null };

const ts = (s: string | null): number => (s ? Date.parse(s) : 0);

/** fewest open leads; tie -> least recently assigned (null = oldest). */
function leastLoaded(cands: AssignmentCandidate[]): string | null {
  if (cands.length === 0) return null;
  return [...cands].sort((a, b) => a.openLeadCount - b.openLeadCount || ts(a.lastAssignedAt) - ts(b.lastAssignedAt))[0]!.userId;
}

/** least recently assigned (null = never -> first). */
function roundRobin(cands: AssignmentCandidate[]): string | null {
  if (cands.length === 0) return null;
  return [...cands].sort((a, b) => ts(a.lastAssignedAt) - ts(b.lastAssignedAt))[0]!.userId;
}

export function pickAssignee(opts: {
  strategy: AssignmentConfig["strategy"];
  config: AssignmentConfig;
  candidates: AssignmentCandidate[];
  lead: { state: string | null; city: string | null; score: number | null };
}): string | null {
  const { strategy, config, candidates, lead } = opts;
  if (strategy === "off" || candidates.length === 0) return null;

  const byId = new Map(candidates.map((c) => [c.userId, c]));
  const inPool = (ids: string[]): AssignmentCandidate[] =>
    ids.map((id) => byId.get(id)).filter((c): c is AssignmentCandidate => Boolean(c));

  if (strategy === "round_robin") return roundRobin(candidates);
  if (strategy === "least_loaded") return leastLoaded(candidates);

  if (strategy === "territory") {
    const matches = (config.territoryRules ?? []).filter(
      (r) => r.state === lead.state && (r.city == null || r.city === lead.city),
    );
    const cityMatches = matches.filter((r) => r.city != null && r.city === lead.city);
    const chosen = cityMatches.length > 0 ? cityMatches : matches; // most-specific first
    return leastLoaded(inPool(chosen.map((r) => r.userId))) ?? leastLoaded(candidates);
  }

  if (strategy === "score") {
    const tiers = (config.scoreTiers ?? [])
      .filter((t) => (lead.score ?? 0) >= t.minScore)
      .sort((a, b) => b.minScore - a.minScore);
    const top = tiers[0];
    const matched = top ? inPool(top.userIds) : [];
    return leastLoaded(matched) ?? leastLoaded(candidates);
  }
  return null;
}
```

Add `export * from "./pick-assignee";` to `packages/core/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/pick-assignee.test.ts`
Expected: PASS (5 tests). Then `pnpm --filter @savvy/core typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pick-assignee.ts packages/core/src/pick-assignee.test.ts packages/core/src/index.ts
git commit -m "feat(core): pickAssignee engine (round-robin/least-loaded/territory/score)"
```

---

## SLICE 2 — Wiring (`@savvy/db` + `@savvy/agents`)

### Task 3: `getAssignmentCandidates` + settings store

**Files:**
- Create: `packages/db/src/lifecycle/assignment.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/tests/assignment.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// packages/db/tests/assignment.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { adminDb, withTenant, tenant, user, customer, lead, eq } from "../src/index";
import { getAssignmentCandidates, getAssignmentSettings, saveAssignmentConfig } from "../src/lifecycle/assignment";

describe("assignment db", () => {
  let tenantId: string, repA: string, repB: string;
  beforeAll(async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "T", clerkOrgId: `org_${Date.now()}`, settings: { onboarding: { done: true } } }).returning();
    tenantId = t!.id;
    await withTenant(tenantId, async (tx) => {
      const [a] = await tx.insert(user).values({ tenantId, name: "A", email: `a-${Date.now()}@x.com`, role: "rep" }).returning();
      const [b] = await tx.insert(user).values({ tenantId, name: "B", email: `b-${Date.now()}@x.com`, role: "rep" }).returning();
      const [office] = await tx.insert(user).values({ tenantId, name: "O", email: `o-${Date.now()}@x.com`, role: "office" }).returning();
      const [deact] = await tx.insert(user).values({ tenantId, name: "D", email: `d-${Date.now()}@x.com`, role: "rep", deactivatedAt: new Date() }).returning();
      repA = a!.id; repB = b!.id;
      const [c] = await tx.insert(customer).values({ tenantId, name: "Cust" }).returning();
      // repA: 2 open leads; repB: 0
      await tx.insert(lead).values({ tenantId, customerId: c!.id, status: "new", assignedUserId: a!.id });
      await tx.insert(lead).values({ tenantId, customerId: c!.id, status: "contacted", assignedUserId: a!.id });
      await tx.insert(lead).values({ tenantId, customerId: c!.id, status: "won", assignedUserId: a!.id }); // not open
      void office; void deact;
    });
  });

  it("returns active sales reps with open counts; excludes office + deactivated", async () => {
    const cands = await withTenant(tenantId, (tx) => getAssignmentCandidates(tx, tenantId));
    const ids = cands.map((c) => c.userId);
    expect(ids).toContain(repA);
    expect(ids).toContain(repB);
    expect(cands.length).toBe(2); // office + deactivated excluded
    expect(cands.find((c) => c.userId === repA)!.openLeadCount).toBe(2);
    expect(cands.find((c) => c.userId === repB)!.openLeadCount).toBe(0);
  });

  it("saves + reads assignment config, preserving siblings", async () => {
    await saveAssignmentConfig(tenantId, { strategy: "least_loaded" });
    expect(await getAssignmentSettings(tenantId)).toEqual({ strategy: "least_loaded" });
    const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
    expect((t!.settings as any).onboarding.done).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/db/tests/assignment.test.ts`
Expected: FAIL (unresolved import). Match the `.js`-extension import style of sibling tests in `packages/db/tests/` if the import resolution requires it (check `lead-sources.test.ts`).

- [ ] **Step 3: Implement**

```ts
// packages/db/src/lifecycle/assignment.ts
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { adminDb } from "../admin-client";
import { tenant } from "../schema/tenancy";
import { user, lead } from "../schema/index";

type Tx = Parameters<Parameters<typeof import("../client").db.transaction>[0]>[0];

export type DbAssignmentCandidate = { userId: string; role: string; openLeadCount: number; lastAssignedAt: string | null };

const SALES_ROLES = ["owner", "admin", "rep"] as const;

export async function getAssignmentCandidates(tx: Tx, tenantId: string): Promise<DbAssignmentCandidate[]> {
  const users = await tx
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(and(eq(user.tenantId, tenantId), isNull(user.deactivatedAt), inArray(user.role, [...SALES_ROLES])));

  const stats = await tx
    .select({
      userId: lead.assignedUserId,
      openCount: sql<number>`count(*) filter (where ${lead.status} not in ('won','lost'))`.mapWith(Number),
      lastAssignedAt: sql<string | null>`max(${lead.createdAt})`,
    })
    .from(lead)
    .where(eq(lead.tenantId, tenantId))
    .groupBy(lead.assignedUserId);

  const statById = new Map(stats.filter((s) => s.userId).map((s) => [s.userId as string, s]));
  return users.map((u) => ({
    userId: u.id,
    role: u.role,
    openLeadCount: statById.get(u.id)?.openCount ?? 0,
    lastAssignedAt: statById.get(u.id)?.lastAssignedAt ?? null,
  }));
}

export async function getAssignmentSettings(tenantId: string): Promise<unknown> {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  return (t?.settings as { assignment?: unknown } | null)?.assignment ?? null;
}

export async function saveAssignmentConfig(tenantId: string, assignment: unknown): Promise<void> {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const settings = (t?.settings ?? {}) as Record<string, unknown>;
  await adminDb.update(tenant).set({ settings: { ...settings, assignment } }).where(eq(tenant.id, tenantId));
}
```

Add to `packages/db/src/index.ts`:
```ts
export { getAssignmentCandidates, getAssignmentSettings, saveAssignmentConfig, type DbAssignmentCandidate } from "./lifecycle/assignment";
```
(Confirm the `Tx` type helper + `adminDb`/`tenant`/`user`/`lead` import paths match a sibling lifecycle file like `leads.ts`/`lead-sources.ts`; adjust if the repo exposes them differently.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/db/tests/assignment.test.ts`
Expected: PASS (2 tests). Then `pnpm --filter @savvy/db typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/assignment.ts packages/db/src/index.ts packages/db/tests/assignment.test.ts
git commit -m "feat(db): getAssignmentCandidates + assignment settings store"
```

---

### Task 4: `runLeadAssignment` + `assign-lead` step in `lead-intake`

**Files:**
- Modify: `packages/agents/src/functions/lead-intake.ts`
- Test: `packages/agents/src/functions/lead-assignment.test.ts` (new)

- [ ] **Step 1: Write the failing integration test**

```ts
// packages/agents/src/functions/lead-assignment.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { adminDb, withTenant, tenant, user, customer, lead, eq } from "@savvy/db";
import { saveAssignmentConfig } from "@savvy/db";
import { runLeadAssignment } from "./lead-intake";

describe("runLeadAssignment", () => {
  let tenantId: string, repA: string, repB: string, leadId: string;
  beforeAll(async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "T", clerkOrgId: `org_${Date.now()}` }).returning();
    tenantId = t!.id;
    await withTenant(tenantId, async (tx) => {
      const [a] = await tx.insert(user).values({ tenantId, name: "A", email: `a-${Date.now()}@x.com`, role: "rep" }).returning();
      const [b] = await tx.insert(user).values({ tenantId, name: "B", email: `b-${Date.now()}@x.com`, role: "rep" }).returning();
      repA = a!.id; repB = b!.id;
      const [c] = await tx.insert(customer).values({ tenantId, name: "Cust" }).returning();
      // repA already has an open lead, repB has none -> least_loaded should pick repB
      await tx.insert(lead).values({ tenantId, customerId: c!.id, status: "new", assignedUserId: a!.id });
      const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, status: "contacted", score: 60 }).returning();
      leadId = l!.id;
    });
  });

  it("assigns the unassigned lead to the least-loaded rep", async () => {
    await saveAssignmentConfig(tenantId, { strategy: "least_loaded" });
    const r = await runLeadAssignment(tenantId, leadId, { state: "AZ", city: "Mesa" });
    expect(r.assigned).toBe(repB);
    const [l] = await withTenant(tenantId, (tx) => tx.select({ a: lead.assignedUserId }).from(lead).where(eq(lead.id, leadId)));
    expect(l!.a).toBe(repB);
  });
  it("skips when strategy is off", async () => {
    await saveAssignmentConfig(tenantId, { strategy: "off" });
    // seed a fresh unassigned lead
    const fresh = await withTenant(tenantId, async (tx) => {
      const [c] = await tx.insert(customer).values({ tenantId, name: "C2" }).returning();
      const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, status: "new" }).returning();
      return l!.id;
    });
    const r = await runLeadAssignment(tenantId, fresh, { state: "AZ", city: "Mesa" });
    expect(r.assigned).toBeNull();
    expect(r.reason).toBe("off");
  });
  it("never overrides an already-assigned lead", async () => {
    await saveAssignmentConfig(tenantId, { strategy: "least_loaded" });
    const r = await runLeadAssignment(tenantId, leadId, { state: "AZ", city: "Mesa" }); // leadId already assigned to repB
    expect(r.assigned).toBeNull();
    expect(r.reason).toBe("already-assigned");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/agents/src/functions/lead-assignment.test.ts`
Expected: FAIL (`runLeadAssignment` not exported).

- [ ] **Step 3: Implement `runLeadAssignment` + wire the step**

In `packages/agents/src/functions/lead-intake.ts`, add imports (merge with existing `@savvy/db`/`@savvy/core` imports — do NOT duplicate):
```ts
import { getAssignmentCandidates, getAssignmentSettings, setLeadOwner } from "@savvy/db";
import { parseAssignmentConfig, pickAssignee } from "@savvy/core";
```
Add the exported helper near `enrichProperty`:
```ts
export async function runLeadAssignment(
  tenantId: string,
  leadId: string,
  leadCtx: { state: string | null; city: string | null },
): Promise<{ assigned: string | null; reason: string }> {
  const config = parseAssignmentConfig(await getAssignmentSettings(tenantId));
  if (config.strategy === "off") return { assigned: null, reason: "off" };
  return withTenant(tenantId, async (tx) => {
    const [l] = await tx.select({ assignedUserId: lead.assignedUserId, score: lead.score }).from(lead).where(eq(lead.id, leadId));
    if (!l) return { assigned: null, reason: "no-lead" };
    if (l.assignedUserId) return { assigned: null, reason: "already-assigned" };
    const candidates = await getAssignmentCandidates(tx, tenantId);
    const userId = pickAssignee({
      strategy: config.strategy, config, candidates,
      lead: { state: leadCtx.state, city: leadCtx.city, score: l.score },
    });
    if (!userId) return { assigned: null, reason: "no-candidate" };
    await setLeadOwner(tx, { tenantId, leadId, userId });
    return { assigned: userId, reason: "assigned" };
  });
}
```
Then add the durable step in the `leadIntake` function body, AFTER `ai-qualify` and BEFORE `send-sms`:
```ts
await step.run("assign-lead", async () => {
  const r = await runLeadAssignment(tenantId, leadId, { state: ctx.state, city: ctx.city ?? null });
  await recordAgentRun({
    tenantId, agent: "orchestrator", taskKey: "lead.assign",
    status: r.assigned ? "ok" : "skipped", error: r.assigned ? null : r.reason,
  });
  return r;
});
```
IMPORTANT: the `load-lead` step must return `city` on `ctx`. It already selects from `property`; add `city: p.city ?? null` to its returned object (and `city: null` in the no-property branch). Confirm `agent: "orchestrator"` is a valid `Agent` enum value (it is — one of the five agents; `resolveAgent` maps orchestrator→SAGE). `recordAgentRun` opens its own `withTenant`, so calling it inside the step is fine.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/agents/src/functions/lead-assignment.test.ts` and the existing `pnpm vitest run packages/agents/src/functions/lead-intake.test.ts`.
Expected: both PASS. Then `pnpm --filter @savvy/agents typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/functions/lead-intake.ts packages/agents/src/functions/lead-assignment.test.ts
git commit -m "feat(agents): assign-lead step (opt-in, never overrides manual owner)"
```

---

## SLICE 3 — Settings UI (`apps/web`)

### Task 5: Server action + reps query

**Files:**
- Create: `apps/web/src/lib/assignment-actions.ts`
- Create: `apps/web/src/lib/assignment-queries.ts`

- [ ] **Step 1: Implement the reps query** — create `apps/web/src/lib/assignment-queries.ts` with exactly this:

```ts
import "server-only";
import { withTenant, user, eq, and, isNull, inArray, getAssignmentSettings } from "@savvy/db";
import { parseAssignmentConfig, type AssignmentConfig } from "@savvy/core";

export type RepOption = { id: string; name: string };

export async function getSalesReps(tenantId: string): Promise<RepOption[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({ id: user.id, name: user.name })
      .from(user)
      .where(and(eq(user.tenantId, tenantId), isNull(user.deactivatedAt), inArray(user.role, ["owner", "admin", "rep"]))),
  );
}

export async function getAssignmentConfig(tenantId: string): Promise<AssignmentConfig> {
  return parseAssignmentConfig(await getAssignmentSettings(tenantId));
}
```
(Confirm `eq`/`and`/`isNull`/`inArray` are re-exported from `@savvy/db` — they are, used across lifecycle files. If any isn't, import it from `drizzle-orm` instead.)

- [ ] **Step 2: Implement the action** (`apps/web/src/lib/assignment-actions.ts`)

```ts
"use server";
import { assignmentConfigSchema } from "@savvy/core";
import { saveAssignmentConfig } from "@savvy/db";
import { getTenantId } from "./tenant";
import { isOrgAdmin } from "./authz";

export async function saveAssignmentAction(
  raw: unknown,
): Promise<{ ok: true } | { error: string }> {
  if (!(await isOrgAdmin())) return { error: "Not authorized" };
  const parsed = assignmentConfigSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid config" };
  try {
    const tenantId = await getTenantId();
    await saveAssignmentConfig(tenantId, parsed.data);
    return { ok: true };
  } catch {
    return { error: "Could not save assignment settings" };
  }
}
```
(Confirm `isOrgAdmin` is exported from `apps/web/src/lib/authz.ts` — it is, from prior work; it returns true in TEST_MODE.)

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @savvy/web typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/assignment-actions.ts apps/web/src/lib/assignment-queries.ts
git commit -m "feat(web): assignment settings action + reps query"
```

---

### Task 6: `LeadAssignmentSettings` component + `/settings/assignment` page + hub link

**Files:**
- Create: `apps/web/src/components/LeadAssignmentSettings.tsx`
- Create: `apps/web/src/app/(app)/settings/assignment/page.tsx`
- Modify: `apps/web/src/app/(app)/settings/page.tsx` (add hub link)

- [ ] **Step 1: Build the client component** (`apps/web/src/components/LeadAssignmentSettings.tsx`)

```tsx
"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import type { AssignmentConfig } from "@savvy/core";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveAssignmentAction } from "@/lib/assignment-actions";

type Rep = { id: string; name: string };
const STRATEGIES = [
  { v: "off", label: "Off (assign manually)" },
  { v: "round_robin", label: "Round-robin" },
  { v: "least_loaded", label: "Least-loaded" },
  { v: "territory", label: "By territory (state/city)" },
  { v: "score", label: "By lead score" },
];

export function LeadAssignmentSettings({ reps, initial }: { reps: Rep[]; initial: AssignmentConfig }) {
  const [strategy, setStrategy] = useState<AssignmentConfig["strategy"]>(initial.strategy);
  const [territory, setTerritory] = useState(initial.territoryRules ?? []);
  const [tiers, setTiers] = useState(initial.scoreTiers ?? []);
  const [pending, start] = useTransition();
  const repName = (id: string) => reps.find((r) => r.id === id)?.name ?? id;

  function save() {
    const config: AssignmentConfig = { strategy,
      ...(strategy === "territory" ? { territoryRules: territory } : {}),
      ...(strategy === "score" ? { scoreTiers: tiers } : {}) };
    start(async () => {
      const res = await saveAssignmentAction(config);
      toast[("error" in res) ? "error" : "success"](("error" in res) ? res.error : "Saved");
    });
  }

  return (
    <Card className="max-w-2xl p-6 space-y-5" data-testid="assignment-settings">
      <div className="space-y-1.5">
        <Label htmlFor="strategy">Assignment strategy</Label>
        <select id="strategy" data-testid="assignment-strategy" value={strategy}
                onChange={(e) => setStrategy(e.target.value as AssignmentConfig["strategy"])}
                className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm">
          {STRATEGIES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
        </select>
      </div>

      {strategy === "territory" && (
        <div className="space-y-2" data-testid="territory-editor">
          <Label>Territory rules (most specific wins)</Label>
          {territory.map((r, i) => (
            <div key={i} className="flex gap-2">
              <Input placeholder="State (AZ)" value={r.state}
                     onChange={(e) => setTerritory(territory.map((x, j) => j === i ? { ...x, state: e.target.value } : x))} />
              <Input placeholder="City (optional)" value={r.city ?? ""}
                     onChange={(e) => setTerritory(territory.map((x, j) => j === i ? { ...x, city: e.target.value || undefined } : x))} />
              <select value={r.userId} data-testid={`territory-rep-${i}`}
                      onChange={(e) => setTerritory(territory.map((x, j) => j === i ? { ...x, userId: e.target.value } : x))}
                      className="h-9 rounded-md border bg-transparent px-2 text-sm">
                <option value="">— rep —</option>
                {reps.map((rep) => <option key={rep.id} value={rep.id}>{rep.name}</option>)}
              </select>
              <Button type="button" variant="outline" onClick={() => setTerritory(territory.filter((_, j) => j !== i))}>✕</Button>
            </div>
          ))}
          <Button type="button" variant="outline" data-testid="add-territory"
                  onClick={() => setTerritory([...territory, { state: "", userId: "" }])}>+ Add rule</Button>
        </div>
      )}

      {strategy === "score" && (
        <div className="space-y-2" data-testid="score-editor">
          <Label>Score tiers (highest min that the lead meets wins)</Label>
          {tiers.map((t, i) => (
            <div key={i} className="flex gap-2 items-center">
              <Input type="number" placeholder="Min score" value={t.minScore}
                     onChange={(e) => setTiers(tiers.map((x, j) => j === i ? { ...x, minScore: Number(e.target.value) } : x))} className="w-28" />
              <span className="text-sm text-muted-foreground flex-1">
                {t.userIds.length ? t.userIds.map(repName).join(", ") : "no reps"}
              </span>
              <select data-testid={`tier-add-rep-${i}`} value=""
                      onChange={(e) => { const id = e.target.value; if (id && !t.userIds.includes(id)) setTiers(tiers.map((x, j) => j === i ? { ...x, userIds: [...x.userIds, id] } : x)); }}
                      className="h-9 rounded-md border bg-transparent px-2 text-sm">
                <option value="">+ rep</option>
                {reps.map((rep) => <option key={rep.id} value={rep.id}>{rep.name}</option>)}
              </select>
              <Button type="button" variant="outline" onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>✕</Button>
            </div>
          ))}
          <Button type="button" variant="outline" data-testid="add-tier"
                  onClick={() => setTiers([...tiers, { minScore: 0, userIds: [] }])}>+ Add tier</Button>
        </div>
      )}

      <Button type="button" disabled={pending} data-testid="save-assignment" onClick={save}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </Card>
  );
}
```

- [ ] **Step 2: Build the page** (`apps/web/src/app/(app)/settings/assignment/page.tsx`)

```tsx
import { getTenantId } from "@/lib/tenant";
import { getSalesReps, getAssignmentConfig } from "@/lib/assignment-queries";
import { LeadAssignmentSettings } from "@/components/LeadAssignmentSettings";
import { PageHeader } from "@/components/cockpit/PageHeader";

export const dynamic = "force-dynamic";

export default async function AssignmentSettingsPage() {
  const tenantId = await getTenantId();
  const [reps, initial] = await Promise.all([getSalesReps(tenantId), getAssignmentConfig(tenantId)]);
  return (
    <div className="space-y-4">
      <PageHeader title="Lead Assignment" subtitle="Choose how new leads are routed to reps." />
      <LeadAssignmentSettings reps={reps} initial={initial} />
    </div>
  );
}
```
(Confirm `PageHeader` exists at `@/components/cockpit/PageHeader` with a `title`/`subtitle` prop — it was added in the cockpit work; if its prop names differ, match them, or render a plain `<h1>` instead.)

- [ ] **Step 3: Add the settings-hub link.** In `apps/web/src/app/(app)/settings/page.tsx`, add to the `SECTIONS` array:
```ts
{ href: "/settings/assignment", label: "Lead Assignment", desc: "Auto-route new leads to reps by round-robin, load, territory, or score." },
```

- [ ] **Step 4: Typecheck + lint + local prod build**

Run: `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint && pnpm --filter @savvy/web build`
Expected: clean; the new route compiles as `ƒ` dynamic.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/LeadAssignmentSettings.tsx "apps/web/src/app/(app)/settings/assignment/page.tsx" "apps/web/src/app/(app)/settings/page.tsx"
git commit -m "feat(web): /settings/assignment page + strategy/territory/score editors"
```

---

### Task 7: e2e for the settings page

**Files:**
- Create: `apps/web/tests/e2e/assignment-settings.spec.ts`

- [ ] **Step 1: Write the e2e** (seeds two reps for the tenant, then drives the UI; matches the seed pattern in `leads.spec.ts` — tenant id from `/tmp/savvy-e2e-tenant.json`)

```ts
// apps/web/tests/e2e/assignment-settings.spec.ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, user } from "@savvy/db";

const tenantId = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")).tenantId;

test.beforeAll(async () => {
  await withTenant(tenantId, async (tx) => {
    await tx.insert(user).values({ tenantId, name: "Assign Rep One", email: `ar1-${Date.now()}@x.com`, role: "rep" });
  });
});

test("manager sets least-loaded strategy and it persists", async ({ page }) => {
  await page.goto("/settings/assignment");
  await expect(page.getByTestId("assignment-settings")).toBeVisible();
  await page.getByTestId("assignment-strategy").selectOption("least_loaded");
  await page.getByTestId("save-assignment").click();
  await expect(page.getByText("Saved")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("assignment-strategy")).toHaveValue("least_loaded");
});

test("switching to territory reveals the rule editor", async ({ page }) => {
  await page.goto("/settings/assignment");
  await page.getByTestId("assignment-strategy").selectOption("territory");
  await expect(page.getByTestId("territory-editor")).toBeVisible();
  await page.getByTestId("add-territory").click();
  await expect(page.getByTestId("territory-rep-0")).toBeVisible();
});
```
> Confirm the e2e import style for `@savvy/db` + reading the tenant file matches `leads.spec.ts`/`lead-enrichment.spec.ts` (they read `/tmp/savvy-e2e-tenant.json`); adapt if the helper differs.

- [ ] **Step 2: Run it**

Run: `pnpm --filter @savvy/web exec playwright test tests/e2e/assignment-settings.spec.ts`
Expected: PASS (TEST_MODE bypasses the admin gate; `force-dynamic` page reads fresh on reload).

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/e2e/assignment-settings.spec.ts
git commit -m "test(e2e): assignment settings page persists strategy + reveals editors"
```

---

## Final verification (before PR)

- [ ] `pnpm typecheck && pnpm lint && pnpm test`
- [ ] `pnpm --filter @savvy/web build` (CI never runs this)
- [ ] `pnpm --filter @savvy/web exec playwright test tests/e2e/assignment-settings.spec.ts`
- [ ] Tenant-isolation suite green (covered by `pnpm test`).
- [ ] PR against `main`: `gh pr create --base main`.

## Self-review notes (spec coverage)

- Config in `tenant.settings.assignment` + defaulting → Task 1 (`parseAssignmentConfig`). All 4 strategies + fallbacks → Task 2 (`pickAssignee`). Candidate pool (active owner/admin/rep, exclude crew/office/deactivated) + openLeadCount/lastAssignedAt → Task 3. Opt-in, never-override, after-scoring, orchestrator agent_run → Task 4 (`runLeadAssignment` + `assign-lead` step). Admin-gated save + reps query → Task 5. Strategy dropdown + territory/score editors + hub link → Task 6. e2e → Task 7. No migration (reuses jsonb + `lead.assignedUserId`). Tenant isolation: candidate/owner writes via `withTenant`; settings via `adminDb` filtered by `tenantId`. Durable/idempotent: assignment inside `step.run`, re-reads `assignedUserId` so retries don't reassign.
