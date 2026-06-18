# Auth & Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real customer signs in via Clerk → gets a lazily-provisioned tenant + user row (role mapped from Clerk), kept in sync by a Clerk webhook, and an admin can manage the team in-app.

**Architecture:** Clerk owns identity (orgs=tenants, memberships=users); the DB is a synced projection written by two idempotent `@savvy/db` helpers (`ensureTenantForOrg`/`ensureUser`) used by both the lazy request path (`getTenantId`/`getCurrentUser`) and a svix-verified webhook. Plus app-only crew users. No new dependencies (manual svix HMAC, `crypto.randomBytes` publicKey).

**Tech Stack:** Next.js 16 App Router, Clerk v6 (`@clerk/nextjs`), Drizzle/Postgres, `node:crypto`, vitest + Playwright.

**Spec:** `docs/superpowers/specs/2026-06-18-auth-provisioning-design.md`

---

## Conventions
- **Branch:** `feat/auth-provisioning` (off `origin/main`; spec committed there).
- **DB env:** `export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy` + `export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy`.
- **Import extensions:** `packages/*` source NO `.js`, tests WITH `.js`; `apps/web` NO `.js`.
- **`@savvy/db`** re-exports schema tables + operators. **No `any`** (lint forbids it — use `unknown` + casts, as the docuseal webhook does). `noUncheckedIndexedAccess` ON.
- **Provisioning writes use `adminDb`** (tenant has no RLS; user RLS is bypassed by the superuser admin connection — same as `seed.ts` and `saveQuickBooksConnection`). These run server-side only (webhook, layout).
- **TEST_MODE stays** the e2e bypass. The Clerk paths can't run under TEST_MODE; they're verified by a manual checklist (Task 11).
- **Migrations:** `pnpm --filter @savvy/db db:generate` then `db:migrate` (re-applies `rls-grants.sql`; new columns/tables auto-covered). Commit the generated `.sql` AND `meta/_journal.json` + `meta/NNNN_snapshot.json`.

## File Structure
| File | Responsibility |
|------|----------------|
| `packages/core/src/enums.ts` | + `export type UserRole` |
| `packages/core/src/clerk-role.ts` (+test) | `mapClerkRole(orgRole, isCreator)` |
| `packages/db/src/schema/tenancy.ts` | `user.deactivatedAt` + partial unique index |
| `packages/db/drizzle/0013_*.sql` | migration |
| `packages/db/src/lifecycle/provisioning.ts` (+test) | `ensureTenantForOrg`/`ensureUser`/`deactivateUserByClerkId` |
| `apps/web/src/lib/tenant.ts` | lazy tenant provisioning |
| `apps/web/src/lib/current-user.ts` | `getCurrentUser` (lazy user) |
| `apps/web/src/lib/svix.ts` | `verifySvix` (manual HMAC) |
| `apps/web/src/app/api/clerk/webhook/route.ts` | Clerk event sync |
| `apps/web/src/middleware.ts` | PUBLIC += clerk webhook, sign-in, sign-up |
| `apps/web/src/app/sign-in/[[...sign-in]]/page.tsx`, `sign-up/...`, `select-org/page.tsx` | Clerk auth UI |
| `apps/web/src/app/(app)/layout.tsx` | auth choke point + `authEnabled` |
| `apps/web/src/components/cockpit/TopBar.tsx` | OrgSwitcher + UserButton |
| `apps/web/src/components/cockpit/Sidebar.tsx` | + Team nav |
| `apps/web/src/lib/team-queries.ts`, `team-actions.ts` | team management |
| `apps/web/src/app/(app)/settings/team/` | team UI |
| `apps/web/src/lib/scheduling-queries.ts`, `crew-admin-actions.ts` | filter deactivated |
| tests | core `clerk-role`, db `provisioning`, e2e `team.spec.ts` + `clerk-webhook.spec.ts` |

---

# WAVE 1 — Provisioning + sign-in (independently shippable)

## Task 1: Schema — `user.deactivatedAt` + partial unique index (migration 0013)

**Files:** Modify `packages/db/src/schema/tenancy.ts`; generate `packages/db/drizzle/0013_*.sql`; modify `apps/web/src/lib/scheduling-queries.ts`, `apps/web/src/lib/crew-admin-actions.ts`.

- [ ] **Step 1: Edit the `user` table**

In `packages/db/src/schema/tenancy.ts`: ensure `uniqueIndex` is imported from `drizzle-orm/pg-core` and `sql` from `drizzle-orm` (add to existing imports if missing). Add a column to `user` (after `pinHash`):
```ts
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
```
And add to the `user` table's second-arg array (alongside `index("user_tenant_idx")` and `tenantIsolation()`):
```ts
  uniqueIndex("user_tenant_clerk_uniq").on(t.tenantId, t.clerkUserId).where(sql`${t.clerkUserId} IS NOT NULL`),
```

- [ ] **Step 2: Generate + apply the migration**

```bash
docker compose up -d
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm --filter @savvy/db db:generate
```
Open the new `packages/db/drizzle/0013_*.sql`; confirm `ALTER TABLE "user" ADD COLUMN "deactivated_at"` and `CREATE UNIQUE INDEX "user_tenant_clerk_uniq" ON "user" ... ("tenant_id","clerk_user_id") WHERE "clerk_user_id" IS NOT NULL`. Then:
```bash
pnpm --filter @savvy/db db:migrate
pnpm --filter @savvy/db typecheck
```
Expected: `migrations + grants applied`; typecheck clean.

- [ ] **Step 3: Filter deactivated users from assignable lists**

