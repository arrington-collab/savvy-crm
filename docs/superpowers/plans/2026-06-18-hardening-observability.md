# Hardening & Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four remaining production-readiness gaps — a forgeable fallback secret, no error visibility, no abuse protection on public routes, and no structured logs — each disabled-by-absence so dev/e2e/TEST_MODE stay green.

**Architecture:** Pure logic lands in `@savvy/core` (unit-tested with vitest): `requireSecret`, `rateLimitKey` + a limit map, and `formatLog`. The `apps/web` layer stays thin IO wrappers (Redis client, `console`, Sentry SDK) that import those pure pieces. Every new mechanism no-ops when its env is unset: Sentry without `SENTRY_DSN`, rate-limiting without the Upstash env vars. No schema migration.

**Tech Stack:** TypeScript, Next.js 16 (App Router, Turbopack), `@sentry/nextjs`, `@upstash/ratelimit` + `@upstash/redis`, vitest, pnpm workspaces.

---

## Conventions for every task

- **Repo root:** `~/Sites/savvy-crm`. **Branch:** `feat/hardening-observability` (already checked out, off `origin/main`).
- **Gate command** (run from repo root before any commit that touches testable code):
  ```bash
  export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
  pnpm typecheck && pnpm lint && pnpm test
  ```
  Baseline on this branch: typecheck 7/7, lint 0 errors, **239 unit tests**. Numbers only go up.
- **Single-instance imports** (non-negotiable in this repo): inside `apps/web` and `packages/*`, import `z` from `@savvy/core`, never from `zod`. Import drizzle operators from `@savvy/db`, never `drizzle-orm`. Cross-package imports use the package root (`@savvy/core`), never deep `/src/...` paths.
- **No `.js` extensions** on internal relative imports in SOURCE files (Turbopack can't resolve them). `*.test.ts` files DO use `.js` on relative imports (vitest/tsx resolve them) — match the sibling test files you see in `packages/core/src/`. If a reviewer tells you to add/remove a `.js` extension, verify against an existing sibling file before obeying — this advice has been wrong twice in this repo.
- **apps/web is Playwright-only** — it has NO vitest. Do not add a vitest config or `*.test.ts` to `apps/web`. All unit-tested logic goes in `@savvy/core`.
- **Watch route-group parens:** files under `app/(app)/` and `app/(crew)/` contain literal `(` `)`. When you `git add` them, quote the path or use `git add -A` — a mangled `\(app\)` directory is a known subagent failure here. Run `git status` after file ops in route groups and confirm no stray escaped dirs.

---

## File Structure

**New files:**
- `packages/core/src/secrets.ts` + `secrets.test.ts` — `requireSecret` (Part 1).
- `packages/core/src/rate-limit-key.ts` + `rate-limit-key.test.ts` — `rateLimitKey` + `RATE_LIMITS` map (Part 3, pure).
- `packages/core/src/log-format.ts` + `log-format.test.ts` — `formatLog` (Part 4, pure).
- `apps/web/src/lib/rate-limit.ts` — Upstash IO wrapper, `checkRateLimit` (Part 3).
- `apps/web/src/lib/log.ts` — `console`/`formatLog` IO wrapper, `log.info/warn/error` (Part 4).
- `apps/web/instrumentation.ts`, `apps/web/instrumentation-client.ts`, `apps/web/sentry.server.config.ts`, `apps/web/sentry.edge.config.ts`, `apps/web/src/app/global-error.tsx` — Sentry (Part 2).

**Modified files:**
- `packages/core/src/index.ts` — export the three new modules.
- 6 fallback sites + `apps/web/src/lib/crew-session.ts` (Part 1).
- `apps/web/src/app/api/leads/route.ts`, `apps/web/src/lib/crew-actions.ts` (Parts 3 + 4).
- `apps/web/src/app/api/stripe/webhook/route.ts`, `.../docuseal/webhook/route.ts`, `.../companycam/webhook/route.ts`, `.../clerk/webhook/route.ts`, `.../twilio/*` (Part 4 logging — light touch).
- `apps/web/next.config.ts` (Part 2).
- `.env.example` (Part 5 env docs).

---

## Task 1: `requireSecret` helper (`@savvy/core`)

**Files:**
- Create: `packages/core/src/secrets.ts`
- Test: `packages/core/src/secrets.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/secrets.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { requireSecret } from "./secrets.js";

const KEY = "TEST_SECRET_XYZ";

afterEach(() => {
  delete process.env[KEY];
  delete process.env.NODE_ENV;
});

describe("requireSecret", () => {
  it("returns the env value when set", () => {
    process.env[KEY] = "real-value";
    expect(requireSecret(KEY)).toBe("real-value");
  });

  it("returns the env value when set even in production", () => {
    process.env.NODE_ENV = "production";
    process.env[KEY] = "real-value";
    expect(requireSecret(KEY, { devFallback: "dev" })).toBe("real-value");
  });

  it("throws when unset in production", () => {
    process.env.NODE_ENV = "production";
    expect(() => requireSecret(KEY)).toThrow("Missing required secret: TEST_SECRET_XYZ");
  });

  it("returns the explicit dev fallback when unset outside production", () => {
    process.env.NODE_ENV = "development";
    expect(requireSecret(KEY, { devFallback: "dev-test" })).toBe("dev-test");
  });

  it("returns a derived default fallback when unset and no devFallback given", () => {
    process.env.NODE_ENV = "development";
    expect(requireSecret(KEY)).toBe("dev-test_secret_xyz");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core test secrets`
Expected: FAIL — `requireSecret` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/secrets.ts`:

```ts
/**
 * Resolve a required secret from the environment.
 * - Returns process.env[name] when set.
 * - Throws in production when unset (never silently fall back to a public constant).
 * - Outside production, returns opts.devFallback, or a derived "dev-<name>" placeholder.
 *
 * Lives in @savvy/core because it is the only package both apps/web and
 * packages/agents import, and reading process.env here keeps it trivially testable.
 */
export function requireSecret(name: string, opts?: { devFallback?: string }): string {
  const value = process.env[name];
  if (value) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`Missing required secret: ${name}`);
  }
  return opts?.devFallback ?? `dev-${name.toLowerCase()}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/core test secrets`
