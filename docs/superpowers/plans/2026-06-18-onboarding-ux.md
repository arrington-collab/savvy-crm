# Onboarding UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a post-signup onboarding wizard (required welcome step → optional profile/invite/connect steps, resumable via a dashboard checklist) plus a lean public landing page at `/`.

**Architecture:** Pure state/derive logic in `@savvy/core`; tenant-settings writes in `@savvy/db` (adminDb, the RLS-root pattern); thin admin-gated server actions + `server-only` queries in `apps/web/src/lib`; a dedicated `(onboarding)` route group with its own minimal layout; a gate redirect in `(app)/layout`; a landing page swapped into root `/`. No schema migration (reuses `tenant.settings` jsonb + existing columns).

**Tech Stack:** Next.js 16 (App Router, RSC + server actions), Drizzle/Postgres, Clerk, Tailwind v4 + shadcn, Vitest (packages) + Playwright (apps/web e2e), pnpm + Turborepo.

**Spec:** `docs/superpowers/specs/2026-06-18-onboarding-ux-design.md`

## Conventions (read before any task)
- **Single-instance imports**: in app/package SOURCE, import drizzle operators (`eq`, `and`, `count`, `isNull`) from `@savvy/db` and `z` from `@savvy/core` — never from `drizzle-orm`/`zod` directly.
- **Import extensions**: SOURCE files use NO extension (`"../schema/index"`); `*.test.ts` files use `.js` (`"../admin-client.js"`) — vitest resolves `.js`→`.ts`.
- **Tenant table is the RLS root** — `savvy_app` cannot write it; all tenant reads/writes go through `adminDb`, scoped by `getTenantId()`.
- **apps/web is Playwright-only** — do NOT add vitest there. Web query helpers stay thin + untested; testable logic lives in `@savvy/core` (pure) / `@savvy/db` (integration).
- **Gate env**: `export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy` before running tests.
- **Branch**: work on `feat/onboarding-ux` (already created off `origin/main`; the spec commit is already here).

## File structure
| File | Responsibility |
|------|----------------|
| `packages/core/src/onboarding.ts` (create) | `parseOnboardingState`, `deriveOnboardingSteps`, `isOnboardingComplete` (pure) |
| `packages/core/src/onboarding.test.ts` (create) | unit tests for the above |
| `packages/core/src/index.ts` (modify) | re-export `./onboarding` |
| `packages/db/src/lifecycle/onboarding.ts` (create) | `setOnboardingRequiredComplete`, `setOnboardingProfile`, `dismissOnboarding` (adminDb) |
| `packages/db/src/lifecycle/onboarding.test.ts` (create) | integration tests incl. settings-merge + cross-tenant |
| `packages/db/src/index.ts` (modify) | re-export the 3 helpers |
| `apps/web/src/lib/onboarding-queries.ts` (create) | `getOnboardingStatus()` (`server-only`, thin) |
| `apps/web/src/lib/onboarding-actions.ts` (create) | `completeWelcome`, `saveProfile`, `dismissChecklist` (admin-gated) |
| `apps/web/src/lib/viewer.ts` (create) | `getViewerUserId()` — TEST_MODE-safe Clerk userId |
| `apps/web/src/app/(onboarding)/layout.tsx` (create) | auth + provisioning, minimal chrome |
| `apps/web/src/app/(onboarding)/onboarding/page.tsx` (create) | server page → renders `OnboardingWizard` |
| `apps/web/src/components/onboarding/OnboardingWizard.tsx` (create) | client stepper (4 steps) |
| `apps/web/src/components/onboarding/OnboardingChecklist.tsx` (create) | dashboard card |
| `apps/web/src/app/(app)/layout.tsx` (modify) | gate redirect to `/onboarding` |
| `apps/web/src/app/(app)/dashboard/page.tsx` (modify) | render checklist at top |
| `apps/web/src/app/page.tsx` (modify) | landing-or-redirect |
| `apps/web/src/components/landing/LandingPage.tsx` (create) | lean marketing page |
| `apps/web/src/middleware.ts` (modify) | add `/^\/$/` to PUBLIC |
| `apps/web/tests/e2e/onboarding.spec.ts` (create) | e2e: wizard + checklist + landing |

---

## Task 1: Onboarding state + derive logic (`@savvy/core`)