In `apps/web/src/lib/scheduling-queries.ts`, `listUsers` currently:
```ts
export async function listUsers() {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx.select({ id: user.id, name: user.name }).from(user),
  );
}
```
Change the select to exclude deactivated (add `isNull` to the `@savvy/db` import):
```ts
export async function listUsers() {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx.select({ id: user.id, name: user.name }).from(user).where(isNull(user.deactivatedAt)),
  );
}
```
In `apps/web/src/lib/crew-admin-actions.ts`, `listCrewUsers` currently filters `eq(user.role, "crew")`; change its `.where` to also exclude deactivated (the file imports `and`, `eq`; add `isNull`):
```ts
    tx.select({ id: user.id, name: user.name, pinHash: user.pinHash }).from(user).where(and(eq(user.role, "crew"), isNull(user.deactivatedAt))));
```

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/db typecheck
git add packages/db/src/schema/tenancy.ts packages/db/drizzle apps/web/src/lib/scheduling-queries.ts apps/web/src/lib/crew-admin-actions.ts
git commit -m "feat(db): user.deactivatedAt + clerk-user unique index (migration 0013); filter deactivated"
```

---

## Task 2: `mapClerkRole` (`@savvy/core`)

**Files:** Modify `packages/core/src/enums.ts`; create `packages/core/src/clerk-role.ts`, `packages/core/src/clerk-role.test.ts`; modify `packages/core/src/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/clerk-role.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mapClerkRole } from "./clerk-role.js";

describe("mapClerkRole", () => {
  it("creator → owner regardless of org role", () => {
    expect(mapClerkRole("org:admin", true)).toBe("owner");
    expect(mapClerkRole("org:member", true)).toBe("owner");
  });
  it("org:admin → admin, anything else → rep", () => {
    expect(mapClerkRole("org:admin", false)).toBe("admin");
    expect(mapClerkRole("org:member", false)).toBe("rep");
    expect(mapClerkRole(null, false)).toBe("rep");
    expect(mapClerkRole(undefined, false)).toBe("rep");
  });
});
```

- [ ] **Step 2: Run it (FAIL — module missing)**

```bash
pnpm --filter @savvy/core exec vitest run src/clerk-role.test.ts
```

- [ ] **Step 3: Implement + export the `UserRole` type**

In `packages/core/src/enums.ts`, after the `USER_ROLE` const, add:
```ts
export type UserRole = (typeof USER_ROLE)[number];
```
Create `packages/core/src/clerk-role.ts`:
```ts
import type { UserRole } from "./enums";

export type ClerkMappedRole = Extract<UserRole, "owner" | "admin" | "rep">;

/** Maps a Clerk org membership to an app role. The org creator is owner; an
 *  org:admin is admin; everyone else is a rep. office/crew are app-assigned. */
export function mapClerkRole(orgRole: string | null | undefined, isCreator: boolean): ClerkMappedRole {
  if (isCreator) return "owner";
  return orgRole === "org:admin" ? "admin" : "rep";
}
```
In `packages/core/src/index.ts`, add:
```ts
export * from "./clerk-role";
```

- [ ] **Step 4: Run it (PASS) + typecheck**

```bash
pnpm --filter @savvy/core exec vitest run src/clerk-role.test.ts
pnpm --filter @savvy/core typecheck
```
Expected: 2 tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/enums.ts packages/core/src/clerk-role.ts packages/core/src/clerk-role.test.ts packages/core/src/index.ts
git commit -m "feat(core): mapClerkRole + UserRole type"
```

---

## Task 3: Provisioning lifecycle (`@savvy/db`)