Expected: PASS (5 tests).

- [ ] **Step 5: Export from the core index**

Modify `packages/core/src/index.ts` — add after the existing `export * from "./clerk-role";` line:

```ts
export * from "./secrets";
```

- [ ] **Step 6: Run the gate**

Run (from repo root):
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm --filter @savvy/core test
```
Expected: typecheck PASS, lint 0 errors, core tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/secrets.ts packages/core/src/secrets.test.ts packages/core/src/index.ts
git commit -m "feat(core): requireSecret helper (fail-closed in prod)"
```

---

## Task 2: Seal the 6 `UNSUBSCRIBE_SECRET` fallback sites + refactor `crew-session`

No new tests — this is a mechanical swap of an existing fallback for the tested helper from Task 1. The gate (typecheck/lint) is the verification; behavior in dev/e2e is unchanged (same `"dev-unsubscribe-secret"` fallback string), and prod now fails closed.

**Files (all Modify):**
- `apps/web/src/app/api/unsubscribe/[token]/route.ts`
- `apps/web/src/app/api/stripe/connect/start/route.ts`
- `apps/web/src/app/api/stripe/connect/callback/route.ts`
- `apps/web/src/lib/booking-action.ts`
- `packages/agents/src/functions/lead-intake.ts`
- `packages/agents/src/functions/appointment-reminders.ts`
- `apps/web/src/lib/crew-session.ts`

- [ ] **Step 1: Replace the unsubscribe route**

In `apps/web/src/app/api/unsubscribe/[token]/route.ts`, add to the existing imports from `@savvy/core` (find the existing import line and add `requireSecret` to it; if there is no `@savvy/core` import yet, add `import { requireSecret } from "@savvy/core";`), then replace line ~11:

```ts
// before:
const secret = process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret";
// after:
const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
```

- [ ] **Step 2: Replace the Stripe connect start route**

In `apps/web/src/app/api/stripe/connect/start/route.ts`, ensure `requireSecret` is imported from `@savvy/core`, then replace line ~12:

```ts
const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
```

- [ ] **Step 3: Replace the Stripe connect callback route**

In `apps/web/src/app/api/stripe/connect/callback/route.ts`, ensure `requireSecret` is imported from `@savvy/core`, then replace line ~14:

```ts
const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
```

- [ ] **Step 4: Replace booking-action**

In `apps/web/src/lib/booking-action.ts`, ensure `requireSecret` is imported from `@savvy/core`, then replace line ~9 (note it is a thunk — keep it a thunk so it reads env lazily):

```ts
// before:
const SECRET = () => process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret";
// after:
const SECRET = () => requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
```

- [ ] **Step 5: Replace lead-intake**

In `packages/agents/src/functions/lead-intake.ts`, ensure `requireSecret` is imported from `@savvy/core`, then replace line ~64:

```ts
const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
```

- [ ] **Step 6: Replace appointment-reminders**

In `packages/agents/src/functions/appointment-reminders.ts`, ensure `requireSecret` is imported from `@savvy/core`, then replace line ~44:

```ts
const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
```

- [ ] **Step 7: Refactor crew-session to use the helper (no behavior change)**

In `apps/web/src/lib/crew-session.ts`:
- Add `requireSecret` to the existing `@savvy/core` import (line 3 currently imports `signPayloadToken, verifyPayloadToken`):
  ```ts
  import { signPayloadToken, verifyPayloadToken, requireSecret } from "@savvy/core";
  ```
- Replace the `SECRET` thunk (lines 7–12):
  ```ts
  const SECRET = () => requireSecret("CREW_SESSION_SECRET", { devFallback: "dev-crew-secret" });
  ```

This preserves the existing behavior: prod throws when unset, dev returns `"dev-crew-secret"`.

- [ ] **Step 8: Run the gate**

Run (from repo root):
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Expected: typecheck 7/7, lint 0 errors, **239 tests** still green (no new tests yet; no behavior change in non-prod).

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/app/api/unsubscribe apps/web/src/app/api/stripe/connect apps/web/src/lib/booking-action.ts apps/web/src/lib/crew-session.ts packages/agents/src/functions/lead-intake.ts packages/agents/src/functions/appointment-reminders.ts
git commit -m "fix(security): fail-closed secret resolution at all UNSUBSCRIBE_SECRET sites + crew-session"
```

---

## Task 3: `rateLimitKey` + limit map (`@savvy/core`)

**Files:**
- Create: `packages/core/src/rate-limit-key.ts`
- Test: `packages/core/src/rate-limit-key.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/rate-limit-key.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rateLimitKey, RATE_LIMITS, type RateBucket } from "./rate-limit-key.js";

describe("rateLimitKey", () => {
  it("joins bucket and id with a colon", () => {
    expect(rateLimitKey("leads", "acme:1.2.3.4")).toBe("leads:acme:1.2.3.4");
  });

  it("namespaces by bucket so different buckets never collide", () => {
    expect(rateLimitKey("crew-pin", "acme")).toBe("crew-pin:acme");
  });
});