**Files:**
- Create: `packages/core/src/onboarding.ts`
- Test: `packages/core/src/onboarding.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/onboarding.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  parseOnboardingState,
  deriveOnboardingSteps,
  isOnboardingComplete,
} from "./onboarding.js";

describe("parseOnboardingState", () => {
  it("defaults empty/undefined to not-started, not-dismissed", () => {
    expect(parseOnboardingState(undefined)).toEqual({ requiredCompletedAt: null, dismissed: false });
    expect(parseOnboardingState({})).toEqual({ requiredCompletedAt: null, dismissed: false });
  });
  it("reads a partial object", () => {
    expect(parseOnboardingState({ dismissed: true })).toEqual({ requiredCompletedAt: null, dismissed: true });
  });
  it("reads a full object", () => {
    const iso = "2026-06-18T00:00:00.000Z";
    expect(parseOnboardingState({ requiredCompletedAt: iso, dismissed: false }))
      .toEqual({ requiredCompletedAt: iso, dismissed: false });
  });
  it("ignores unrelated keys", () => {
    expect(parseOnboardingState({ scheduling: { foo: 1 } }))
      .toEqual({ requiredCompletedAt: null, dismissed: false });
  });
});

describe("deriveOnboardingSteps", () => {
  const base = {
    requiredCompletedAt: null,
    revenueBand: null,
    activeUserCount: 1,
    connections: { stripe: false, qbo: false, companycam: false },
  };
  it("all incomplete by default", () => {
    expect(deriveOnboardingSteps(base)).toEqual({ company: false, band: false, team: false, integrations: false });
  });
  it("company true once requiredCompletedAt set", () => {
    expect(deriveOnboardingSteps({ ...base, requiredCompletedAt: "x" }).company).toBe(true);
  });
  it("band true once revenueBand set", () => {
    expect(deriveOnboardingSteps({ ...base, revenueBand: "starter" }).band).toBe(true);
  });
  it("team true once more than one active user", () => {
    expect(deriveOnboardingSteps({ ...base, activeUserCount: 2 }).team).toBe(true);
  });
  it("integrations true if any connection present", () => {
    expect(deriveOnboardingSteps({ ...base, connections: { stripe: true, qbo: false, companycam: false } }).integrations).toBe(true);
    expect(deriveOnboardingSteps({ ...base, connections: { stripe: false, qbo: true, companycam: false } }).integrations).toBe(true);
  });
});

describe("isOnboardingComplete", () => {
  it("true only when all four steps done", () => {
    expect(isOnboardingComplete({ company: true, band: true, team: true, integrations: true })).toBe(true);
    expect(isOnboardingComplete({ company: true, band: true, team: true, integrations: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @savvy/core test -- onboarding`
Expected: FAIL — `Cannot find module './onboarding.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/onboarding.ts`:
```ts
import { z } from "./schemas";

const onboardingStateSchema = z.object({
  requiredCompletedAt: z.string().nullable().default(null),
  dismissed: z.boolean().default(false),
});

export type OnboardingState = z.infer<typeof onboardingStateSchema>;

/** Parse tenant.settings.onboarding (or anything) into a complete OnboardingState. */
export function parseOnboardingState(raw: unknown): OnboardingState {
  return onboardingStateSchema.parse(raw ?? {});
}

export interface OnboardingStepsInput {
  requiredCompletedAt: string | null;
  revenueBand: string | null;
  activeUserCount: number;
  connections: { stripe: boolean; qbo: boolean; companycam: boolean };
}

export interface OnboardingSteps {
  company: boolean;
  band: boolean;
  team: boolean;
  integrations: boolean;
}

/** Derive checklist truth from real tenant data (NOT stored flags). */
export function deriveOnboardingSteps(input: OnboardingStepsInput): OnboardingSteps {
  return {
    company: input.requiredCompletedAt != null,
    band: input.revenueBand != null,
    team: input.activeUserCount > 1,
    integrations:
      input.connections.stripe || input.connections.qbo || input.connections.companycam,
  };
}

export function isOnboardingComplete(steps: OnboardingSteps): boolean {
  return steps.company && steps.band && steps.team && steps.integrations;
}
```

- [ ] **Step 4: Export from the package index**

Modify `packages/core/src/index.ts` — add after the last `export * from` line:
```ts
export * from "./onboarding";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @savvy/core test -- onboarding`
Expected: PASS (all cases green).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/onboarding.ts packages/core/src/onboarding.test.ts packages/core/src/index.ts
git commit -m "feat(core): onboarding state parse + step derivation"
```

---

## Task 2: Tenant-settings write helpers (`@savvy/db`)

**Files:**
- Create: `packages/db/src/lifecycle/onboarding.ts`
- Test: `packages/db/src/lifecycle/onboarding.test.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/lifecycle/onboarding.test.ts`:
```ts
import { afterAll, describe, it, expect } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { tenant } from "../schema/index.js";
import {
  setOnboardingRequiredComplete,
  setOnboardingProfile,
  dismissOnboarding,
} from "./onboarding.js";

const ids: string[] = [];
async function makeTenant(settings: Record<string, unknown> = {}): Promise<string> {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "T", publicKey: `ob-${crypto.randomUUID()}`, settings })
    .returning({ id: tenant.id });
  ids.push(t!.id);
  return t!.id;
}

afterAll(async () => {
  if (ids.length) await adminDb.delete(tenant).where(inArray(tenant.id, ids));
  await pool.end();
  await adminPool.end();
});