**Files:** Create `packages/db/src/lifecycle/provisioning.ts`, `packages/db/src/lifecycle/provisioning.test.ts`; modify `packages/db/src/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/lifecycle/provisioning.test.ts`:
```ts
import { afterAll, describe, it, expect } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { tenant, user } from "../schema/index.js";
import { ensureTenantForOrg, ensureUser, deactivateUserByClerkId } from "./provisioning.js";

const orgIds: string[] = [];
function org() { const id = `org_${crypto.randomUUID()}`; orgIds.push(id); return id; }

afterAll(async () => {
  const ids = await adminDb.select({ id: tenant.id }).from(tenant).where(inArray(tenant.clerkOrgId, orgIds));
  const tids = ids.map((r) => r.id);
  if (tids.length) {
    await adminDb.delete(user).where(inArray(user.tenantId, tids));
    await adminDb.delete(tenant).where(inArray(tenant.id, tids));
  }
  await pool.end();
  await adminPool.end();
});

describe("provisioning", () => {
  it("ensureTenantForOrg creates once, then is idempotent", async () => {
    const o = org();
    const a = await ensureTenantForOrg({ clerkOrgId: o, name: "Acme" });
    expect(a.created).toBe(true);
    expect(a.publicKey.length).toBeGreaterThan(6);
    const b = await ensureTenantForOrg({ clerkOrgId: o, name: "Acme" });
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
  });

  it("ensureUser inserts, then updates name/email + syncs role (owner sticky)", async () => {
    const o = org();
    const { id: tenantId } = await ensureTenantForOrg({ clerkOrgId: o, name: "T" });
    const cuid = `user_${crypto.randomUUID()}`;
    const ins = await ensureUser({ tenantId, clerkUserId: cuid, name: "A", email: "a@x.com", role: "owner" });
    expect(ins.created).toBe(true);
    // a membership event maps them to admin, but owner is sticky:
    const up = await ensureUser({ tenantId, clerkUserId: cuid, name: "A2", email: "a2@x.com", role: "admin" });
    expect(up.created).toBe(false);
    const [row] = await adminDb.select().from(user).where(eq(user.id, ins.id));
    expect(row!.role).toBe("owner");      // sticky
    expect(row!.name).toBe("A2");          // updated
    // a non-sticky user DOES sync admin<->rep:
    const cuid2 = `user_${crypto.randomUUID()}`;
    const r1 = await ensureUser({ tenantId, clerkUserId: cuid2, name: "B", email: "b@x.com", role: "rep" });
    await ensureUser({ tenantId, clerkUserId: cuid2, name: "B", email: "b@x.com", role: "admin" });
    const [row2] = await adminDb.select().from(user).where(eq(user.id, r1.id));
    expect(row2!.role).toBe("admin");
  });

  it("deactivateUserByClerkId sets deactivatedAt; ensureUser reactivates", async () => {
    const o = org();
    const { id: tenantId } = await ensureTenantForOrg({ clerkOrgId: o, name: "T" });
    const cuid = `user_${crypto.randomUUID()}`;
    const { id } = await ensureUser({ tenantId, clerkUserId: cuid, name: "C", email: "c@x.com", role: "rep" });
    const d = await deactivateUserByClerkId({ tenantId, clerkUserId: cuid });
    expect(d.deactivated).toBe(true);
    let [row] = await adminDb.select().from(user).where(eq(user.id, id));
    expect(row!.deactivatedAt).not.toBeNull();
    await ensureUser({ tenantId, clerkUserId: cuid, name: "C", email: "c@x.com", role: "rep" });
    [row] = await adminDb.select().from(user).where(eq(user.id, id));
    expect(row!.deactivatedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run it (FAIL — module missing)**

```bash
pnpm --filter @savvy/db exec vitest run src/lifecycle/provisioning.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/db/src/lifecycle/provisioning.ts`:
```ts
import { and, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { tenant, user } from "../schema/index";
import { adminDb } from "../admin-client";
import type { UserRole } from "@savvy/core";

// Roles that are assigned in-app and must NOT be clobbered by Clerk role sync.
const APP_STICKY = new Set<UserRole>(["owner", "office", "crew"]);

/** Find-or-create a tenant for a Clerk org. Idempotent + race-safe (clerkOrgId unique). */
export async function ensureTenantForOrg(
  input: { clerkOrgId: string; name: string },
): Promise<{ id: string; publicKey: string; created: boolean }> {
  const [existing] = await adminDb
    .select({ id: tenant.id, publicKey: tenant.publicKey })
    .from(tenant)
    .where(eq(tenant.clerkOrgId, input.clerkOrgId));
  if (existing) return { id: existing.id, publicKey: existing.publicKey ?? "", created: false };
  const publicKey = randomBytes(9).toString("base64url"); // 12 url-safe chars
  try {
    const [row] = await adminDb
      .insert(tenant)
      .values({ clerkOrgId: input.clerkOrgId, name: input.name, publicKey })
      .returning({ id: tenant.id, publicKey: tenant.publicKey });
    return { id: row!.id, publicKey: row!.publicKey ?? publicKey, created: true };
  } catch {
    // Lost a race — the other writer created it.
    const [t] = await adminDb
      .select({ id: tenant.id, publicKey: tenant.publicKey })
      .from(tenant)
      .where(eq(tenant.clerkOrgId, input.clerkOrgId));
    if (!t) throw new Error("ensureTenantForOrg: insert failed and no row found");
    return { id: t.id, publicKey: t.publicKey ?? "", created: false };
  }
}

/** Upsert a Clerk-backed user by (tenantId, clerkUserId). Updates name/email,
 *  reactivates, and syncs role unless the existing role is app-sticky (owner/office/crew). */
export async function ensureUser(input: {
  tenantId: string; clerkUserId: string; name: string; email: string; role: UserRole;
}): Promise<{ id: string; created: boolean }> {
  const [existing] = await adminDb
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(and(eq(user.tenantId, input.tenantId), eq(user.clerkUserId, input.clerkUserId)));
  if (existing) {
    const nextRole = APP_STICKY.has(existing.role) ? existing.role : input.role;
    await adminDb
      .update(user)
      .set({ name: input.name, email: input.email, role: nextRole, deactivatedAt: null })
      .where(eq(user.id, existing.id));
    return { id: existing.id, created: false };
  }
  try {
    const [row] = await adminDb
      .insert(user)
      .values({ tenantId: input.tenantId, clerkUserId: input.clerkUserId, name: input.name, email: input.email, role: input.role })
      .returning({ id: user.id });
    return { id: row!.id, created: true };
  } catch {
    const [u] = await adminDb
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.tenantId, input.tenantId), eq(user.clerkUserId, input.clerkUserId)));
    if (!u) throw new Error("ensureUser: insert failed and no row found");
    return { id: u.id, created: false };
  }
}

/** Soft-remove a Clerk-backed user (preserves FK references). */
export async function deactivateUserByClerkId(
  input: { tenantId: string; clerkUserId: string },
): Promise<{ deactivated: boolean }> {
  const res = await adminDb
    .update(user)
    .set({ deactivatedAt: new Date() })
    .where(and(eq(user.tenantId, input.tenantId), eq(user.clerkUserId, input.clerkUserId)))
    .returning({ id: user.id });
  return { deactivated: res.length > 0 };
}
```

- [ ] **Step 4: Barrel export**

In `packages/db/src/index.ts`, add:
```ts
export { ensureTenantForOrg, ensureUser, deactivateUserByClerkId } from "./lifecycle/provisioning";
```

- [ ] **Step 5: Run it (PASS) + typecheck**

```bash
pnpm --filter @savvy/db exec vitest run src/lifecycle/provisioning.test.ts
pnpm --filter @savvy/db typecheck
```
Expected: 3 tests pass; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/provisioning.ts packages/db/src/lifecycle/provisioning.test.ts packages/db/src/index.ts
git commit -m "feat(db): provisioning helpers (ensureTenantForOrg/ensureUser/deactivate)"
```

---

## Task 4: Lazy provisioning in the request path

**Files:** Modify `apps/web/src/lib/tenant.ts`; create `apps/web/src/lib/current-user.ts`.

- [ ] **Step 1: Lazy tenant in `getTenantId`**

Replace `apps/web/src/lib/tenant.ts` with:
```ts
import { auth, clerkClient } from "@clerk/nextjs/server";
import { adminDb, tenant, ensureTenantForOrg, eq } from "@savvy/db";

/**
 * Resolves the active tenant. TEST_MODE → TEST_TENANT_ID (e2e). Otherwise the
 * Clerk active org → tenant; if no tenant row yet, lazily provision it.
 */
export async function getTenantId(): Promise<string> {
  if (process.env.TEST_MODE === "1") {
    const id = process.env.TEST_TENANT_ID;
    if (!id) throw new Error("TEST_MODE set but TEST_TENANT_ID missing");
    return id;
  }
  const { orgId } = await auth();
  if (!orgId) throw new Error("no active organization");
  const [t] = await adminDb.select({ id: tenant.id }).from(tenant).where(eq(tenant.clerkOrgId, orgId));
  if (t) return t.id;
  // Lazy provision (org exists in Clerk but no tenant row yet).
  const cc = await clerkClient();
  const org = await cc.organizations.getOrganization({ organizationId: orgId });
  const { id } = await ensureTenantForOrg({ clerkOrgId: orgId, name: org.name });
  return id;
}
```