describe("RATE_LIMITS", () => {
  it("defines leads at 10 per 60s", () => {
    expect(RATE_LIMITS.leads).toEqual({ limit: 10, windowSeconds: 60 });
  });

  it("defines crew-pin at 5 per 60s", () => {
    expect(RATE_LIMITS["crew-pin"]).toEqual({ limit: 5, windowSeconds: 60 });
  });

  it("RateBucket union matches the map keys", () => {
    const buckets: RateBucket[] = ["leads", "crew-pin"];
    for (const b of buckets) expect(RATE_LIMITS[b]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core test rate-limit-key`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/rate-limit-key.ts`:

```ts
/** Per-bucket throttle policy. The IO wrapper (apps/web) maps this onto Upstash. */
export const RATE_LIMITS = {
  leads: { limit: 10, windowSeconds: 60 },
  "crew-pin": { limit: 5, windowSeconds: 60 },
} as const;

export type RateBucket = keyof typeof RATE_LIMITS;

/** Build the Redis key for a throttle bucket + caller id (e.g. `${tenantKey}:${ip}`). */
export function rateLimitKey(bucket: RateBucket, id: string): string {
  return `${bucket}:${id}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/core test rate-limit-key`
Expected: PASS (5 tests).

- [ ] **Step 5: Export from the core index**

Modify `packages/core/src/index.ts` — add:

```ts
export * from "./rate-limit-key";
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/rate-limit-key.ts packages/core/src/rate-limit-key.test.ts packages/core/src/index.ts
git commit -m "feat(core): rateLimitKey + per-bucket limit map"
```

---

## Task 4: `formatLog` structured logger (`@savvy/core`)

**Files:**
- Create: `packages/core/src/log-format.ts`
- Test: `packages/core/src/log-format.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/log-format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatLog } from "./log-format.js";

describe("formatLog", () => {
  it("produces a single JSON line with level, msg and time", () => {
    const line = formatLog("info", "hello", undefined, "2026-06-18T00:00:00.000Z");
    expect(JSON.parse(line)).toEqual({
      level: "info",
      msg: "hello",
      time: "2026-06-18T00:00:00.000Z",
    });
  });

  it("merges context fields at the top level", () => {
    const line = formatLog("error", "boom", { route: "/api/leads", tenantId: "t1" }, "2026-06-18T00:00:00.000Z");
    expect(JSON.parse(line)).toEqual({
      level: "error",
      msg: "boom",
      time: "2026-06-18T00:00:00.000Z",
      route: "/api/leads",
      tenantId: "t1",
    });
  });

  it("does not let ctx override the reserved level/msg/time fields", () => {
    const line = formatLog("warn", "real", { level: "spoof", msg: "spoof", time: "spoof" } as never, "2026-06-18T00:00:00.000Z");
    expect(JSON.parse(line)).toEqual({
      level: "warn",
      msg: "real",
      time: "2026-06-18T00:00:00.000Z",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core test log-format`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/log-format.ts`:

```ts
export type LogLevel = "info" | "warn" | "error";

/** Optional structured context. Ids only — never PII. */
export type LogContext = {
  requestId?: string;
  tenantId?: string;
  route?: string;
  [key: string]: string | number | boolean | undefined;
};

/**
 * Format a single structured log line as JSON. Pure: `time` is passed in
 * (ISO string) so the function is deterministic and testable. Reserved
 * level/msg/time fields always win over ctx.
 */
export function formatLog(level: LogLevel, msg: string, ctx: LogContext | undefined, time: string): string {
  return JSON.stringify({ ...(ctx ?? {}), level, msg, time });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/core test log-format`
Expected: PASS (3 tests).

- [ ] **Step 5: Export from the core index**

Modify `packages/core/src/index.ts` — add:

```ts
export * from "./log-format";
```

- [ ] **Step 6: Run the gate**

Run (from repo root):
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm --filter @savvy/core test
```
Expected: typecheck PASS, lint 0 errors, core tests PASS (10 new tests across Tasks 1/3/4).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/log-format.ts packages/core/src/log-format.test.ts packages/core/src/index.ts
git commit -m "feat(core): formatLog structured JSON line formatter"
```

---

## Task 5: Install dependencies (Upstash + Sentry)

**Files:** `apps/web/package.json` (+ root `pnpm-lock.yaml`).

- [ ] **Step 1: Add the deps to apps/web**

Run (from repo root):
```bash
pnpm --filter @savvy/web add @upstash/ratelimit @upstash/redis @sentry/nextjs
```
Note: the web package's name is the value of `"name"` in `apps/web/package.json`. If `@savvy/web` is rejected, run `cat apps/web/package.json | grep '"name"'` and use that name in the `--filter`.

- [ ] **Step 2: Relink the workspace**

Run (from repo root):
```bash
pnpm install
```
(Adding a workspace dep can momentarily leave other packages' node_modules unresolved → false "missing module" typecheck errors. `pnpm install` at root relinks.)

- [ ] **Step 3: Verify typecheck still passes**

Run (from repo root):
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck
```
Expected: 7/7 pass (deps installed, nothing using them yet).

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml
git commit -m "chore(web): add @upstash/ratelimit, @upstash/redis, @sentry/nextjs"
```

---

## Task 6: Rate-limit IO wrapper + apply to `/api/leads` and `crewLogin`

**Files:**
- Create: `apps/web/src/lib/rate-limit.ts`
- Modify: `apps/web/src/app/api/leads/route.ts`
- Modify: `apps/web/src/lib/crew-actions.ts`

No vitest here (apps/web is Playwright-only). The pure logic was tested in Task 3. Disabled-mode behavior (no Upstash env → all requests pass) is exactly the e2e condition, so the existing e2e suite verifies the no-op path.

- [ ] **Step 1: Write the IO wrapper**

Create `apps/web/src/lib/rate-limit.ts`:

```ts
import "server-only";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { rateLimitKey, RATE_LIMITS, type RateBucket } from "@savvy/core";
import { log } from "./log";

// Lazily-built singletons; only created when BOTH Upstash env vars are present.
let redis: Redis | null = null;
const limiters = new Map<RateBucket, Ratelimit>();

function getRedis(): Redis | null {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null; // disabled mode
  redis = new Redis({ url, token });
  return redis;
}

function getLimiter(bucket: RateBucket): Ratelimit | null {
  const r = getRedis();
  if (!r) return null;
  const existing = limiters.get(bucket);
  if (existing) return existing;
  const { limit, windowSeconds } = RATE_LIMITS[bucket];
  const limiter = new Ratelimit({
    redis: r,
    limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s`),
    prefix: "savvy-rl",
  });
  limiters.set(bucket, limiter);
  return limiter;
}

/**
 * Throttle a request. FAIL-OPEN by design: when Upstash is unconfigured or the
 * limiter errors, return { ok: true } so a limiter outage never breaks lead
 * capture or crew login. The throttle only exists once Upstash env is set in prod.
 */
export async function checkRateLimit(bucket: RateBucket, id: string): Promise<{ ok: boolean }> {
  const limiter = getLimiter(bucket);
  if (!limiter) return { ok: true }; // disabled mode (no env)
  try {
    const { success } = await limiter.limit(rateLimitKey(bucket, id));
    return { ok: success };
  } catch (err) {
    log.warn("rate-limit check failed (failing open)", { route: bucket, msg: String(err) });
    return { ok: true };
  }
}

/** First hop of x-forwarded-for, or "unknown". Vercel sets this header. */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (!xff) return "unknown";
  return xff.split(",")[0]?.trim() || "unknown";
}
```

> Note: this imports `./log` (Task 7). If executing strictly in order, Task 7's `log.ts` does not exist yet — typecheck will fail at Step 3. Either do Task 7 Step 1 (create `log.ts`) first, or temporarily replace the `log.warn(...)` line with `console.warn(...)` and restore it in Task 7. The two-stage reviewer should flag if the temporary `console.warn` is left in. **Recommended:** create `apps/web/src/lib/log.ts` (Task 7 Step 1) before this step.

- [ ] **Step 2: Apply to the leads route**

Replace the full contents of `apps/web/src/app/api/leads/route.ts`:

```ts
import { NextResponse } from "next/server";
import { leadIntakeSchema, z } from "@savvy/core";
import { createLeadForTenant, tenantByKey } from "@/lib/intake";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { log } from "@/lib/log";

export const runtime = "nodejs";

const bodySchema = leadIntakeSchema.extend({ key: z.string().min(1) });

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { key, ...input } = parsed.data;
  const ip = clientIp(req.headers);
  const { ok } = await checkRateLimit("leads", `${key}:${ip}`);
  if (!ok) {
    log.warn("lead intake rate limited", { route: "/api/leads" });
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const t = await tenantByKey(key);
  if (!t) return NextResponse.json({ error: "unknown tenant" }, { status: 404 });
  const leadId = await createLeadForTenant(t.id, input);
  log.info("lead intake accepted", { route: "/api/leads", tenantId: t.id });
  return NextResponse.json({ leadId }, { status: 201 });
}
```

- [ ] **Step 3: Apply to crewLogin**

In `apps/web/src/lib/crew-actions.ts`:
- Add to imports (top of file, after the existing imports):
  ```ts
  import { headers } from "next/headers";
  import { checkRateLimit, clientIp } from "./rate-limit";
  import { log } from "./log";
  ```
- Replace the body of `crewLogin` (lines 10–23) with:
  ```ts
  export async function crewLogin(key: string, pin: string): Promise<{ ok: true } | { error: string }> {
    const ip = clientIp(await headers());
    const limited = await checkRateLimit("crew-pin", `${key}:${ip}`);
    if (!limited.ok) {
      log.warn("crew login rate limited", { route: "crew-login" });
      return { error: "too many attempts" };
    }
    const t = await tenantByKey(key);
    if (!t) return { error: "unknown workspace" };
    // Filter to active (non-deactivated) crew members only — deactivated users must not be
    // able to sign in even if their PIN hash is still present in the database.
    const crew = await adminDb
      .select({ id: user.id, pinHash: user.pinHash })
      .from(user)
      .where(and(eq(user.tenantId, t.id), eq(user.role, "crew"), isNull(user.deactivatedAt)));
    const match = crew.find((u) => verifyPin(pin, u.pinHash));
    if (!match) return { error: "invalid PIN" };
    await setCrewCookie({ tenantId: t.id, crewUserId: match.id });
    return { ok: true };
  }
  ```

- [ ] **Step 4: Run the gate**

Run (from repo root):
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Expected: typecheck 7/7, lint 0 errors, 244 unit tests green.

- [ ] **Step 5: Run the crew + leads e2e (disabled-mode no-op proof)**

The e2e runs WITHOUT Upstash env, so `checkRateLimit` is in disabled mode and must let everything through. Run the existing crew + scheduling/leads e2e specs to prove no regression:
```bash
cd apps/web && pnpm exec playwright test crew companycam scheduling --reporter=line ; cd ../..
```
Expected: PASS (no throttle since disabled mode). If the e2e harness isn't set up in this session, note it for the final whole-branch verification instead of skipping silently.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/rate-limit.ts apps/web/src/app/api/leads/route.ts apps/web/src/lib/crew-actions.ts apps/web/src/lib/log.ts
git commit -m "feat(web): fail-open Upstash rate-limiting on /api/leads + crew PIN login"
```

---

## Task 7: Structured logging wrapper + apply to public/webhook routes

**Files:**
- Create: `apps/web/src/lib/log.ts` (if not already created in Task 6 Step 1)
- Modify (light touch — log receipt + errors, don't over-instrument): `apps/web/src/app/api/stripe/webhook/route.ts`, `apps/web/src/app/api/docuseal/webhook/route.ts`, `apps/web/src/app/api/companycam/webhook/route.ts`, `apps/web/src/app/api/clerk/webhook/route.ts`, and the Twilio route(s) under `apps/web/src/app/api/twilio/`.

- [ ] **Step 1: Write the log wrapper**

Create `apps/web/src/lib/log.ts`:

```ts
import { formatLog, type LogContext } from "@savvy/core";

/**
 * Thin structured-logging wrapper. Emits one JSON line per call to the matching
 * console method; Vercel captures stdout/stderr. The pure formatter lives in
 * @savvy/core (unit-tested); this file only supplies the timestamp + console IO.
 */
export const log = {
  info(msg: string, ctx?: LogContext) {
    console.log(formatLog("info", msg, ctx, new Date().toISOString()));
  },
  warn(msg: string, ctx?: LogContext) {
    console.warn(formatLog("warn", msg, ctx, new Date().toISOString()));
  },
  error(msg: string, ctx?: LogContext) {
    console.error(formatLog("error", msg, ctx, new Date().toISOString()));
  },
};
```

- [ ] **Step 2: Identify the existing console.* and catch blocks to convert**

Run (from repo root) to see what's there:
```bash
grep -rn "console\." apps/web/src/app/api/stripe/webhook apps/web/src/app/api/docuseal/webhook apps/web/src/app/api/companycam/webhook apps/web/src/app/api/clerk/webhook apps/web/src/app/api/twilio
```
For each route: add `import { log } from "@/lib/log";`, replace each `console.error(...)`/`console.warn(...)`/`console.log(...)` with the matching `log.error/warn/info(...)` call, passing a `{ route: "<the route path>" }` context (plus `tenantId` if one is already resolved in scope). Where a route has a top-level `try/catch` but no logging in the catch, add `log.error("<route> handler failed", { route: "<path>", msg: String(err) });` inside the catch (do not change control flow or swallow errors that weren't already swallowed). Where a webhook has a clear "received" entry point, add one `log.info("<event> webhook received", { route: "<path>" })` after signature verification succeeds. **Light touch** — receipt + errors only; do not log request bodies or secrets.

- [ ] **Step 3: Convert each route**

Apply Step 2 to each of: `stripe/webhook/route.ts`, `docuseal/webhook/route.ts`, `companycam/webhook/route.ts`, `clerk/webhook/route.ts`, and every `route.ts` under `twilio/`. (`crewLogin` already logs from Task 6; `/api/leads` already logs from Task 6.) Keep edits minimal and mechanical.

- [ ] **Step 4: Run the gate**

Run (from repo root):
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Expected: typecheck 7/7, lint 0 errors, tests green.

- [ ] **Step 5: Run the webhook e2e**

```bash
cd apps/web && pnpm exec playwright test esign companycam --reporter=line ; cd ../..
```
Expected: PASS (logging is additive; behavior unchanged). Note for final verification if the harness isn't available this session.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/log.ts apps/web/src/app/api/stripe/webhook apps/web/src/app/api/docuseal/webhook apps/web/src/app/api/companycam/webhook apps/web/src/app/api/clerk/webhook apps/web/src/app/api/twilio
git commit -m "feat(web): structured JSON logging on public/webhook routes"
```

---

## Task 8: Sentry error tracking (`apps/web`)

Inert when `SENTRY_DSN` is unset (the e2e/TEST_MODE condition), so no e2e. Verified by build + typecheck; live capture is a manual-verify step. SDK shape confirmed against current `@sentry/nextjs` docs (Next 16, `instrumentation.ts` + `Sentry.captureRequestError` + `instrumentation-client.ts`).

**Files (all Create except next.config):**
- `apps/web/sentry.server.config.ts`
- `apps/web/sentry.edge.config.ts`
- `apps/web/instrumentation.ts`
- `apps/web/instrumentation-client.ts`
- `apps/web/src/app/global-error.tsx`
- Modify: `apps/web/next.config.ts`

- [ ] **Step 1: Server runtime config**

Create `apps/web/sentry.server.config.ts`:

```ts
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN, // inert when unset
  tracesSampleRate: 0.1,
  enabled: !!process.env.SENTRY_DSN,
});
```

- [ ] **Step 2: Edge runtime config**

Create `apps/web/sentry.edge.config.ts`:

```ts
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN, // inert when unset
  tracesSampleRate: 0.1,
  enabled: !!process.env.SENTRY_DSN,
});
```

- [ ] **Step 3: Server instrumentation + onRequestError**

Create `apps/web/instrumentation.ts`:

```ts
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Captures errors from route handlers, RSC, and server actions (Next 15+ / SDK v8.28+).
export const onRequestError = Sentry.captureRequestError;
```

- [ ] **Step 4: Client instrumentation**

Create `apps/web/instrumentation-client.ts`:

```ts
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN, // inert when unset
  tracesSampleRate: 0.1,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
```

> Note the client reads `NEXT_PUBLIC_SENTRY_DSN` (browser env must be public-prefixed). Server/edge read `SENTRY_DSN`. Document both in Task 9.

- [ ] **Step 5: Global error boundary**

Create `apps/web/src/app/global-error.tsx`:

```tsx
"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
        <h1>Something went wrong</h1>
      </body>
    </html>
  );
}
```

- [ ] **Step 6: Wrap next.config**

Replace `apps/web/next.config.ts`:

```ts
import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@savvy/db",
    "@savvy/agents",
    "@savvy/ai",
    "@savvy/core",
    "@savvy/integrations",
    "@savvy/ui",
  ],
};