describe("onboarding write helpers", () => {
  it("setOnboardingRequiredComplete sets name + stamps requiredCompletedAt, preserves siblings", async () => {
    const id = await makeTenant({ scheduling: { hours: "9-5" } });
    await setOnboardingRequiredComplete({ tenantId: id, name: "Acme Roofing" });
    const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, id));
    expect(t!.name).toBe("Acme Roofing");
    const s = t!.settings as Record<string, any>;
    expect(typeof s.onboarding.requiredCompletedAt).toBe("string");
    expect(s.scheduling).toEqual({ hours: "9-5" }); // sibling preserved
  });

  it("setOnboardingProfile sets revenueBand + finance.timezone, preserves onboarding key", async () => {
    const id = await makeTenant({ onboarding: { requiredCompletedAt: "x", dismissed: false } });
    await setOnboardingProfile({ tenantId: id, revenueBand: "growth", timezone: "America/New_York" });
    const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, id));
    expect(t!.revenueBand).toBe("growth");
    const s = t!.settings as Record<string, any>;
    expect(s.finance.timezone).toBe("America/New_York");
    expect(s.onboarding.requiredCompletedAt).toBe("x"); // sibling preserved
  });

  it("dismissOnboarding sets dismissed without clearing requiredCompletedAt", async () => {
    const id = await makeTenant({ onboarding: { requiredCompletedAt: "x", dismissed: false } });
    await dismissOnboarding({ tenantId: id });
    const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, id));
    const s = t!.settings as Record<string, any>;
    expect(s.onboarding.dismissed).toBe(true);
    expect(s.onboarding.requiredCompletedAt).toBe("x");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @savvy/db test -- onboarding`
Expected: FAIL — `Cannot find module './onboarding.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/db/src/lifecycle/onboarding.ts`:
```ts
import { eq } from "drizzle-orm";
import { tenant } from "../schema/index";
import { adminDb } from "../admin-client";

// Tenant is the RLS isolation root — savvy_app lacks UPDATE on it, so all tenant
// writes go through adminDb. We read-modify-write tenant.settings (the same
// pattern as settings-actions.ts) so sibling keys (scheduling/finance/esign)
// are preserved. Each helper merges only its own nested key.

async function readSettings(tenantId: string): Promise<Record<string, unknown>> {
  const [t] = await adminDb
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  return (t?.settings as Record<string, unknown>) ?? {};
}

export async function setOnboardingRequiredComplete(
  input: { tenantId: string; name: string },
): Promise<void> {
  const settings = await readSettings(input.tenantId);
  const onboarding = {
    ...((settings.onboarding as object) ?? {}),
    requiredCompletedAt: new Date().toISOString(),
  };
  await adminDb
    .update(tenant)
    .set({ name: input.name, settings: { ...settings, onboarding } })
    .where(eq(tenant.id, input.tenantId));
}

export async function setOnboardingProfile(
  input: { tenantId: string; revenueBand: string; timezone: string },
): Promise<void> {
  const settings = await readSettings(input.tenantId);
  const finance = { ...((settings.finance as object) ?? {}), timezone: input.timezone };
  await adminDb
    .update(tenant)
    .set({ revenueBand: input.revenueBand, settings: { ...settings, finance } })
    .where(eq(tenant.id, input.tenantId));
}

export async function dismissOnboarding(input: { tenantId: string }): Promise<void> {
  const settings = await readSettings(input.tenantId);
  const onboarding = { ...((settings.onboarding as object) ?? {}), dismissed: true };
  await adminDb
    .update(tenant)
    .set({ settings: { ...settings, onboarding } })
    .where(eq(tenant.id, input.tenantId));
}
```

- [ ] **Step 4: Export from the package index**

Modify `packages/db/src/index.ts` — add after line 35 (the provisioning export):
```ts
export { setOnboardingRequiredComplete, setOnboardingProfile, dismissOnboarding } from "./lifecycle/onboarding";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @savvy/db test -- onboarding`
Expected: PASS (3 tests). (Cross-tenant isolation is implicit: each helper targets a single `tenantId`; the integration test asserts sibling-settings preservation, the riskiest behavior.)

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/onboarding.ts packages/db/src/lifecycle/onboarding.test.ts packages/db/src/index.ts
git commit -m "feat(db): onboarding tenant-settings write helpers"
```

---

## Task 3: Onboarding status query (`apps/web`)

**Files:**
- Create: `apps/web/src/lib/onboarding-queries.ts`

(Thin web query — no unit test; apps/web is Playwright-only. Verified by typecheck + Task 11 e2e.)

- [ ] **Step 1: Write the implementation**

Create `apps/web/src/lib/onboarding-queries.ts`:
```ts
import "server-only";
import { adminDb, tenant, user, eq, and, isNull, count, isNotNull } from "@savvy/db";
import {
  parseOnboardingState,
  deriveOnboardingSteps,
  type OnboardingState,
  type OnboardingSteps,
} from "@savvy/core";
import { getTenantId } from "./tenant";

export interface OnboardingStatus {
  state: OnboardingState;
  steps: OnboardingSteps;
  tenantName: string;
}