- [ ] **Step 2: `getCurrentUser` (lazy user)**

Create `apps/web/src/lib/current-user.ts`:
```ts
import "server-only";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { adminDb, user, ensureUser, eq, and } from "@savvy/db";
import { mapClerkRole } from "@savvy/core";
import { getTenantId } from "./tenant";

export type CurrentUser = { tenantId: string; userId: string; role: string; clerkUserId: string | null };

/** Resolves + lazily provisions the calling user's row. Called from (app)/layout
 *  (non-TEST_MODE) so every logged-in Clerk user gets a row on first request. */
export async function getCurrentUser(): Promise<CurrentUser> {
  if (process.env.TEST_MODE === "1") {
    const tenantId = process.env.TEST_TENANT_ID;
    if (!tenantId) throw new Error("TEST_MODE set but TEST_TENANT_ID missing");
    return { tenantId, userId: "test-user", role: "owner", clerkUserId: null };
  }
  const { userId: clerkUserId, orgId, orgRole } = await auth();
  if (!clerkUserId || !orgId) throw new Error("not authenticated");
  const tenantId = await getTenantId();
  const [existing] = await adminDb
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(and(eq(user.tenantId, tenantId), eq(user.clerkUserId, clerkUserId)));
  if (existing) return { tenantId, userId: existing.id, role: existing.role, clerkUserId };

  const cc = await clerkClient();
  const [org, cu] = await Promise.all([
    cc.organizations.getOrganization({ organizationId: orgId }),
    cc.users.getUser(clerkUserId),
  ]);
  const primary = cu.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId) ?? cu.emailAddresses[0];
  const name = [cu.firstName, cu.lastName].filter(Boolean).join(" ") || cu.username || primary?.emailAddress || "User";
  const email = primary?.emailAddress ?? "";
  const role = mapClerkRole(orgRole, org.createdBy === clerkUserId);
  const { id } = await ensureUser({ tenantId, clerkUserId, name, email, role });
  return { tenantId, userId: id, role, clerkUserId };
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm --filter @savvy/web typecheck
git add apps/web/src/lib/tenant.ts apps/web/src/lib/current-user.ts
git commit -m "feat(web): lazy tenant + user provisioning (getTenantId/getCurrentUser)"
```
Expected: typecheck PASS. (Clerk v6: `clerkClient` is async — `await clerkClient()`. `auth()` returns `{ userId, orgId, orgRole }`. `getOrganization` returns `{ name, createdBy }`. If a Clerk type differs, adapt minimally and report.)

---

## Task 5: Clerk webhook + svix verification

**Files:** Create `apps/web/src/lib/svix.ts`, `apps/web/src/app/api/clerk/webhook/route.ts`; modify `apps/web/src/middleware.ts`; create `apps/web/tests/e2e/clerk-webhook.spec.ts`.

- [ ] **Step 1: svix verifier**

Create `apps/web/src/lib/svix.ts`:
```ts
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a svix webhook signature (Clerk uses svix). Signed content is
 * `${id}.${timestamp}.${body}`; the secret is `whsec_<base64>`; the signature
 * header is space-separated `v1,<base64sig>` pairs. Fail-closed in production
 * when no secret is configured; allow in dev/test (parity with other webhooks).
 */
export function verifySvix(
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string,
): boolean {
  if (!secret) return process.env.NODE_ENV !== "production";
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
  return signature.split(" ").some((part) => {
    const b64 = part.split(",")[1] ?? "";
    let provided: Buffer;
    try { provided = Buffer.from(b64, "base64"); } catch { return false; }
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
}
```

- [ ] **Step 2: Webhook route**

Create `apps/web/src/app/api/clerk/webhook/route.ts`:
```ts
import { NextResponse } from "next/server";
import { adminDb, tenant, ensureTenantForOrg, ensureUser, deactivateUserByClerkId, eq } from "@savvy/db";
import { clerkClient } from "@clerk/nextjs/server";
import { mapClerkRole } from "@savvy/core";
import { verifySvix } from "@/lib/svix";

export const runtime = "nodejs"; // node:crypto for HMAC

type ClerkEvent = { type?: string; data?: Record<string, unknown> };
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

async function tenantIdForOrg(orgId: string): Promise<string | null> {
  const [t] = await adminDb.select({ id: tenant.id }).from(tenant).where(eq(tenant.clerkOrgId, orgId));
  return t?.id ?? null;
}

export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text();
  const ok = verifySvix(
    raw,
    { id: req.headers.get("svix-id"), timestamp: req.headers.get("svix-timestamp"), signature: req.headers.get("svix-signature") },
    process.env.CLERK_WEBHOOK_SECRET ?? "",
  );
  if (!ok) return new NextResponse("bad signature", { status: 401 });

  let evt: ClerkEvent;
  try { evt = JSON.parse(raw) as ClerkEvent; } catch { return new NextResponse("bad payload", { status: 400 }); }
  const data = (evt.data ?? {}) as Record<string, unknown>;

  if (evt.type === "organization.created") {
    const orgId = str(data.id);
    if (!orgId) return NextResponse.json({ ok: true });
    const { id: tenantId } = await ensureTenantForOrg({ clerkOrgId: orgId, name: str(data.name) ?? "Workspace" });
    const createdBy = str(data.created_by);
    if (createdBy) {
      const cc = await clerkClient();
      const cu = await cc.users.getUser(createdBy);
      const primary = cu.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId) ?? cu.emailAddresses[0];
      const name = [cu.firstName, cu.lastName].filter(Boolean).join(" ") || cu.username || "Owner";
      await ensureUser({ tenantId, clerkUserId: createdBy, name, email: primary?.emailAddress ?? "", role: "owner" });
    }
    return NextResponse.json({ ok: true });
  }

  if (evt.type === "organizationMembership.created" || evt.type === "organizationMembership.updated") {
    const orgObj = (data.organization ?? {}) as Record<string, unknown>;
    const pud = (data.public_user_data ?? {}) as Record<string, unknown>;
    const orgId = str(orgObj.id);
    const cuid = str(pud.user_id);
    if (!orgId || !cuid) return NextResponse.json({ ok: true });
    const tenantId = await tenantIdForOrg(orgId);
    if (!tenantId) return NextResponse.json({ ok: true });
    const cc = await clerkClient();
    const org = await cc.organizations.getOrganization({ organizationId: orgId });
    const name = [str(pud.first_name), str(pud.last_name)].filter(Boolean).join(" ") || str(pud.identifier) || "Member";
    const role = mapClerkRole(str(data.role), org.createdBy === cuid);
    await ensureUser({ tenantId, clerkUserId: cuid, name, email: str(pud.identifier) ?? "", role });
    return NextResponse.json({ ok: true });
  }

  if (evt.type === "organizationMembership.deleted") {
    const orgObj = (data.organization ?? {}) as Record<string, unknown>;
    const pud = (data.public_user_data ?? {}) as Record<string, unknown>;
    const orgId = str(orgObj.id);
    const cuid = str(pud.user_id);
    if (orgId && cuid) {
      const tenantId = await tenantIdForOrg(orgId);
      if (tenantId) await deactivateUserByClerkId({ tenantId, clerkUserId: cuid });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Whitelist the webhook in middleware**

In `apps/web/src/middleware.ts`, add `/^\/api\/clerk\/webhook$/` to the `PUBLIC` array.

- [ ] **Step 4: e2e — deactivate path (runs under TEST_MODE, no svix secret → verify allows)**

Create `apps/web/tests/e2e/clerk-webhook.spec.ts`:
```ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, withTenant, tenant, user, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