export default withSentryConfig(nextConfig, {
  // Source-map upload disabled for now (no SENTRY_AUTH_TOKEN) — deferred polish.
  silent: !process.env.CI,
});
```

- [ ] **Step 7: Build to verify Sentry wiring compiles (DSN unset = inert)**

Run (from repo root):
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint
pnpm --filter @savvy/web build
```
Expected: typecheck 7/7, lint 0 errors, **build succeeds**. The build is the real verification for Sentry (you can't e2e an inert SDK). If `pnpm --filter @savvy/web build` needs a different filter name, use the `"name"` from `apps/web/package.json` (see Task 5). If the build needs services/env that aren't available this session, note it for the final whole-branch verification rather than marking it passed.

- [ ] **Step 8: Run the full unit + e2e gate (no Sentry interference)**

Run (from repo root):
```bash
pnpm test
```
Expected: all unit tests green (Sentry adds no unit tests; build is its proof).

- [ ] **Step 9: Commit**

```bash
git add apps/web/sentry.server.config.ts apps/web/sentry.edge.config.ts apps/web/instrumentation.ts apps/web/instrumentation-client.ts apps/web/src/app/global-error.tsx apps/web/next.config.ts
git commit -m "feat(web): Sentry error tracking (inert without SENTRY_DSN)"
```

---

## Task 9: Document new environment + final gate

**Files:** `.env.example` (Modify). `.env.production.example` does NOT exist on this branch (it is introduced by the still-open PR #27) — if it has appeared (PR #27 merged), apply the same additions there too.

- [ ] **Step 1: Update `.env.example`**

In `.env.example`, under the existing `# Observability` block (which already has `SENTRY_DSN=`), make it read:

```bash
# Observability
# Sentry: absence of SENTRY_DSN disables error tracking entirely (dev/e2e/TEST_MODE unaffected).
SENTRY_DSN=
# Public (browser) DSN — required for client-side error capture; usually the same project DSN.
NEXT_PUBLIC_SENTRY_DSN=
# Optional / future: enables source-map upload at build time (deferred — not required).
SENTRY_AUTH_TOKEN=
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=

# Rate limiting (Upstash Redis REST). Absence of BOTH disables throttling (fail-open).
# Required in prod for /api/leads (10/60s) and crew PIN login (5/60s) limits to be active.
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

- [ ] **Step 2: Mirror to `.env.production.example` if present**

Run (from repo root):
```bash
test -f .env.production.example && echo "EXISTS — add the same SENTRY_*/UPSTASH_* lines there" || echo "absent on this branch (added by PR #27); skip"
```
If it exists, add the same `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` keys (values empty/placeholders, no secrets).

- [ ] **Step 3: Note the runbook follow-up**

If `docs/DEPLOYMENT.md` exists on this branch (it is added by PR #27 — likely absent here), add a line to its env/secrets checklist: "Set `UPSTASH_REDIS_REST_URL` + `_TOKEN` for rate-limiting to be active; set `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN` for error tracking." If `docs/DEPLOYMENT.md` is absent, skip and record this as a deferred follow-up in the PR body (so it gets added when #27's runbook lands).

- [ ] **Step 4: Final full gate**

Run (from repo root):
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Expected: typecheck 7/7, lint 0 errors, ~249 unit tests green (239 baseline + 10 new core tests). Re-run any flaky full-suite timeout in isolation per the repo's known concurrency flake.

- [ ] **Step 5: Confirm no stray route-group dirs**

Run (from repo root):
```bash
git status --porcelain && ls apps/web/src/app | grep -E '\\\\\(' && echo "STRAY ESCAPED DIR — clean up" || echo "clean"
```
Expected: no `\(app\)`-style escaped directories; working tree matches intended changes only.

- [ ] **Step 6: Commit**

```bash
git add .env.example
git commit -m "docs(env): document Sentry + Upstash rate-limit env (disabled-by-absence)"
```

---

## Final verification (whole-branch, before PR)

- [ ] Full gate green: `pnpm typecheck && pnpm lint && pnpm test` (typecheck 7/7, lint 0, ~249 tests).
- [ ] `pnpm --filter @savvy/web build` succeeds (Sentry wiring compiles, DSN unset = inert).
- [ ] e2e green where runnable (crew, companycam, esign, scheduling) — proves disabled-mode rate-limit + additive logging didn't regress anything.
- [ ] `git log --oneline origin/main..HEAD` shows the 8 task commits + the spec commit; no commits landed in a stray `.claude/worktrees/agent-*` worktree (verify each commit is on `feat/hardening-observability`).
- [ ] Adversarial whole-branch review (per the project method): secrets fail closed in prod, rate-limit fails open, Sentry inert without DSN, no PII/secrets in log lines, no tenant-isolation path touched.
- [ ] PR body lists deferred items: Sentry source-map upload (`SENTRY_AUTH_TOKEN`), webhook/`/intake` rate-limiting, pino/log-drains, Langfuse wiring, WAF rules; plus the DEPLOYMENT.md + `.env.production.example` additions if those files weren't present (land them when PR #27 merges).
- [ ] Manual-verify steps documented (can't automate): with a real `SENTRY_DSN`, a thrown test route appears in Sentry; with Upstash env set, hammering `/api/leads` returns 429 and crew PIN login returns "too many attempts".

---

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| Part 1 — `requireSecret` in `@savvy/core` (returns env / throws in prod / dev fallback) | Task 1 |
| Part 1 — replace 6 `UNSUBSCRIBE_SECRET` fallback sites | Task 2 (steps 1–6) |
| Part 1 — refactor `CREW_SESSION_SECRET` to the helper (no behavior change) | Task 2 (step 7) |
| Part 1 — unit tests (set wins / prod throws / dev fallback explicit+defaulted) | Task 1 (step 1) |
| Part 2 — Sentry `instrumentation.ts` + `onRequestError` | Task 8 (step 3) |
| Part 2 — `instrumentation-client.ts` | Task 8 (step 4) |
| Part 2 — `global-error.tsx` | Task 8 (step 5) |
| Part 2 — `withSentryConfig`, source-map upload OFF | Task 8 (step 6) |
| Part 2 — inert without DSN; verify by build + manual throw | Task 8 (steps 7, + manual-verify in final) |
| Part 3 — pure `rateLimitKey` + limit map (leads 10/60s, crew-pin 5/60s) in core, tested | Task 3 |
| Part 3 — `apps/web/src/lib/rate-limit.ts` lazy singleton, fail-open | Task 6 (step 1) |
| Part 3 — apply to `/api/leads` → 429, and `crewLogin` → "too many attempts" | Task 6 (steps 2–3) |
| Part 3 — IP from `x-forwarded-for` | Task 6 (`clientIp`) |
| Part 4 — pure `formatLog` in core, tested | Task 4 |
| Part 4 — `apps/web/src/lib/log.ts` wrappers → JSON to console | Task 7 (step 1) |
| Part 4 — apply to public/webhook routes + crew login | Task 6 (leads + crewLogin) + Task 7 (steps 2–3) |
| New env documented in `.env.example` (+ prod example) | Task 9 |
| Deps: `@upstash/ratelimit`, `@upstash/redis`, `@sentry/nextjs` | Task 5 |
| Disabled-by-absence; e2e/TEST_MODE unaffected; no migration | All tasks (verified in final) |