export async function getOnboardingStatus(): Promise<OnboardingStatus> {
  const tenantId = await getTenantId();
  const [t] = await adminDb
    .select({
      name: tenant.name,
      revenueBand: tenant.revenueBand,
      settings: tenant.settings,
      stripeAccountId: tenant.stripeAccountId,
      qboConnectionId: tenant.qboConnectionId,
      companycamConnectionId: tenant.companycamConnectionId,
    })
    .from(tenant)
    .where(eq(tenant.id, tenantId));

  // Count active, Clerk-backed users (excludes PIN crew + deactivated).
  const [{ value: activeUserCount }] = await adminDb
    .select({ value: count() })
    .from(user)
    .where(and(eq(user.tenantId, tenantId), isNotNull(user.clerkUserId), isNull(user.deactivatedAt)));

  const state = parseOnboardingState((t?.settings as Record<string, unknown> | undefined)?.onboarding);
  const steps = deriveOnboardingSteps({
    requiredCompletedAt: state.requiredCompletedAt,
    revenueBand: t?.revenueBand ?? null,
    activeUserCount: Number(activeUserCount ?? 0),
    connections: {
      stripe: !!t?.stripeAccountId,
      qbo: !!t?.qboConnectionId,
      companycam: !!t?.companycamConnectionId,
    },
  });
  return { state, steps, tenantName: t?.name ?? "" };
}
```

- [ ] **Step 2: Add the missing `isNotNull` operator export**

`@savvy/db` re-exports drizzle operators but NOT `isNotNull` yet (it has `eq, and, or, not, sql, count, desc, asc, inArray, isNull, lt, gte, lte, gt`). Modify `packages/db/src/index.ts` line 27 to add `isNotNull`:
```ts
export { eq, and, or, not, sql, count, desc, asc, inArray, isNull, isNotNull, lt, gte, lte, gt } from "drizzle-orm";
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm --filter @savvy/db typecheck && pnpm --filter @savvy/web typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/onboarding-queries.ts packages/db/src/index.ts
git commit -m "feat(web): onboarding status query"
```

---

## Task 4: Viewer helper + onboarding actions (`apps/web`)

**Files:**
- Create: `apps/web/src/lib/viewer.ts`
- Create: `apps/web/src/lib/onboarding-actions.ts`

- [ ] **Step 1: Write the TEST_MODE-safe viewer helper**

Create `apps/web/src/lib/viewer.ts`:
```ts
import "server-only";
import { auth } from "@clerk/nextjs/server";

/** Clerk userId for the caller, or null in TEST_MODE (auth() throws there). */
export async function getViewerUserId(): Promise<string | null> {
  if (process.env.TEST_MODE === "1") return null;
  const { userId } = await auth();
  return userId ?? null;
}
```

- [ ] **Step 2: Write the actions**

Create `apps/web/src/lib/onboarding-actions.ts`:
```ts
"use server";
import { revalidatePath } from "next/cache";
import {
  setOnboardingRequiredComplete,
  setOnboardingProfile,
  dismissOnboarding,
} from "@savvy/db";
import { BILLING_BANDS, parseFinanceConfig } from "@savvy/core";
import { getTenantId } from "./tenant";
import { isOrgAdmin } from "./authz";

type Result = { ok: true } | { error: string };

export async function completeWelcome(companyName: string): Promise<Result> {
  if (!(await isOrgAdmin())) return { error: "forbidden" };
  const name = companyName.trim();
  if (!name) return { error: "company name required" };
  const tenantId = await getTenantId();
  await setOnboardingRequiredComplete({ tenantId, name });
  revalidatePath("/onboarding");
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function saveProfile(input: { revenueBand: string; timezone: string }): Promise<Result> {
  if (!(await isOrgAdmin())) return { error: "forbidden" };
  if (!BILLING_BANDS.some((b) => b.key === input.revenueBand)) return { error: "invalid band" };
  // parseFinanceConfig validates the IANA timezone (throws on bad zone).
  let timezone: string;
  try {
    timezone = parseFinanceConfig({ timezone: input.timezone }).timezone;
  } catch {
    return { error: "invalid timezone" };
  }
  const tenantId = await getTenantId();
  await setOnboardingProfile({ tenantId, revenueBand: input.revenueBand, timezone });
  revalidatePath("/onboarding");
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function dismissChecklist(): Promise<Result> {
  if (!(await isOrgAdmin())) return { error: "forbidden" };
  const tenantId = await getTenantId();
  await dismissOnboarding({ tenantId });
  revalidatePath("/dashboard");
  return { ok: true };
}
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm --filter @savvy/web typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/viewer.ts apps/web/src/lib/onboarding-actions.ts
git commit -m "feat(web): viewer helper + admin-gated onboarding actions"
```

---

## Task 5: Onboarding route group + layout + page

**Files:**
- Create: `apps/web/src/app/(onboarding)/layout.tsx`
- Create: `apps/web/src/app/(onboarding)/onboarding/page.tsx`

- [ ] **Step 1: Write the layout** (mirrors `(app)/layout` auth/provisioning, no sidebar)

Create `apps/web/src/app/(onboarding)/layout.tsx`:
```tsx
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getCurrentUser } from "@/lib/current-user";

export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  if (process.env.TEST_MODE !== "1") {
    const { userId, orgId } = await auth();
    if (!userId) redirect("/sign-in");
    if (!orgId) redirect("/select-org");
    await getCurrentUser(); // lazily provision tenant + this user's row
  }
  return (
    <main className="min-h-screen p-6" style={{ background: "var(--surface-app)" }}>
      <div className="mx-auto max-w-2xl py-10">{children}</div>
    </main>
  );
}
```

- [ ] **Step 2: Write the server page**

Create `apps/web/src/app/(onboarding)/onboarding/page.tsx`:
```tsx
import { getOnboardingStatus } from "@/lib/onboarding-queries";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";
import { BILLING_BANDS } from "@savvy/core";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const { steps, tenantName } = await getOnboardingStatus();
  const bands = BILLING_BANDS.map((b) => ({ key: b.key, name: b.name, monthlyPriceCents: b.monthlyPriceCents }));
  return <OnboardingWizard tenantName={tenantName} steps={steps} bands={bands} />;
}
```

- [ ] **Step 3: Verify typecheck fails on the missing component**

Run: `pnpm --filter @savvy/web typecheck`
Expected: FAIL — cannot find `@/components/onboarding/OnboardingWizard` (created in Task 6).

- [ ] **Step 4: Commit (after Task 6 makes it green)** — defer commit; proceed to Task 6.

---

## Task 6: OnboardingWizard component (4-step stepper)

**Files:**
- Create: `apps/web/src/components/onboarding/OnboardingWizard.tsx`

- [ ] **Step 1: Write the component**

Create `apps/web/src/components/onboarding/OnboardingWizard.tsx`:
```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { OnboardingSteps } from "@savvy/core";
import { completeWelcome, saveProfile } from "@/lib/onboarding-actions";
import { inviteMember } from "@/lib/team-actions";