test("clerk webhook: organizationMembership.deleted deactivates the user", async ({ request }) => {
  // Pin the e2e tenant's clerkOrgId to a known value, then seed a Clerk-backed user.
  const clerkOrgId = `org_e2e_${Date.now()}`;
  await adminDb.update(tenant).set({ clerkOrgId }).where(eq(tenant.id, tenantId));
  const clerkUserId = `user_e2e_${Date.now()}`;
  const userId = await withTenant(tenantId, async (tx) => {
    const [u] = await tx
      .insert(user)
      .values({ tenantId, clerkUserId, name: "Webhook Wendy", email: "w@x.com", role: "rep" })
      .returning();
    return u!.id;
  });

  // No CLERK_WEBHOOK_SECRET in the e2e env → verifySvix allows (dev), so we can POST
  // an unsigned fake event.
  const res = await request.post("/api/clerk/webhook", {
    data: { type: "organizationMembership.deleted", data: { organization: { id: clerkOrgId }, public_user_data: { user_id: clerkUserId } } },
  });
  expect(res.ok()).toBeTruthy();

  const [row] = await withTenant(tenantId, (tx) => tx.select().from(user).where(eq(user.id, userId)));
  expect(row?.deactivatedAt ?? null).not.toBeNull();
});
```

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @savvy/web typecheck
git add apps/web/src/lib/svix.ts apps/web/src/app/api/clerk/webhook/route.ts apps/web/src/middleware.ts apps/web/tests/e2e/clerk-webhook.spec.ts
git commit -m "feat(web): Clerk webhook (svix-verified) for tenant/user sync"
```

---

## Task 6: Sign-in / sign-up / select-org pages

**Files:** Create `apps/web/src/app/sign-in/[[...sign-in]]/page.tsx`, `apps/web/src/app/sign-up/[[...sign-up]]/page.tsx`, `apps/web/src/app/select-org/page.tsx`; modify `apps/web/src/middleware.ts`; update `.env.example`.

- [ ] **Step 1: Auth pages**

Create `apps/web/src/app/sign-in/[[...sign-in]]/page.tsx`:
```tsx
import { SignIn } from "@clerk/nextjs";

export default function Page() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <SignIn />
    </div>
  );
}
```
Create `apps/web/src/app/sign-up/[[...sign-up]]/page.tsx`:
```tsx
import { SignUp } from "@clerk/nextjs";

export default function Page() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <SignUp />
    </div>
  );
}
```
Create `apps/web/src/app/select-org/page.tsx`:
```tsx
import { OrganizationList } from "@clerk/nextjs";

export default function Page() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <OrganizationList afterCreateOrganizationUrl="/dashboard" afterSelectOrganizationUrl="/dashboard" hidePersonal />
    </div>
  );
}
```

- [ ] **Step 2: Whitelist auth routes in middleware**

In `apps/web/src/middleware.ts`, add `/^\/sign-in/`, `/^\/sign-up/`, and `/^\/select-org$/` to the `PUBLIC` array (sign-in/up are catch-all so use a prefix match; select-org needs auth but no org — it must NOT be force-redirected by the (app) layout, and it's outside (app), so just ensure Clerk allows an authed user with no org to view it — leaving it OUT of PUBLIC means clerk requires a session, which is correct; ADD it to PUBLIC only if `auth.protect()` blocks no-org users. Simplest: add `/^\/select-org$/` to PUBLIC so the page always renders for a signed-in user choosing an org).

- [ ] **Step 3: `.env.example`**

Append to `.env.example`:
```
# Clerk auth & provisioning (Phase: production readiness)
CLERK_WEBHOOK_SECRET=
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/dashboard
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/select-org
```

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm --filter @savvy/web typecheck
git add "apps/web/src/app/sign-in" "apps/web/src/app/sign-up" "apps/web/src/app/select-org" apps/web/src/middleware.ts .env.example
git commit -m "feat(web): sign-in/sign-up/select-org pages + clerk env"
```
Expected: typecheck PASS. (`SignIn`/`SignUp`/`OrganizationList` are from `@clerk/nextjs`.)

---

## Task 7: (app) layout auth choke point + chrome

**Files:** Modify `apps/web/src/app/(app)/layout.tsx`, `apps/web/src/components/cockpit/TopBar.tsx`, `apps/web/src/components/cockpit/Sidebar.tsx`.

- [ ] **Step 1: Layout becomes the auth choke point**

Replace `apps/web/src/app/(app)/layout.tsx` with:
```tsx
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { Sidebar } from "@/components/cockpit/Sidebar";
import { TopBar } from "@/components/cockpit/TopBar";
import { AskSage } from "@/components/cockpit/AskSage";
import { getCurrentUser } from "@/lib/current-user";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const authEnabled = process.env.TEST_MODE !== "1";
  if (authEnabled) {
    const { userId, orgId } = await auth();
    if (!userId) redirect("/sign-in");
    if (!orgId) redirect("/select-org");
    await getCurrentUser(); // lazily provision tenant + this user's row
  }
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar authEnabled={authEnabled} />
        <main className="flex-1 p-6">{children}</main>
      </div>
      <AskSage />
    </div>
  );
}
```

- [ ] **Step 2: TopBar renders Clerk chrome when authEnabled**

In `apps/web/src/components/cockpit/TopBar.tsx`: add the import and the prop, and render `<OrganizationSwitcher>` + `<UserButton>` in the right-hand `div` (after the Ask Sage button). Add at top:
```tsx
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
```
Change the signature to `export function TopBar({ authEnabled }: { authEnabled: boolean })` and add, as the last children of the right-side `<div className="flex items-center gap-4">`:
```tsx
        {authEnabled ? (
          <>
            <OrganizationSwitcher hidePersonal afterCreateOrganizationUrl="/dashboard" afterSelectOrganizationUrl="/dashboard" />
            <UserButton />
          </>
        ) : null}
```
(TopBar is already `"use client"`; the Clerk components render client-side. When `authEnabled` is false — TEST_MODE — neither renders, so no ClerkProvider is needed.)

- [ ] **Step 3: Team nav item**

In `apps/web/src/components/cockpit/Sidebar.tsx`, add to the `NAV` array (after the settings items):
```ts
  { href: "/settings/team", label: "Team" },
```

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm --filter @savvy/web typecheck
git add "apps/web/src/app/(app)/layout.tsx" apps/web/src/components/cockpit/TopBar.tsx apps/web/src/components/cockpit/Sidebar.tsx
git commit -m "feat(web): (app) auth choke point + Clerk chrome + Team nav"
```
Expected: typecheck PASS.

- [ ] **Step 5: Wave 1 gate (sanity)**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Expected: all green (Wave 1 is independently shippable here if desired).

---

# WAVE 2 — Team management

## Task 8: Team queries + actions

**Files:** Create `apps/web/src/lib/team-queries.ts`, `apps/web/src/lib/team-actions.ts`.

- [ ] **Step 1: Team query**

Create `apps/web/src/lib/team-queries.ts`:
```ts
import "server-only";
import { withTenant, user, asc, eq } from "@savvy/db";
import { getTenantId } from "./tenant";

export type TeamMember = {
  id: string; name: string; email: string; role: string;
  isClerkBacked: boolean; deactivated: boolean; hasPin: boolean;
};

export async function listTeam(): Promise<TeamMember[]> {
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({
      id: user.id, name: user.name, email: user.email, role: user.role,
      clerkUserId: user.clerkUserId, deactivatedAt: user.deactivatedAt, pinHash: user.pinHash,
    }).from(user).orderBy(asc(user.name)),
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, email: r.email, role: r.role,
    isClerkBacked: r.clerkUserId !== null,
    deactivated: r.deactivatedAt !== null,
    hasPin: r.pinHash !== null,
  }));
}
```

- [ ] **Step 2: Team actions**

Create `apps/web/src/lib/team-actions.ts`:
```ts
"use server";
import { withTenant, user, eq, and } from "@savvy/db";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";
import { isOrgAdmin } from "./authz";
import type { UserRole } from "@savvy/core";

const CLERK_ROLE = (r: UserRole): "org:admin" | "org:member" =>
  r === "owner" || r === "admin" ? "org:admin" : "org:member";

export async function inviteMember(email: string, role: UserRole): Promise<{ ok: true } | { error: string }> {
  if (!(await isOrgAdmin())) return { error: "forbidden" };
  const { orgId } = await auth();
  if (!orgId) return { error: "no organization" };
  try {
    const cc = await clerkClient();
    await cc.organizations.createOrganizationInvitation({ organizationId: orgId, emailAddress: email, role: CLERK_ROLE(role) });
    return { ok: true };
  } catch {
    return { error: "could not send invite" };
  }
}

export async function changeUserRole(userId: string, role: UserRole): Promise<{ ok: true } | { error: string }> {
  if (!(await isOrgAdmin())) return { error: "forbidden" };
  const tenantId = await getTenantId();
  const { orgId } = await auth();
  const target = await withTenant(tenantId, async (tx) => {
    const [u] = await tx.select({ id: user.id, clerkUserId: user.clerkUserId }).from(user).where(eq(user.id, userId));
    return u ?? null;
  });
  if (!target) return { error: "not found" };
  try {
    if (target.clerkUserId && orgId) {
      const cc = await clerkClient();
      await cc.organizations.updateOrganizationMembership({ organizationId: orgId, userId: target.clerkUserId, role: CLERK_ROLE(role) });
    }
    await withTenant(tenantId, (tx) => tx.update(user).set({ role }).where(eq(user.id, userId)));
    revalidatePath("/settings/team");
    return { ok: true };
  } catch {
    return { error: "could not change role" };
  }
}

export async function removeMember(userId: string): Promise<{ ok: true } | { error: string }> {
  if (!(await isOrgAdmin())) return { error: "forbidden" };
  const tenantId = await getTenantId();
  const { orgId } = await auth();
  const target = await withTenant(tenantId, async (tx) => {
    const [u] = await tx.select({ id: user.id, clerkUserId: user.clerkUserId }).from(user).where(eq(user.id, userId));
    return u ?? null;
  });
  if (!target) return { error: "not found" };
  try {
    if (target.clerkUserId && orgId) {
      const cc = await clerkClient();
      await cc.organizations.deleteOrganizationMembership({ organizationId: orgId, userId: target.clerkUserId });
    }
    await withTenant(tenantId, (tx) => tx.update(user).set({ deactivatedAt: new Date() }).where(eq(user.id, userId)));
    revalidatePath("/settings/team");
    return { ok: true };
  } catch {
    return { error: "could not remove member" };
  }
}

export async function addCrewMember(name: string): Promise<{ ok: true; id: string } | { error: string }> {
  if (!(await isOrgAdmin())) return { error: "forbidden" };
  if (!name.trim()) return { error: "name required" };
  const tenantId = await getTenantId();
  const id = await withTenant(tenantId, async (tx) => {
    const [u] = await tx.insert(user).values({
      tenantId, name: name.trim(), email: "", role: "crew", clerkUserId: null,
    }).returning({ id: user.id });
    return u!.id;
  });
  revalidatePath("/settings/team");
  return { ok: true, id };
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm --filter @savvy/web typecheck
git add apps/web/src/lib/team-queries.ts apps/web/src/lib/team-actions.ts
git commit -m "feat(web): team queries + actions (invite/role/remove/add-crew)"
```
Expected: typecheck PASS. (`asc` is re-exported from `@savvy/db`. Clerk v6 `createOrganizationInvitation`/`updateOrganizationMembership`/`deleteOrganizationMembership` shapes — verify; adapt minimally if a param name differs and report. `user.email` is notNull, so addCrewMember sets `""`.)