type Band = { key: string; name: string; monthlyPriceCents: number };
const STEPS = ["Welcome", "Profile", "Invite", "Connect"] as const;
const fmtUsd = (c: number) => `$${(c / 100).toLocaleString("en-US")}`;

export function OnboardingWizard({
  tenantName,
  steps,
  bands,
}: {
  tenantName: string;
  steps: OnboardingSteps;
  bands: Band[];
}) {
  const router = useRouter();
  // Start past Welcome if it's already done (resuming optional steps).
  const [step, setStep] = useState(steps.company ? 1 : 0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [company, setCompany] = useState(tenantName);
  const [band, setBand] = useState(bands[0]?.key ?? "starter");
  const [tz, setTz] = useState("America/Phoenix");
  const [inviteEmail, setInviteEmail] = useState("");

  const finish = () => router.push("/dashboard");
  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));

  async function run(fn: () => Promise<{ ok: true } | { error: string }>, after: () => void) {
    setBusy(true);
    setErr(null);
    const r = await fn();
    setBusy(false);
    if ("error" in r) setErr(r.error);
    else after();
  }

  return (
    <div data-testid="onboarding-wizard" className="space-y-6">
      <div className="flex items-center gap-2 text-sm" style={{ color: "var(--text-faint)" }}>
        {STEPS.map((s, i) => (
          <span key={s} data-testid={`wizard-step-${i}`} style={{ fontWeight: i === step ? 700 : 400, color: i === step ? "var(--accent-gold)" : undefined }}>
            {s}{i < STEPS.length - 1 ? " ›" : ""}
          </span>
        ))}
      </div>

      {err && <p data-testid="wizard-error" style={{ color: "var(--status-error)" }}>{err}</p>}

      {step === 0 && (
        <section className="space-y-4">
          <h1 className="text-2xl font-bold">Welcome to Savvy</h1>
          <p style={{ color: "var(--text-faint)" }}>Confirm your company name to get started.</p>
          <input
            data-testid="welcome-company"
            className="w-full rounded border bg-transparent px-3 py-2"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Company name"
          />
          <button
            data-testid="welcome-continue"
            disabled={busy || !company.trim()}
            className="rounded px-4 py-2 font-semibold"
            style={{ background: "var(--accent-gold)", color: "#1a1206" }}
            onClick={() => run(() => completeWelcome(company), next)}
          >
            Continue
          </button>
        </section>
      )}

      {step === 1 && (
        <section className="space-y-4">
          <h1 className="text-2xl font-bold">Your plan & timezone</h1>
          <div className="grid grid-cols-3 gap-3">
            {bands.map((b) => (
              <button
                key={b.key}
                data-testid={`band-${b.key}`}
                onClick={() => setBand(b.key)}
                className="rounded border p-3 text-left"
                style={{ borderColor: band === b.key ? "var(--accent-gold)" : undefined }}
              >
                <div className="font-semibold">{b.name}</div>
                <div className="text-sm" style={{ color: "var(--text-faint)" }}>{fmtUsd(b.monthlyPriceCents)}/mo</div>
              </button>
            ))}
          </div>
          <input
            data-testid="profile-tz"
            className="w-full rounded border bg-transparent px-3 py-2"
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            placeholder="America/Phoenix"
          />
          <div className="flex gap-3">
            <button data-testid="profile-save" disabled={busy} className="rounded px-4 py-2 font-semibold" style={{ background: "var(--accent-gold)", color: "#1a1206" }}
              onClick={() => run(() => saveProfile({ revenueBand: band, timezone: tz }), next)}>Save & continue</button>
            <button data-testid="profile-skip" className="rounded px-4 py-2" onClick={next}>Skip</button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="space-y-4">
          <h1 className="text-2xl font-bold">Invite your team</h1>
          <input
            data-testid="invite-email"
            className="w-full rounded border bg-transparent px-3 py-2"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="teammate@company.com"
          />
          <div className="flex gap-3">
            <button data-testid="invite-send" disabled={busy || !inviteEmail.trim()} className="rounded px-4 py-2 font-semibold" style={{ background: "var(--accent-gold)", color: "#1a1206" }}
              onClick={() => run(() => inviteMember(inviteEmail, "rep"), () => setInviteEmail(""))}>Send invite</button>
            <button data-testid="invite-skip" className="rounded px-4 py-2" onClick={next}>Skip</button>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="space-y-4">
          <h1 className="text-2xl font-bold">Connect your tools</h1>
          <div className="grid grid-cols-2 gap-3">
            {[
              { name: "Stripe", href: "/settings/payments" },
              { name: "CompanyCam", href: "/settings/crew" },
              { name: "QuickBooks", href: "/settings/quickbooks" },
              { name: "Roofr", href: "/settings" },
            ].map((c) => (
              <Link key={c.name} data-testid={`connect-${c.name.toLowerCase()}`} href={c.href} className="rounded border p-4">
                Connect {c.name}
              </Link>
            ))}
          </div>
          <button data-testid="onboarding-finish" className="rounded px-4 py-2 font-semibold" style={{ background: "var(--accent-gold)", color: "#1a1206" }} onClick={finish}>
            Go to dashboard
          </button>
        </section>
      )}

      <button data-testid="skip-to-dashboard" className="text-sm underline" style={{ color: "var(--text-faint)" }} onClick={finish}>
        Skip to dashboard
      </button>
    </div>
  );
}
```

> Note on the CompanyCam connect link: it currently lives under `/settings/crew` per the 6D work — confirm against `apps/web/src/app/(app)/settings` and adjust the `href` if the connect UI is elsewhere. Roofr has no dedicated settings page yet, so it links to `/settings` (honest placeholder).

- [ ] **Step 2: Verify typecheck**

Run: `pnpm --filter @savvy/web typecheck`
Expected: PASS (Task 5 page + this component now resolve).

- [ ] **Step 3: Commit (Tasks 5 + 6 together)**

```bash
git add "apps/web/src/app/(onboarding)" apps/web/src/components/onboarding/OnboardingWizard.tsx
git commit -m "feat(web): onboarding route group + 4-step wizard"
```

---

## Task 7: OnboardingChecklist + dashboard integration

**Files:**
- Create: `apps/web/src/components/onboarding/OnboardingChecklist.tsx`
- Modify: `apps/web/src/app/(app)/dashboard/page.tsx`

- [ ] **Step 1: Write the checklist component**

Create `apps/web/src/components/onboarding/OnboardingChecklist.tsx`:
```tsx
"use client";
import Link from "next/link";
import type { OnboardingSteps } from "@savvy/core";
import { dismissChecklist } from "@/lib/onboarding-actions";

const ITEMS: { key: keyof OnboardingSteps; label: string; href: string }[] = [
  { key: "band", label: "Choose your plan", href: "/onboarding" },
  { key: "team", label: "Invite a teammate", href: "/settings/team" },
  { key: "integrations", label: "Connect a tool", href: "/onboarding" },
];

export function OnboardingChecklist({ steps }: { steps: OnboardingSteps }) {
  const done = ITEMS.filter((i) => steps[i.key]).length;
  return (
    <div data-testid="onboarding-checklist" className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="font-semibold">Finish setting up Savvy — {done}/{ITEMS.length}</div>
        <button data-testid="checklist-dismiss" className="text-sm underline" style={{ color: "var(--text-faint)" }} onClick={() => dismissChecklist()}>
          Dismiss
        </button>
      </div>
      <ul className="space-y-2">
        {ITEMS.map((i) => (
          <li key={i.key} className="flex items-center gap-2">
            <span style={{ color: steps[i.key] ? "var(--status-ok)" : "var(--text-faint)" }}>{steps[i.key] ? "✓" : "○"}</span>
            {steps[i.key] ? <span style={{ color: "var(--text-faint)" }}>{i.label}</span> : <Link href={i.href} className="underline">{i.label}</Link>}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Render it at the top of the dashboard**

Modify `apps/web/src/app/(app)/dashboard/page.tsx`:
- Add imports near the top:
```ts
import { getOnboardingStatus } from "@/lib/onboarding-queries";
import { isOnboardingComplete } from "@savvy/core";
import { OnboardingChecklist } from "@/components/onboarding/OnboardingChecklist";
```
- Add `getOnboardingStatus()` to the existing `Promise.all` and destructure it:
```ts
  const [pipeline, runs, velocity, repPerf, onboarding] = await Promise.all([
    getPipelineCounts(),
    getRecentAgentRuns(),
    getVelocity(),
    getRepPerformance(),
    getOnboardingStatus(),
  ]);
  const showChecklist = !onboarding.state.dismissed && !isOnboardingComplete(onboarding.steps);
```
- Render the checklist as the first child inside the top-level `<div className="space-y-6">`:
```tsx
      {showChecklist && <OnboardingChecklist steps={onboarding.steps} />}
```

- [ ] **Step 3: Verify typecheck + lint**

Run: `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint`
Expected: PASS, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/onboarding/OnboardingChecklist.tsx "apps/web/src/app/(app)/dashboard/page.tsx"
git commit -m "feat(web): onboarding dashboard checklist"
```

---

## Task 8: Gate redirect in `(app)/layout`

**Files:**
- Modify: `apps/web/src/app/(app)/layout.tsx`

- [ ] **Step 1: Add the gate**

Modify `apps/web/src/app/(app)/layout.tsx` — inside the `if (authEnabled) { ... }` block, AFTER `await getCurrentUser();`, add:
```ts
    const { getOnboardingStatus } = await import("@/lib/onboarding-queries");
    const status = await getOnboardingStatus();
    if (status.state.requiredCompletedAt === null) redirect("/onboarding");
```
(Use a dynamic import to keep the layout's existing top imports untouched, or add a normal top-of-file import `import { getOnboardingStatus } from "@/lib/onboarding-queries";` — either is fine; prefer the top-level import for readability.)

- [ ] **Step 2: Verify typecheck**

Run: `pnpm --filter @savvy/web typecheck`
Expected: PASS. (Behavior is real-auth only; TEST_MODE skips this whole block, so e2e is unaffected.)

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/layout.tsx"
git commit -m "feat(web): gate dashboard behind onboarding welcome step"
```

---

## Task 9: Landing page + root route + middleware

**Files:**
- Create: `apps/web/src/components/landing/LandingPage.tsx`
- Modify: `apps/web/src/app/page.tsx`
- Modify: `apps/web/src/middleware.ts`

- [ ] **Step 1: Write the landing component** (lean, honest)

Create `apps/web/src/components/landing/LandingPage.tsx`:
```tsx
import Link from "next/link";

const VALUE_PROPS = [
  { title: "One pipeline, lead to paid", body: "Every job flows through inspect → estimate → produce → close → bill in one place." },
  { title: "AI agents that do real work", body: "Five agents handle comms, scheduling, finance, and ops — not just chat." },
  { title: "Get paid faster", body: "Built-in estimates, e-sign, and invoicing keep cash moving." },
];

export function LandingPage() {
  return (
    <main className="min-h-screen" style={{ background: "var(--surface-app)" }}>
      <header className="mx-auto flex max-w-5xl items-center justify-between p-6">
        <span className="text-lg font-bold" style={{ color: "var(--accent-gold)" }}>Savvy</span>
        <nav className="flex gap-4">
          <Link data-testid="landing-signin" href="/sign-in" className="underline">Sign in</Link>
          <Link data-testid="landing-signup-nav" href="/sign-up" className="rounded px-3 py-1 font-semibold" style={{ background: "var(--accent-gold)", color: "#1a1206" }}>Start free</Link>
        </nav>
      </header>
      <section className="mx-auto max-w-3xl px-6 py-20 text-center">
        <h1 className="text-4xl font-bold">The operations layer that runs your roofing company.</h1>
        <p className="mx-auto mt-4 max-w-xl text-lg" style={{ color: "var(--text-faint)" }}>
          Savvy is a multi-tenant ops platform with AI agents across the whole job lifecycle.
        </p>
        <Link data-testid="landing-signup" href="/sign-up" className="mt-8 inline-block rounded px-6 py-3 font-semibold" style={{ background: "var(--accent-gold)", color: "#1a1206" }}>
          Start free
        </Link>
      </section>
      <section className="mx-auto grid max-w-5xl gap-6 px-6 pb-20 md:grid-cols-3">
        {VALUE_PROPS.map((v) => (
          <div key={v.title} className="rounded-lg border p-5">
            <h3 className="font-semibold">{v.title}</h3>
            <p className="mt-2 text-sm" style={{ color: "var(--text-faint)" }}>{v.body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
```

- [ ] **Step 2: Swap root `/` to landing-or-redirect**

Replace `apps/web/src/app/page.tsx` entirely:
```tsx
import { redirect } from "next/navigation";
import { getViewerUserId } from "@/lib/viewer";
import { LandingPage } from "@/components/landing/LandingPage";

export const dynamic = "force-dynamic";

export default async function Home() {
  const userId = await getViewerUserId(); // null in TEST_MODE → landing renders (e2e-testable)
  if (userId) redirect("/dashboard");
  return <LandingPage />;
}
```

- [ ] **Step 3: Make `/` public in middleware**

Modify `apps/web/src/middleware.ts` — add `/^\/$/` as the FIRST entry of the `PUBLIC` array:
```ts
const PUBLIC = [/^\/$/, /^\/intake\//, /^\/crew\//, /^\/api\/leads$/, /^\/api\/twilio\//, /^\/api\/inngest$/, /^\/api\/stripe\/webhook$/, /^\/api\/docuseal\/webhook$/, /^\/api\/companycam\/webhook$/, /^\/api\/clerk\/webhook$/, /^\/sign-in/, /^\/sign-up/, /^\/select-org$/];
```

- [ ] **Step 4: Check for e2e that assumed `/` → `/dashboard`**

Run: `grep -rn 'goto("/")' apps/web/tests/e2e`
If any spec navigates to `/` expecting the dashboard, change it to `page.goto("/dashboard")`. Expected: likely none (specs target explicit routes).

- [ ] **Step 5: Verify typecheck + lint**

Run: `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint`
Expected: PASS, 0 errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/landing/LandingPage.tsx apps/web/src/app/page.tsx apps/web/src/middleware.ts
git commit -m "feat(web): lean public landing page at /"
```

---

## Task 10: Full gate verification (typecheck + lint + unit tests)

**Files:** none (verification only)

- [ ] **Step 1: Run the full gate**

Run:
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Expected: typecheck 7/7, lint 0 errors, all unit/integration tests pass (225 prior + the new core + db onboarding tests).

- [ ] **Step 2: Fix anything red, then commit if fixes were needed**

```bash
git add -A && git commit -m "chore(onboarding): gate green (typecheck/lint/test)"
```
(Skip the commit if nothing changed.)

---

## Task 11: e2e (Playwright, TEST_MODE)

**Files:**
- Create: `apps/web/tests/e2e/onboarding.spec.ts`

- [ ] **Step 1: Write the e2e spec**

Create `apps/web/tests/e2e/onboarding.spec.ts`:
```ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, tenant, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

// TEST_MODE: middleware + (app)/layout bypass auth; getTenantId() → TEST_TENANT_ID.
// The real-auth gate redirect is NOT exercised here (manual-verify only).

test("landing page renders for the public with a sign-up CTA", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /operations layer/i })).toBeVisible();
  await expect(page.getByTestId("landing-signup")).toHaveAttribute("href", "/sign-up");
});

test("wizard: complete welcome step → lands on dashboard", async ({ page }) => {
  await page.goto("/onboarding");
  await expect(page.getByTestId("onboarding-wizard")).toBeVisible();
  await page.getByTestId("welcome-company").fill("E2E Roofing Co");
  await page.getByTestId("welcome-continue").click();
  // Welcome stamped; advancing to Profile step (step index 1) is visible.
  await expect(page.getByTestId("wizard-step-1")).toBeVisible();
  // Verify the write landed.
  await expect(async () => {
    const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
    const s = t!.settings as Record<string, any>;
    expect(s.onboarding?.requiredCompletedAt).toBeTruthy();
    expect(t!.name).toBe("E2E Roofing Co");
  }).toPass({ timeout: 8000 });
});

test("dashboard checklist shows for an incomplete tenant, then dismisses", async ({ page }) => {
  // Ensure not dismissed + band unset so the checklist shows.
  await adminDb.update(tenant)
    .set({ revenueBand: null, settings: { onboarding: { requiredCompletedAt: "x", dismissed: false } } })
    .where(eq(tenant.id, tenantId));
  await page.goto("/dashboard");
  await expect(page.getByTestId("onboarding-checklist")).toBeVisible();
  await page.getByTestId("checklist-dismiss").click();
  await expect(async () => {
    const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
    expect((t!.settings as any).onboarding.dismissed).toBe(true);
  }).toPass({ timeout: 8000 });
});
```

> Note: the third test mutates the shared e2e tenant's settings; run order within a file is sequential, and the welcome test only asserts `requiredCompletedAt` is truthy (it tolerates the later overwrite). If flakiness appears, split the checklist test into its own file.

- [ ] **Step 2: Run the e2e suite**

Bring up the 4 services (per repo e2e instructions in memory/CLAUDE.md): Postgres + ai-stub + Inngest dev server + create-tenant, then:
```bash
pnpm --filter @savvy/web exec playwright test onboarding
```
Expected: 3 tests PASS. (If the webServer isn't already configured for these routes, no extra env is needed — onboarding/landing use no new env vars.)

- [ ] **Step 3: Verify lint on the new spec**

Run: `pnpm --filter @savvy/web lint`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/tests/e2e/onboarding.spec.ts
git commit -m "test(web): e2e for onboarding wizard, checklist, landing"
```

---

## Final verification & PR
- [ ] Full gate green: `pnpm typecheck && pnpm lint && pnpm test` (with DB env exported).
- [ ] Whole-branch adversarial review (per session method) before merge.
- [ ] `gh pr create --base main` with a summary + the manual-verify note (real-auth gate redirect + invite flow need a Clerk dev instance).

## Manual-verify checklist (real Clerk instance — cannot run under TEST_MODE)
1. Sign up → create a brand-new org → confirm you're redirected to `/onboarding` (gate fires).
2. Complete Welcome → land on `/dashboard`; confirm the checklist shows (band/team/integrations open).
3. Sign out → visit `/` → landing renders; signed in → `/` redirects to `/dashboard`.
4. Invite a teammate from the wizard → Clerk invitation sent.