---

## Task 9: Team management UI

**Files:** Create `apps/web/src/app/(app)/settings/team/page.tsx`, `apps/web/src/app/(app)/settings/team/TeamManager.tsx`.

- [ ] **Step 1: Server page (admin-gated)**

Create `apps/web/src/app/(app)/settings/team/page.tsx`:
```tsx
import { listTeam } from "@/lib/team-queries";
import { listCrewUsers } from "@/lib/crew-admin-actions";
import { isOrgAdmin } from "@/lib/authz";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { TeamManager } from "./TeamManager";

export const dynamic = "force-dynamic";

export default async function TeamSettingsPage() {
  if (!(await isOrgAdmin())) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Settings" title="Team" />
        <p className="text-sm" style={{ color: "var(--text-faint)" }} data-testid="team-forbidden">Admins only.</p>
      </div>
    );
  }
  const team = await listTeam();
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Settings" title="Team" />
      <TeamManager team={team} />
    </div>
  );
}
```

- [ ] **Step 2: Client manager**

Create `apps/web/src/app/(app)/settings/team/TeamManager.tsx`:
```tsx
"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { inviteMember, changeUserRole, removeMember, addCrewMember } from "@/lib/team-actions";
import { setCrewPin } from "@/lib/crew-admin-actions";
import type { UserRole } from "@savvy/core";

type Member = { id: string; name: string; email: string; role: string; isClerkBacked: boolean; deactivated: boolean; hasPin: boolean };
const ROLES = ["owner", "admin", "rep", "office", "crew"] as const;

export function TeamManager({ team }: { team: Member[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("rep");
  const [crewName, setCrewName] = useState("");
  const [pins, setPins] = useState<Record<string, string>>({});

  function run(fn: () => Promise<{ ok: true } | { ok: true; id: string } | { error: string }>, okMsg: string) {
    start(async () => {
      const r = await fn();
      if ("error" in r) { toast.error(r.error); return; }
      toast.success(okMsg);
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <div className="eyebrow mb-2">Invite teammate</div>
        <div className="flex flex-wrap items-center gap-2">
          <Input placeholder="email@company.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} className="w-64" />
          <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} data-testid="invite-role"
            className="mono rounded-md border border-white/10 bg-transparent px-2 py-1.5 text-sm">
            <option value="admin">admin</option>
            <option value="rep">rep</option>
          </select>
          <Button disabled={pending} data-testid="invite-submit"
            onClick={() => run(() => inviteMember(inviteEmail, inviteRole as UserRole), "Invite sent")}>Invite</Button>
        </div>
      </Card>

      <Card className="p-4">
        <div className="eyebrow mb-2">Add crew member (PIN-only, no login)</div>
        <div className="flex flex-wrap items-center gap-2">
          <Input placeholder="Crew member name" value={crewName} onChange={(e) => setCrewName(e.target.value)} className="w-64" />
          <Button disabled={pending} data-testid="add-crew-submit"
            onClick={() => run(async () => { const r = await addCrewMember(crewName); if ("ok" in r) setCrewName(""); return r; }, "Crew member added")}>Add crew</Button>
        </div>
      </Card>

      <Card className="divide-y divide-white/5 p-0">
        {team.map((m) => (
          <div key={m.id} className="flex flex-wrap items-center gap-3 p-4" data-testid="team-row" data-user-id={m.id}
            style={{ opacity: m.deactivated ? 0.5 : 1 }}>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{m.name} {m.deactivated ? "· (removed)" : ""}</div>
              <div className="mono text-xs" style={{ color: "var(--text-muted)" }}>
                {m.email || (m.isClerkBacked ? "—" : "crew · no login")} · {m.role}
              </div>
            </div>
            {!m.deactivated && (
              <>
                <select value={m.role} disabled={pending} data-testid="role-select"
                  onChange={(e) => run(() => changeUserRole(m.id, e.target.value as UserRole), "Role updated")}
                  className="mono rounded-md border border-white/10 bg-transparent px-2 py-1.5 text-sm">
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                {!m.isClerkBacked && (
                  <Input placeholder={m.hasPin ? "reset PIN" : "set PIN"} value={pins[m.id] ?? ""}
                    onChange={(e) => setPins((p) => ({ ...p, [m.id]: e.target.value }))} className="w-24"
                    onBlur={() => { const pin = pins[m.id]; if (pin) run(() => setCrewPin(m.id, pin), "PIN set"); }} />
                )}
                <Button variant="outline" disabled={pending} data-testid="remove-member"
                  onClick={() => run(() => removeMember(m.id), "Removed")}>Remove</Button>
              </>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}
```
- [ ] **Step 3: Typecheck + commit**

```bash
pnpm --filter @savvy/web typecheck
git add "apps/web/src/app/(app)/settings/team"
git commit -m "feat(web): team management UI"
```
Expected: typecheck PASS.

---

## Task 10: e2e — team management (app-only paths)

**Files:** Create `apps/web/tests/e2e/team.spec.ts`.

- [ ] **Step 1: Write the spec**

Create `apps/web/tests/e2e/team.spec.ts`:
```ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, user, eq, and, isNull } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

// TEST_MODE: isOrgAdmin() returns true, so the team page + actions are reachable.
// Only the app-only paths (add crew, change crew role, remove crew) are exercised — the
// Clerk-backed invite/role/remove paths need a Clerk instance (manual checklist).

test("team: add crew member, change role, remove → deactivated + drops from assignees", async ({ page }) => {
  await page.goto("/settings/team");
  await expect(page.getByRole("heading", { name: "Team" })).toBeVisible();

  // Add a crew member.
  await page.getByPlaceholder("Crew member name").fill("E2E Cody");
  await page.getByTestId("add-crew-submit").click();
  const row = page.locator('[data-testid="team-row"]', { hasText: "E2E Cody" });
  await expect(row).toBeVisible();

  // Resolve the new user id from the DB.
  const u = await withTenant(tenantId, (tx) =>
    tx.select({ id: user.id }).from(user).where(and(eq(user.name, "E2E Cody"), isNull(user.deactivatedAt))));
  expect(u.length).toBe(1);
  const userId = u[0]!.id;

  // Change role to office.
  await row.getByTestId("role-select").selectOption("office");
  await expect(async () => {
    const [r] = await withTenant(tenantId, (tx) => tx.select().from(user).where(eq(user.id, userId)));
    expect(r?.role).toBe("office");
  }).toPass({ timeout: 8000 });

  // Remove → deactivated.
  await row.getByTestId("remove-member").click();
  await expect(async () => {
    const [r] = await withTenant(tenantId, (tx) => tx.select().from(user).where(eq(user.id, userId)));
    expect(r?.deactivatedAt ?? null).not.toBeNull();
  }).toPass({ timeout: 8000 });
});
```

- [ ] **Step 2: Commit (the run happens in Task 11's full e2e pass)**

```bash
git add apps/web/tests/e2e/team.spec.ts
git commit -m "test(web): team management e2e (app-only paths)"
```

---

## Task 11: Full gate + manual checklist + PR

- [ ] **Step 1: Full gate**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Expected: typecheck + lint clean (pre-existing warnings OK); all vitest suites green (new `clerk-role` + `provisioning` tests included). Report the test count.

- [ ] **Step 2: e2e (the new specs + a sanity pass on existing crew/companycam)**

Ensure nothing stale on :3000, then run the standard e2e bring-up (ai-stub + inngest-cli + create-tenant + playwright) and run:
```bash
pnpm --filter @savvy/web exec playwright test team.spec.ts clerk-webhook.spec.ts crew.spec.ts
```
Expected: all PASS. (Reuse the bring-up commands from the prior phases' Task-17 step.)

- [ ] **Step 3: Manual verification checklist (Clerk dev instance — document in the PR, can't run under TEST_MODE)**

Append this checklist to the PR body for whoever has Clerk dev keys:
- [ ] Real sign-up at `/sign-up` → create an org via the OrganizationSwitcher/select-org → `/dashboard` loads (no 500); a `tenant` row + an `owner` `user` row exist.
- [ ] Invite a teammate (admin role) from `/settings/team` → they accept + sign in → a `user` row with role `admin` appears (and Clerk org role is `org:admin`).
- [ ] Change a Clerk user's role rep→admin in `/settings/team` → both Clerk membership role and `user.role` update.
- [ ] Remove a Clerk user → Clerk membership gone + `user.deactivatedAt` set + they drop from the lead-assignee dropdown.
- [ ] Configure the Clerk webhook (`/api/clerk/webhook`, `CLERK_WEBHOOK_SECRET`) → delete a membership in Clerk while the user is offline → row deactivates via webhook.

- [ ] **Step 4: Push + PR (base main)**

```bash
git push -u origin feat/auth-provisioning
gh pr create --base main --title "feat: auth & provisioning (Clerk sign-in, lazy + webhook tenant/user sync, team mgmt)" --body "First production-readiness slice. Real Clerk sign-in/sign-up + org create; lazy provisioning (getTenantId/getCurrentUser) backed by ensureTenantForOrg/ensureUser + a svix-verified Clerk webhook; in-app team management (invite/role/remove/add-crew). Migration 0013 (user.deactivatedAt + clerk-user unique index). TEST_MODE retained for e2e; Clerk-API paths covered by the manual checklist below. Spec: docs/superpowers/specs/2026-06-18-auth-provisioning-design.md"
```
(Include the Step 3 manual checklist in the PR body.)

---

## Self-Review notes (resolved during planning)
- **Spec coverage:** ensure helpers (T3) ✓; mapClerkRole (T2) ✓; schema deactivatedAt + unique index + deactivated filtering (T1) ✓; lazy getTenantId/getCurrentUser (T4) ✓; webhook (T5) ✓; sign-in/up/select-org + middleware (T6) ✓; layout choke point + authEnabled + chrome + Team nav (T7) ✓; team queries/actions/UI (T8/T9) ✓; e2e (T5/T10) + manual checklist (T11) ✓; .env (T6) ✓.
- **No new deps:** svix verified manually (`svix.ts`), publicKey via `crypto.randomBytes`.
- **TEST_MODE coherence:** layout skips auth + getCurrentUser under TEST_MODE; isOrgAdmin already bypasses; team e2e exercises only app-only paths.
- **Role stickiness:** `ensureUser` never demotes owner/office/crew — prevents the webhook/lazy sync from clobbering app-assigned roles; unit-tested in T3.
- **Type consistency:** `UserRole` (added T2) used by provisioning (T3), team-actions/UI (T8/T9); `ensureTenantForOrg`/`ensureUser`/`deactivateUserByClerkId` signatures stable across T3→T4→T5→T8.
- **Waves:** Wave 1 (T1–T7) is independently shippable (a customer can sign in + get provisioned); Wave 2 (T8–T10) adds team management. Could be two PRs if preferred.
