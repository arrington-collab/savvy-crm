# Phase 6D — CompanyCam + Crew Check-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a PIN-authed crew field surface (check in/out + photo upload) and a CompanyCam integration (link a job to a CompanyCam project; ingest photos by reference), both surfaced as agent activity (MILO / SCOUT).

**Architecture:** Crew actions derive `tenantId` from a signed httpOnly cookie (NOT Clerk) and write through `withTenant`. The CompanyCam webhook (no session) resolves tenant via `adminDb` by the job's `companycamProjectId`, then writes through `withTenant` (the `markEsignBySubmission` pattern). Photos are referenced by URL (`document.externalUrl`), not copied to R2. New activity is logged via `recordAgentRun(agent='scheduling', ...)` and rendered by a one-line `resolveAgent` branch.

**Tech Stack:** Next.js 16 (App Router), Drizzle/Postgres (RLS via `withTenant`), Nango (CompanyCam OAuth), `node:crypto` (scrypt PIN + HMAC), vitest (packages) + Playwright (apps/web e2e).

**Spec:** `docs/superpowers/specs/2026-06-17-phase6d-companycam-crew-design.md`

---

## Conventions (read first)
- **Branch:** work on `feat/phase6d-companycam-crew` (already created off `origin/main`; spec already committed there).
- **DB env for tests/dev:**
  ```bash
  export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
  export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
  ```
- **Import extensions:** `packages/*` SOURCE files import WITHOUT `.js`; `packages/*` TEST files import WITH `.js`. `apps/web` source: NO `.js`.
- **`@savvy/db`** re-exports all schema tables + drizzle operators (`eq, and, or, isNull, inArray, desc, sql, ...`). Import from `@savvy/db`, never `drizzle-orm`.
- **`@savvy/db` lifecycle Tx type:** `type Tx = Parameters<Parameters<typeof import("../client").db.transaction>[0]>[0];` (type-only import form, as in `stop-drip.ts`).
- **apps/web is Playwright-only** (vitest excludes it). Keep web query/action helpers thin; cover via e2e. Unit/integration-test logic lives in `@savvy/core` (pure) / `@savvy/db` (integration).
- **DB query modules** (read helpers) start with `import "server-only";`. **Server actions** start with `"use server";`. The two cannot coexist in one module a client imports.
- **`noUncheckedIndexedAccess` ON** — use `!`/`?.` deliberately.
- **Migrations:** `pnpm --filter @savvy/db db:generate` produces the next numbered SQL from the schema diff; `pnpm --filter @savvy/db db:migrate` applies it AND re-applies `rls-grants.sql` (which `GRANT`s on ALL tables, so new tables are auto-covered — no manual grant edit).

## File Structure
| File | Responsibility |
|------|----------------|
| `packages/db/src/schema/ops.ts` | + `crewCheckin` table; alter `document` (+`externalUrl`,+`companycamPhotoId`, `r2Key` nullable) |
| `packages/db/src/schema/jobs.ts` | alter `job` (+`companycamProjectId`) |
| `packages/db/src/schema/tenancy.ts` | alter `user` (+`pinHash`), `tenant` (+`companycamConnectionId`) |
| `packages/db/drizzle/0011_*.sql` | generated migration |
| `packages/db/src/lifecycle/crew-checkin.ts` (+test) | `openCheckIn`/`closeCheckIn` |
| `packages/db/src/lifecycle/companycam.ts` (+test) | `recordCompanyCamPhoto` |
| `packages/core/src/crew-pin.ts` (+test) | `hashPin`/`verifyPin` |
| `packages/integrations/src/companycam.ts` (+test) | `CompanyCamGateway` + `companyCam`/`makeFakeCompanyCam` |
| `apps/web/src/lib/crew-session.ts` | cookie read/set/clear + `getCrewSession` |
| `apps/web/src/lib/crew-actions.ts` | `crewLogin/crewLogout/crewCheckIn/crewCheckOut/crewPresignPhoto/crewRecordPhoto` |
| `apps/web/src/lib/crew-queries.ts` | `listCrewJobs`/`getCrewJob` (server-only) |
| `apps/web/src/app/(crew)/crew/[key]/...` | PIN entry, jobs list, job view + client bits |
| `apps/web/src/lib/companycam-actions.ts` | `saveCompanyCamConnection`/`linkCompanyCamProject` |
| `apps/web/src/app/api/companycam/webhook/route.ts` | inbound photo webhook |
| `apps/web/src/lib/crew-admin-actions.ts` | `setCrewPin` + `listCrewUsers` |
| `apps/web/src/app/(app)/settings/crew/...` | PIN management UI |
| `apps/web/src/lib/agents.ts` | `resolveAgent` photo.* branch |
| job detail Docs tab + e2e specs | render externalUrl + check-in strip; `crew.spec.ts`, `companycam.spec.ts` |

---

## Task 1: Schema changes + migration 0011

**Files:** Modify `packages/db/src/schema/ops.ts`, `jobs.ts`, `tenancy.ts`; generate `packages/db/drizzle/0011_*.sql`.

- [ ] **Step 1: Add the `crewCheckin` table + alter `document` in `ops.ts`**

In `packages/db/src/schema/ops.ts`, the `document` table currently has `r2Key: text("r2_key").notNull(),`. Change that line to nullable and add two columns right after `source`:

```ts
  r2Key: text("r2_key"),
```
and after the `source: text("source")...` line, add:
```ts
  externalUrl: text("external_url"),                 // CompanyCam-hosted URL (source='companycam')
  companycamPhotoId: text("companycam_photo_id"),    // dedupe key for the CompanyCam webhook
```

Then append a new table at the end of the file (before any trailing exports), using the existing helpers already imported in this file (`idCol`, `createdAt`, `tenantIsolation`, `tenant`, `job`, `user`) and adding `doublePrecision` to the `drizzle-orm/pg-core` import at the top:

```ts
export const crewCheckin = pgTable("crew_checkin", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  crewUserId: uuid("crew_user_id").notNull().references(() => user.id),
  checkedInAt: timestamp("checked_in_at", { withTimezone: true }).defaultNow().notNull(),
  checkInLat: doublePrecision("check_in_lat"),
  checkInLng: doublePrecision("check_in_lng"),
  checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
  checkOutLat: doublePrecision("check_out_lat"),
  checkOutLng: doublePrecision("check_out_lng"),
  createdAt: createdAt(),
}, (t) => [index("crew_checkin_tenant_job_idx").on(t.tenantId, t.jobId), tenantIsolation()]);
```
(Top-of-file import becomes: `import { pgTable, uuid, text, integer, jsonb, index, timestamp, uniqueIndex, doublePrecision } from "drizzle-orm/pg-core";`)

- [ ] **Step 2: Alter `job` in `jobs.ts`**

In `packages/db/src/schema/jobs.ts`, add to the `job` table (e.g. after `leadId`):
```ts
  companycamProjectId: text("companycam_project_id"),
```

- [ ] **Step 3: Alter `user` and `tenant` in `tenancy.ts`**

In `packages/db/src/schema/tenancy.ts`, add to `user` (after `gcalConnectionId`):
```ts
  pinHash: text("pin_hash"),
```
and to `tenant` (alongside `qboConnectionId`):
```ts
  companycamConnectionId: text("companycam_connection_id"),
```

- [ ] **Step 4: Generate the migration**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm --filter @savvy/db db:generate
```
Expected: a new `packages/db/drizzle/0011_*.sql`. Open it and confirm it contains: `CREATE TABLE "crew_checkin"` + its `CREATE POLICY "tenant_isolation"`; `ALTER TABLE "document" ... ADD COLUMN "external_url"` + `"companycam_photo_id"` + `ALTER COLUMN "r2_key" DROP NOT NULL`; `ALTER TABLE "job" ADD COLUMN "companycam_project_id"`; `ALTER TABLE "user" ADD COLUMN "pin_hash"`; `ALTER TABLE "tenant" ADD COLUMN "companycam_connection_id"`. If `DROP NOT NULL` is missing, add this line by hand to the generated SQL: `ALTER TABLE "document" ALTER COLUMN "r2_key" DROP NOT NULL;`

- [ ] **Step 5: Apply + typecheck**

```bash
docker compose up -d
pnpm --filter @savvy/db db:migrate
pnpm --filter @savvy/db typecheck
```
Expected: `migrations + grants applied`; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema packages/db/drizzle
git commit -m "feat(db): 6D schema — crew_checkin + document/job/user/tenant alters (migration 0011)"
```

---

## Task 2: Crew PIN hashing (`@savvy/core`)

**Files:** Create `packages/core/src/crew-pin.ts`, `packages/core/src/crew-pin.test.ts`; modify `packages/core/src/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/crew-pin.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { hashPin, verifyPin } from "./crew-pin.js";

describe("crew-pin", () => {
  it("verifies a correct pin and rejects a wrong one", () => {
    const stored = hashPin("4821");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(verifyPin("4821", stored)).toBe(true);
    expect(verifyPin("0000", stored)).toBe(false);
  });
  it("rejects null/garbage stored values", () => {
    expect(verifyPin("4821", null)).toBe(false);
    expect(verifyPin("4821", "garbage")).toBe(false);
    expect(verifyPin("4821", "scrypt$abc")).toBe(false);
  });
  it("produces a different salt each call", () => {
    expect(hashPin("4821")).not.toBe(hashPin("4821"));
  });
});
```

- [ ] **Step 2: Run it (fails — module missing)**

```bash
pnpm --filter @savvy/core exec vitest run src/crew-pin.test.ts
```
Expected: FAIL (cannot find `./crew-pin.js`).

- [ ] **Step 3: Implement**

Create `packages/core/src/crew-pin.ts`:
```ts
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

/** `scrypt$<saltHex>$<hashHex>`. Synchronous — fine for low-volume PIN checks. */
export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPin(pin: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = scryptSync(pin, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

- [ ] **Step 4: Export from the barrel**

In `packages/core/src/index.ts`, add after the last `export * from` line:
```ts
export * from "./crew-pin";
```

- [ ] **Step 5: Run the test (passes)**

```bash
pnpm --filter @savvy/core exec vitest run src/crew-pin.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/crew-pin.ts packages/core/src/crew-pin.test.ts packages/core/src/index.ts
git commit -m "feat(core): crew PIN hash/verify (scrypt)"
```

---

## Task 3: Crew check-in lifecycle (`@savvy/db`)

**Files:** Create `packages/db/src/lifecycle/crew-checkin.ts`, `packages/db/src/lifecycle/crew-checkin.test.ts`; modify `packages/db/src/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/lifecycle/crew-checkin.test.ts`:
```ts
import { afterAll, describe, it, expect } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { withTenant } from "../tenant.js";
import { crewCheckin, customer, property, job, user, tenant } from "../schema/index.js";
import { openCheckIn, closeCheckIn } from "./crew-checkin.js";

const tenantIds: string[] = [];
async function seed() {
  const [t] = await adminDb.insert(tenant).values({
    name: "Crew", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
  }).returning();
  tenantIds.push(t!.id);
  return withTenant(t!.id, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
    const [p] = await tx.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "1 St" }).returning();
    const [j] = await tx.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
    const [u] = await tx.insert(user).values({ tenantId: t!.id, name: "Crew Cody", email: `cody-${crypto.randomUUID()}@x.com`, role: "crew" }).returning();
    return { tenantId: t!.id, jobId: j!.id, crewUserId: u!.id };
  });
}

afterAll(async () => {
  if (tenantIds.length) {
    await adminDb.delete(crewCheckin).where(inArray(crewCheckin.tenantId, tenantIds));
    await adminDb.delete(job).where(inArray(job.tenantId, tenantIds));
    await adminDb.delete(user).where(inArray(user.tenantId, tenantIds));
    await adminDb.delete(property).where(inArray(property.tenantId, tenantIds));
    await adminDb.delete(customer).where(inArray(customer.tenantId, tenantIds));
    await adminDb.delete(tenant).where(inArray(tenant.id, tenantIds));
  }
  await pool.end();
  await adminPool.end();
});

describe("crew check-in lifecycle", () => {
  it("opens once (idempotent) then closes", async () => {
    const { tenantId, jobId, crewUserId } = await seed();
    const a = await withTenant(tenantId, (tx) => openCheckIn(tx, { tenantId, jobId, crewUserId, lat: 33.4, lng: -112.0 }));
    expect(a.reused).toBe(false);
    const b = await withTenant(tenantId, (tx) => openCheckIn(tx, { tenantId, jobId, crewUserId }));
    expect(b.reused).toBe(true);
    expect(b.id).toBe(a.id);
    const closed = await withTenant(tenantId, (tx) => closeCheckIn(tx, { tenantId, jobId, crewUserId }));
    expect(closed?.id).toBe(a.id);
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(crewCheckin).where(eq(crewCheckin.id, a.id)));
    expect(row!.checkedOutAt).not.toBeNull();
    expect(row!.checkInLat).toBe(33.4);
  });
  it("close with no open row is a no-op", async () => {
    const { tenantId, jobId, crewUserId } = await seed();
    const r = await withTenant(tenantId, (tx) => closeCheckIn(tx, { tenantId, jobId, crewUserId }));
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Run it (fails)**

```bash
pnpm --filter @savvy/db exec vitest run src/lifecycle/crew-checkin.test.ts
```
Expected: FAIL (cannot find `./crew-checkin.js`).

- [ ] **Step 3: Implement**

Create `packages/db/src/lifecycle/crew-checkin.ts`:
```ts
import { and, eq, isNull, desc } from "drizzle-orm";
import { crewCheckin } from "../schema/index";

type Tx = Parameters<Parameters<typeof import("../client").db.transaction>[0]>[0];

type Loc = { lat?: number | null; lng?: number | null };
type Key = { tenantId: string; jobId: string; crewUserId: string };

async function findOpen(tx: Tx, k: Key) {
  const [row] = await tx
    .select({ id: crewCheckin.id })
    .from(crewCheckin)
    .where(and(
      eq(crewCheckin.tenantId, k.tenantId),
      eq(crewCheckin.jobId, k.jobId),
      eq(crewCheckin.crewUserId, k.crewUserId),
      isNull(crewCheckin.checkedOutAt),
    ))
    .orderBy(desc(crewCheckin.checkedInAt))
    .limit(1);
  return row;
}

/** Opens a check-in; returns the existing open row if one exists (idempotent). */
export async function openCheckIn(tx: Tx, opts: Key & Loc): Promise<{ id: string; reused: boolean }> {
  const open = await findOpen(tx, opts);
  if (open) return { id: open.id, reused: true };
  const [row] = await tx.insert(crewCheckin).values({
    tenantId: opts.tenantId, jobId: opts.jobId, crewUserId: opts.crewUserId,
    checkInLat: opts.lat ?? null, checkInLng: opts.lng ?? null,
  }).returning({ id: crewCheckin.id });
  return { id: row!.id, reused: false };
}

/** Closes the latest open check-in; no-op (null) if none open. */
export async function closeCheckIn(tx: Tx, opts: Key & Loc): Promise<{ id: string } | null> {
  const open = await findOpen(tx, opts);
  if (!open) return null;
  await tx.update(crewCheckin).set({
    checkedOutAt: new Date(), checkOutLat: opts.lat ?? null, checkOutLng: opts.lng ?? null,
  }).where(eq(crewCheckin.id, open.id));
  return { id: open.id };
}
```

- [ ] **Step 4: Barrel export**

In `packages/db/src/index.ts`, add:
```ts
export { openCheckIn, closeCheckIn } from "./lifecycle/crew-checkin";
```

- [ ] **Step 5: Run the test (passes)**

```bash
pnpm --filter @savvy/db exec vitest run src/lifecycle/crew-checkin.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/crew-checkin.ts packages/db/src/lifecycle/crew-checkin.test.ts packages/db/src/index.ts
git commit -m "feat(db): crew check-in open/close lifecycle"
```

---

## Task 4: CompanyCam photo ingest lifecycle (`@savvy/db`)

**Files:** Create `packages/db/src/lifecycle/companycam.ts`, `packages/db/src/lifecycle/companycam.test.ts`; modify `packages/db/src/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/lifecycle/companycam.test.ts`:
```ts
import { afterAll, describe, it, expect } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { withTenant } from "../tenant.js";
import { document, customer, property, job, tenant } from "../schema/index.js";
import { recordCompanyCamPhoto } from "./companycam.js";

const tenantIds: string[] = [];
async function seedJob(projectId: string) {
  const [t] = await adminDb.insert(tenant).values({
    name: "CC", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
  }).returning();
  tenantIds.push(t!.id);
  return withTenant(t!.id, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
    const [p] = await tx.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "1 St" }).returning();
    const [j] = await tx.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production", companycamProjectId: projectId }).returning();
    return { tenantId: t!.id, jobId: j!.id };
  });
}
afterAll(async () => {
  if (tenantIds.length) {
    await adminDb.delete(document).where(inArray(document.tenantId, tenantIds));
    await adminDb.delete(job).where(inArray(job.tenantId, tenantIds));
    await adminDb.delete(property).where(inArray(property.tenantId, tenantIds));
    await adminDb.delete(customer).where(inArray(customer.tenantId, tenantIds));
    await adminDb.delete(tenant).where(inArray(tenant.id, tenantIds));
  }
  await pool.end();
  await adminPool.end();
});

describe("recordCompanyCamPhoto", () => {
  it("inserts a companycam document and dedupes by photoId", async () => {
    const projectId = `proj-${crypto.randomUUID()}`;
    const { tenantId, jobId } = await seedJob(projectId);
    const photoId = "photo-1";
    const a = await recordCompanyCamPhoto({ projectId, photoId, url: "https://cc/p1.jpg" });
    expect(a?.created).toBe(true);
    expect(a?.jobId).toBe(jobId);
    const b = await recordCompanyCamPhoto({ projectId, photoId, url: "https://cc/p1.jpg" });
    expect(b?.created).toBe(false);
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(document).where(and(eq(document.jobId, jobId), eq(document.source, "companycam"))));
    expect(rows.length).toBe(1);
    expect(rows[0]!.externalUrl).toBe("https://cc/p1.jpg");
    expect(rows[0]!.r2Key).toBeNull();
  });
  it("returns null for an unknown project", async () => {
    const r = await recordCompanyCamPhoto({ projectId: "nope", photoId: "x", url: "u" });
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Run it (fails)**

```bash
pnpm --filter @savvy/db exec vitest run src/lifecycle/companycam.test.ts
```
Expected: FAIL (cannot find `./companycam.js`).

- [ ] **Step 3: Implement**

Create `packages/db/src/lifecycle/companycam.ts`:
```ts
import { and, eq } from "drizzle-orm";
import { job, document } from "../schema/index";
import { withTenant } from "../tenant";
import { adminDb } from "../admin-client";

/**
 * Webhook-side: resolve the job by its CompanyCam project id (globally-meaningful,
 * adminDb), then insert a `source='companycam'` document referencing the photo URL.
 * Idempotent: dedupes by (jobId, companycamPhotoId). Unknown project -> null.
 */
export async function recordCompanyCamPhoto(input: {
  projectId: string; photoId: string; url: string; capturedAt?: string | null;
}): Promise<{ tenantId: string; jobId: string; documentId: string; created: boolean } | null> {
  const [j] = await adminDb
    .select({ id: job.id, tenantId: job.tenantId, customerId: job.customerId })
    .from(job)
    .where(eq(job.companycamProjectId, input.projectId));
  if (!j) return null;
  return withTenant(j.tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: document.id })
      .from(document)
      .where(and(eq(document.jobId, j.id), eq(document.companycamPhotoId, input.photoId)));
    if (existing) return { tenantId: j.tenantId, jobId: j.id, documentId: existing.id, created: false };
    const [row] = await tx.insert(document).values({
      tenantId: j.tenantId, jobId: j.id, customerId: j.customerId,
      kind: "photo", source: "companycam", externalUrl: input.url, companycamPhotoId: input.photoId,
    }).returning({ id: document.id });
    return { tenantId: j.tenantId, jobId: j.id, documentId: row!.id, created: true };
  });
}
```

- [ ] **Step 4: Barrel export**

In `packages/db/src/index.ts`, add:
```ts
export { recordCompanyCamPhoto } from "./lifecycle/companycam";
```

- [ ] **Step 5: Run the test (passes)**

```bash
pnpm --filter @savvy/db exec vitest run src/lifecycle/companycam.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/companycam.ts packages/db/src/lifecycle/companycam.test.ts packages/db/src/index.ts
git commit -m "feat(db): recordCompanyCamPhoto ingest-by-reference"
```

---

## Task 5: CompanyCam gateway (`@savvy/integrations`)

**Files:** Create `packages/integrations/src/companycam.ts`, `packages/integrations/src/companycam.test.ts`; modify `packages/integrations/src/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/integrations/src/companycam.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { httpCompanyCam, makeFakeCompanyCam } from "./companycam.js";

describe("companycam gateway", () => {
  it("fake parses a simple event and verifies open (no secret)", async () => {
    const cc = makeFakeCompanyCam();
    expect(cc.verifyWebhook("{}", null)).toBe(true);
    const ev = cc.parseEvent({ projectId: "p1", photoId: "ph1", url: "https://cc/x.jpg" });
    expect(ev).toEqual({ type: "photo.created", projectId: "p1", photoId: "ph1", url: "https://cc/x.jpg" });
    expect(cc.parseEvent({ projectId: "p1" })).toBeNull();
    const got = await cc.getPhoto({ connectionId: "c", photoId: "ph1" });
    expect(got.url).toContain("ph1");
    expect(cc.calls.some((c) => c.op === "getPhoto")).toBe(true);
  });
  it("http verifyWebhook allows when no secret is set, parses nested shape", () => {
    delete process.env.COMPANYCAM_WEBHOOK_SECRET;
    expect(httpCompanyCam.verifyWebhook("{}", null)).toBe(true);
    const ev = httpCompanyCam.parseEvent({
      type: "photo.created",
      data: { photo: { id: "9", project_id: "7", uris: [{ type: "original", uri: "https://cc/o.jpg" }] } },
    });
    expect(ev).toEqual({ type: "photo.created", projectId: "7", photoId: "9", url: "https://cc/o.jpg", capturedAt: undefined });
  });
});
```

- [ ] **Step 2: Run it (fails)**

```bash
pnpm --filter @savvy/integrations exec vitest run src/companycam.test.ts
```
Expected: FAIL (cannot find `./companycam.js`).

- [ ] **Step 3: Implement**

Create `packages/integrations/src/companycam.ts`:
```ts
import { createHmac } from "node:crypto";
import { nangoProxy } from "./nango";

export interface CompanyCamEvent {
  type: string; projectId: string; photoId: string; url: string; capturedAt?: string;
}

export interface CompanyCamGateway {
  /** HMAC-sha256 of the raw body. Empty secret -> allow (dev/test); fail closed in prod via env. */
  verifyWebhook(rawBody: string, signature: string | null): boolean;
  parseEvent(payload: unknown): CompanyCamEvent | null;
  /** Defined for completeness (future pull-to-R2); unused in reference-by-URL. */
  getPhoto(o: { connectionId: string; photoId: string }): Promise<{ url: string }>;
}

const CC_INTEGRATION = () => process.env.NANGO_COMPANYCAM_INTEGRATION_ID ?? "companycam";

function pickUri(uris?: { uri: string; type: string }[]): string {
  if (!uris || uris.length === 0) return "";
  return uris.find((u) => u.type === "original")?.uri ?? uris[0]!.uri;
}

export const httpCompanyCam: CompanyCamGateway = {
  verifyWebhook(raw, sig) {
    const secret = process.env.COMPANYCAM_WEBHOOK_SECRET ?? "";
    if (!secret) return true;
    if (!sig) return false;
    const expected = createHmac("sha256", secret).update(raw).digest("hex");
    return expected === sig;
  },
  parseEvent(payload) {
    const p = payload as {
      type?: string; event?: string;
      data?: { photo?: { id?: string | number; project_id?: string | number; uris?: { uri: string; type: string }[]; captured_at?: string } };
    };
    const photo = p.data?.photo;
    if (!photo?.id || !photo.project_id) return null;
    const url = pickUri(photo.uris);
    if (!url) return null;
    return { type: p.type ?? p.event ?? "photo", projectId: String(photo.project_id), photoId: String(photo.id), url, capturedAt: photo.captured_at };
  },
  async getPhoto({ connectionId, photoId }) {
    const res = await nangoProxy({ connectionId, integrationId: CC_INTEGRATION(), method: "GET", endpoint: `/v2/photos/${photoId}` });
    const r = res as { uris?: { uri: string; type: string }[] };
    return { url: pickUri(r.uris) };
  },
};

export function makeFakeCompanyCam(): CompanyCamGateway & { calls: { op: string; id: string }[] } {
  const calls: { op: string; id: string }[] = [];
  return {
    calls,
    verifyWebhook() { return true; },
    parseEvent(payload) {
      const p = payload as { type?: string; projectId?: string; photoId?: string; url?: string };
      if (!p.projectId || !p.photoId || !p.url) return null;
      return { type: p.type ?? "photo.created", projectId: p.projectId, photoId: p.photoId, url: p.url };
    },
    async getPhoto({ photoId }) {
      calls.push({ op: "getPhoto", id: photoId });
      return { url: `https://fake-companycam/${photoId}.jpg` };
    },
  };
}

/** Default export: real when an API key is configured, fake otherwise (tests/dev). */
export const companyCam: CompanyCamGateway = process.env.COMPANYCAM_API_KEY ? httpCompanyCam : makeFakeCompanyCam();
```

- [ ] **Step 4: Export from the index**

In `packages/integrations/src/index.ts`, add:
```ts
export { companyCam, httpCompanyCam, makeFakeCompanyCam, type CompanyCamGateway, type CompanyCamEvent } from "./companycam";
```

- [ ] **Step 5: Run the test (passes)**

```bash
pnpm --filter @savvy/integrations exec vitest run src/companycam.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/integrations/src/companycam.ts packages/integrations/src/companycam.test.ts packages/integrations/src/index.ts
git commit -m "feat(integrations): CompanyCam gateway (real + fake)"
```

---

## Task 6: Crew session + login/logout actions

**Files:** Create `apps/web/src/lib/crew-session.ts`, `apps/web/src/lib/crew-actions.ts`.

- [ ] **Step 1: Create the session module**

Create `apps/web/src/lib/crew-session.ts`:
```ts
import "server-only";
import { cookies } from "next/headers";
import { signPayloadToken, verifyPayloadToken } from "@savvy/core";

const COOKIE = "crew_session";
const TTL_MS = 12 * 60 * 60 * 1000;
const SECRET = () => process.env.CREW_SESSION_SECRET ?? "dev-crew-secret";

export type CrewSession = { tenantId: string; crewUserId: string };

export async function getCrewSession(): Promise<CrewSession | null> {
  const jar = await cookies();
  const tok = jar.get(COOKIE)?.value;
  if (!tok) return null;
  const p = verifyPayloadToken<{ tenantId: string; crewUserId: string; exp: string }>(tok, SECRET());
  if (!p) return null;
  if (Number(p.exp) < Date.now()) return null;
  return { tenantId: p.tenantId, crewUserId: p.crewUserId };
}

export async function setCrewCookie(s: CrewSession): Promise<void> {
  const tok = signPayloadToken({ ...s, exp: String(Date.now() + TTL_MS) }, SECRET());
  const jar = await cookies();
  jar.set(COOKIE, tok, {
    httpOnly: true,
    // secure must be OFF over http://localhost or the browser drops the cookie (breaks e2e).
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: TTL_MS / 1000,
  });
}

export async function clearCrewCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}
```

- [ ] **Step 2: Create the login/logout actions**

Create `apps/web/src/lib/crew-actions.ts`:
```ts
"use server";
import { adminDb, user, eq, and } from "@savvy/db";
import { verifyPin } from "@savvy/core";
import { tenantByKey } from "./intake";
import { setCrewCookie, clearCrewCookie } from "./crew-session";

export async function crewLogin(key: string, pin: string): Promise<{ ok: true } | { error: string }> {
  const t = await tenantByKey(key);
  if (!t) return { error: "unknown workspace" };
  const crew = await adminDb
    .select({ id: user.id, pinHash: user.pinHash })
    .from(user)
    .where(and(eq(user.tenantId, t.id), eq(user.role, "crew")));
  const match = crew.find((u) => verifyPin(pin, u.pinHash));
  if (!match) return { error: "invalid PIN" };
  await setCrewCookie({ tenantId: t.id, crewUserId: match.id });
  return { ok: true };
}

export async function crewLogout(): Promise<{ ok: true }> {
  await clearCrewCookie();
  return { ok: true };
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @savvy/web typecheck
```
Expected: PASS. (`tenantByKey` is exported from `./intake`; `user.role` compares to the `"crew"` enum literal.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/crew-session.ts apps/web/src/lib/crew-actions.ts
git commit -m "feat(web): crew session cookie + PIN login/logout"
```

---

## Task 7: Crew job queries + check-in/out actions

**Files:** Create `apps/web/src/lib/crew-queries.ts`; modify `apps/web/src/lib/crew-actions.ts`.

- [ ] **Step 1: Create crew queries**

Create `apps/web/src/lib/crew-queries.ts`:
```ts
import "server-only";
import { withTenant, job, customer, property, appointment, crewCheckin, eq, and, or, inArray, isNull, desc } from "@savvy/db";
import type { CrewSession } from "./crew-session";

const ACTIVE_STAGES = ["approved", "production", "closeout"] as const;

export type CrewJobRow = { id: string; stage: string; customerName: string | null; address: string | null };

/** Jobs this crew member is assigned to (directly or via a crew appointment), in active stages. */
export async function listCrewJobs(s: CrewSession): Promise<CrewJobRow[]> {
  return withTenant(s.tenantId, (tx) => {
    const apptJobIds = tx
      .select({ jobId: appointment.jobId })
      .from(appointment)
      .where(and(eq(appointment.assigneeUserId, s.crewUserId), eq(appointment.type, "crew")));
    return tx
      .select({ id: job.id, stage: job.stage, customerName: customer.name, address: property.address })
      .from(job)
      .leftJoin(customer, eq(customer.id, job.customerId))
      .leftJoin(property, eq(property.id, job.propertyId))
      .where(and(
        inArray(job.stage, ACTIVE_STAGES),
        or(eq(job.assignedUserId, s.crewUserId), inArray(job.id, apptJobIds)),
      ))
      .orderBy(desc(job.stageEnteredAt));
  });
}

/** True if the job is in this crew member's assigned set (authorization guard). */
export async function crewCanAccessJob(s: CrewSession, jobId: string): Promise<boolean> {
  const jobs = await listCrewJobs(s);
  return jobs.some((j) => j.id === jobId);
}

export type CrewJobDetail = {
  id: string; stage: string; customerName: string | null; address: string | null;
  openCheckinAt: Date | null;
};

export async function getCrewJob(s: CrewSession, jobId: string): Promise<CrewJobDetail | null> {
  if (!(await crewCanAccessJob(s, jobId))) return null;
  return withTenant(s.tenantId, async (tx) => {
    const [j] = await tx
      .select({ id: job.id, stage: job.stage, customerName: customer.name, address: property.address })
      .from(job)
      .leftJoin(customer, eq(customer.id, job.customerId))
      .leftJoin(property, eq(property.id, job.propertyId))
      .where(eq(job.id, jobId))
      .limit(1);
    if (!j) return null;
    const [open] = await tx
      .select({ at: crewCheckin.checkedInAt })
      .from(crewCheckin)
      .where(and(eq(crewCheckin.jobId, jobId), eq(crewCheckin.crewUserId, s.crewUserId), isNull(crewCheckin.checkedOutAt)))
      .orderBy(desc(crewCheckin.checkedInAt))
      .limit(1);
    return { ...j, openCheckinAt: open?.at ?? null };
  });
}
```

- [ ] **Step 2: Add check-in/out actions**

Append to `apps/web/src/lib/crew-actions.ts` (add imports at the top of the file alongside the existing ones):
```ts
import { withTenant, openCheckIn, closeCheckIn, recordAgentRun } from "@savvy/db";
import { getCrewSession } from "./crew-session";
import { crewCanAccessJob } from "./crew-queries";
```
and the actions:
```ts
export async function crewCheckIn(
  jobId: string, lat: number | null, lng: number | null,
): Promise<{ ok: true } | { error: string }> {
  const s = await getCrewSession();
  if (!s) return { error: "not signed in" };
  if (!(await crewCanAccessJob(s, jobId))) return { error: "not your job" };
  await withTenant(s.tenantId, (tx) => openCheckIn(tx, { tenantId: s.tenantId, jobId, crewUserId: s.crewUserId, lat, lng }));
  await recordAgentRun({ tenantId: s.tenantId, agent: "scheduling", taskKey: "crew.checkin", jobId, status: "ok" });
  return { ok: true };
}

export async function crewCheckOut(
  jobId: string, lat: number | null, lng: number | null,
): Promise<{ ok: true } | { error: string }> {
  const s = await getCrewSession();
  if (!s) return { error: "not signed in" };
  if (!(await crewCanAccessJob(s, jobId))) return { error: "not your job" };
  await withTenant(s.tenantId, (tx) => closeCheckIn(tx, { tenantId: s.tenantId, jobId, crewUserId: s.crewUserId, lat, lng }));
  await recordAgentRun({ tenantId: s.tenantId, agent: "scheduling", taskKey: "crew.checkout", jobId, status: "ok" });
  return { ok: true };
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @savvy/web typecheck
```
Expected: PASS. (Confirm `@savvy/db` exports `appointment`, `crewCheckin`, `or`, `inArray`, `isNull`, `recordAgentRun`, `openCheckIn`, `closeCheckIn`. If `recordAgentRun`'s `agent` param rejects `"scheduling"`, check the `Agent` type — `scheduling` is a valid enum value.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/crew-queries.ts apps/web/src/lib/crew-actions.ts
git commit -m "feat(web): crew job queries + check-in/out actions"
```

---

## Task 8: Crew photo upload actions

**Files:** Modify `apps/web/src/lib/crew-actions.ts`.

- [ ] **Step 1: Add the photo actions**

Append to `apps/web/src/lib/crew-actions.ts` (add to the top imports: `job, document, eq` from `@savvy/db` and `r2Storage` from `@savvy/integrations`):
```ts
import { job, document } from "@savvy/db";
import { r2Storage } from "@savvy/integrations";
```
and:
```ts
export async function crewPresignPhoto(
  jobId: string, input: { filename: string; contentType: string },
): Promise<{ ok: true; uploadUrl: string; r2Key: string } | { error: string }> {
  const s = await getCrewSession();
  if (!s) return { error: "not signed in" };
  if (!(await crewCanAccessJob(s, jobId))) return { error: "not your job" };
  const safe = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  const r2Key = `${s.tenantId}/${jobId}/${crypto.randomUUID()}-${safe}`;
  try {
    const { url } = await r2Storage.presignUpload({ key: r2Key, contentType: input.contentType });
    return { ok: true, uploadUrl: url, r2Key };
  } catch {
    return { error: "storage_not_configured" };
  }
}

export async function crewRecordPhoto(
  jobId: string,
  input: { r2Key: string; label: string; filename: string; mime: string; sizeBytes: number },
): Promise<{ ok: true; id: string } | { error: string }> {
  const s = await getCrewSession();
  if (!s) return { error: "not signed in" };
  if (!(await crewCanAccessJob(s, jobId))) return { error: "not your job" };
  if (!input.r2Key.startsWith(`${s.tenantId}/${jobId}/`)) return { error: "bad_key" };
  const res = await withTenant(s.tenantId, async (tx) => {
    const [j] = await tx.select({ customerId: job.customerId }).from(job).where(eq(job.id, jobId));
    if (!j) return null;
    const [row] = await tx.insert(document).values({
      tenantId: s.tenantId, jobId, customerId: j.customerId ?? null,
      kind: "photo", label: input.label, r2Key: input.r2Key,
      filename: input.filename, mime: input.mime, sizeBytes: input.sizeBytes, source: "savvy",
    }).returning({ id: document.id });
    return row;
  });
  if (!res) return { error: "not_found" };
  return { ok: true, id: res.id };
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @savvy/web typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/crew-actions.ts
git commit -m "feat(web): crew photo presign/record (session-authed)"
```

---

## Task 9: Crew surface pages (`/crew/[key]`)

**Files:** Create `apps/web/src/app/(crew)/layout.tsx`, `apps/web/src/app/(crew)/crew/[key]/page.tsx`, `.../CrewGate.tsx`, `.../job/[jobId]/page.tsx`, `.../job/[jobId]/CrewJobClient.tsx`.

- [ ] **Step 1: Crew route-group layout (no app chrome)**

Create `apps/web/src/app/(crew)/layout.tsx`:
```tsx
export const dynamic = "force-dynamic";

export default function CrewLayout({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto min-h-screen max-w-md p-4">{children}</div>;
}
```

- [ ] **Step 2: Entry page (PIN gate or jobs list)**

Create `apps/web/src/app/(crew)/crew/[key]/page.tsx`:
```tsx
import { getCrewSession } from "@/lib/crew-session";
import { listCrewJobs } from "@/lib/crew-queries";
import { CrewGate } from "./CrewGate";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function CrewHome({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const session = await getCrewSession();
  if (!session) return <CrewGate workspaceKey={key} />;

  const jobs = await listCrewJobs(session);
  return (
    <div className="space-y-4" data-testid="crew-jobs">
      <h1 className="text-lg font-semibold">Your jobs today</h1>
      {jobs.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--text-faint)" }}>No assigned jobs.</p>
      ) : (
        <ul className="space-y-2">
          {jobs.map((j) => (
            <li key={j.id}>
              <Link
                href={`/crew/${key}/job/${j.id}`}
                data-testid="crew-job-row"
                data-job-id={j.id}
                className="block rounded-lg border border-white/10 p-3"
              >
                <div className="font-medium">{j.customerName ?? "Job"}</div>
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>{j.address ?? "—"} · {j.stage}</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 3: PIN gate (client)**

Create `apps/web/src/app/(crew)/crew/[key]/CrewGate.tsx`:
```tsx
"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { crewLogin } from "@/lib/crew-actions";

export function CrewGate({ workspaceKey }: { workspaceKey: string }) {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    start(async () => {
      const r = await crewLogin(workspaceKey, pin);
      if ("error" in r) { setErr(r.error); return; }
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3 pt-16" data-testid="crew-gate">
      <h1 className="text-lg font-semibold">Crew sign-in</h1>
      <Input
        inputMode="numeric"
        type="password"
        placeholder="PIN"
        value={pin}
        onChange={(e) => setPin(e.target.value)}
        data-testid="crew-pin"
        required
      />
      {err ? <p className="text-sm" style={{ color: "var(--status-error)" }} data-testid="crew-pin-error">{err}</p> : null}
      <Button type="submit" disabled={pending} data-testid="crew-pin-submit">{pending ? "Checking…" : "Sign in"}</Button>
    </form>
  );
}
```

- [ ] **Step 4: Job view (server)**

Create `apps/web/src/app/(crew)/crew/[key]/job/[jobId]/page.tsx`:
```tsx
import { notFound } from "next/navigation";
import { getCrewSession } from "@/lib/crew-session";
import { getCrewJob } from "@/lib/crew-queries";
import { CrewJobClient } from "./CrewJobClient";

export const dynamic = "force-dynamic";

export default async function CrewJobPage({ params }: { params: Promise<{ key: string; jobId: string }> }) {
  const { jobId } = await params;
  const session = await getCrewSession();
  if (!session) notFound();
  const job = await getCrewJob(session, jobId);
  if (!job) notFound();

  return (
    <div className="space-y-4" data-testid="crew-job">
      <div>
        <h1 className="text-lg font-semibold">{job.customerName ?? "Job"}</h1>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>{job.address ?? "—"} · {job.stage}</p>
      </div>
      <CrewJobClient jobId={jobId} initiallyCheckedIn={job.openCheckinAt !== null} />
    </div>
  );
}
```

- [ ] **Step 5: Job client (check-in/out + photo upload)**

Create `apps/web/src/app/(crew)/crew/[key]/job/[jobId]/CrewJobClient.tsx`:
```tsx
"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { crewCheckIn, crewCheckOut, crewPresignPhoto, crewRecordPhoto } from "@/lib/crew-actions";

function getCoords(): Promise<{ lat: number | null; lng: number | null }> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ lat: null, lng: null });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve({ lat: null, lng: null }),
      { timeout: 5000 },
    );
  });
}

export function CrewJobClient({ jobId, initiallyCheckedIn }: { jobId: string; initiallyCheckedIn: boolean }) {
  const router = useRouter();
  const [checkedIn, setCheckedIn] = useState(initiallyCheckedIn);
  const [label, setLabel] = useState("before");
  const [pending, start] = useTransition();

  function toggle() {
    start(async () => {
      const { lat, lng } = await getCoords();
      const r = checkedIn ? await crewCheckOut(jobId, lat, lng) : await crewCheckIn(jobId, lat, lng);
      if ("error" in r) { toast.error(r.error); return; }
      setCheckedIn(!checkedIn);
      toast.success(checkedIn ? "Checked out" : "Checked in");
      router.refresh();
    });
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    start(async () => {
      const pre = await crewPresignPhoto(jobId, { filename: file.name, contentType: file.type || "image/jpeg" });
      if ("error" in pre) { toast.error(pre.error); return; }
      const put = await fetch(pre.uploadUrl, { method: "PUT", body: file, headers: { "content-type": file.type || "image/jpeg" } });
      if (!put.ok) { toast.error("upload failed"); return; }
      const rec = await crewRecordPhoto(jobId, { r2Key: pre.r2Key, label, filename: file.name, mime: file.type || "image/jpeg", sizeBytes: file.size });
      if ("error" in rec) { toast.error(rec.error); return; }
      toast.success("Photo uploaded");
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <Button onClick={toggle} disabled={pending} data-testid="crew-checkin-toggle" className="w-full">
        {checkedIn ? "Check out" : "Check in"}
      </Button>

      <div className="space-y-2 rounded-lg border border-white/10 p-3">
        <label className="block text-sm font-medium">Add photo</label>
        <select value={label} onChange={(e) => setLabel(e.target.value)} data-testid="crew-photo-label"
          className="mono rounded-md border border-white/10 bg-transparent px-2 py-1.5 text-sm">
          <option value="before">before</option>
          <option value="after">after</option>
          <option value="other">other</option>
        </select>
        <input type="file" accept="image/*" capture="environment" onChange={onFile} disabled={pending} data-testid="crew-photo-input" />
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm --filter @savvy/web typecheck
git add "apps/web/src/app/(crew)"
git commit -m "feat(web): crew field surface (PIN gate, jobs, check-in, photos)"
```
Expected: typecheck PASS.

---

## Task 10: Crew PIN admin (settings)

**Files:** Create `apps/web/src/lib/crew-admin-actions.ts`, `apps/web/src/app/(app)/settings/crew/page.tsx`, `.../CrewPinManager.tsx`.

- [ ] **Step 1: Admin actions**

Create `apps/web/src/lib/crew-admin-actions.ts`:
```ts
"use server";
import { withTenant, user, eq, and } from "@savvy/db";
import { hashPin } from "@savvy/core";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";

export async function listCrewUsers(): Promise<{ id: string; name: string; hasPin: boolean }[]> {
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({ id: user.id, name: user.name, pinHash: user.pinHash }).from(user).where(eq(user.role, "crew")));
  return rows.map((r) => ({ id: r.id, name: r.name, hasPin: !!r.pinHash }));
}

export async function setCrewPin(userId: string, pin: string | null): Promise<{ ok: true } | { error: string }> {
  const tenantId = await getTenantId();
  if (pin !== null && !/^\d{4,8}$/.test(pin)) return { error: "PIN must be 4–8 digits" };
  const res = await withTenant(tenantId, async (tx) => {
    const [u] = await tx.select({ id: user.id }).from(user).where(and(eq(user.id, userId), eq(user.role, "crew")));
    if (!u) return null;
    await tx.update(user).set({ pinHash: pin === null ? null : hashPin(pin) }).where(eq(user.id, userId));
    return u;
  });
  if (!res) return { error: "not a crew user in this tenant" };
  revalidatePath("/settings/crew");
  return { ok: true };
}
```

- [ ] **Step 2: Settings page (server) + manager (client)**

Create `apps/web/src/app/(app)/settings/crew/page.tsx`:
```tsx
import { listCrewUsers } from "@/lib/crew-admin-actions";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { CrewPinManager } from "./CrewPinManager";

export const dynamic = "force-dynamic";

export default async function CrewSettingsPage() {
  const crew = await listCrewUsers();
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Settings" title="Crew PINs" />
      <CrewPinManager crew={crew} />
    </div>
  );
}
```

Create `apps/web/src/app/(app)/settings/crew/CrewPinManager.tsx`:
```tsx
"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { setCrewPin } from "@/lib/crew-admin-actions";

type Crew = { id: string; name: string; hasPin: boolean };

export function CrewPinManager({ crew }: { crew: Crew[] }) {
  const router = useRouter();
  const [pins, setPins] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();

  function save(userId: string) {
    const pin = pins[userId] ?? "";
    start(async () => {
      const r = await setCrewPin(userId, pin);
      if ("error" in r) { toast.error(r.error); return; }
      toast.success("PIN set");
      setPins((p) => ({ ...p, [userId]: "" }));
      router.refresh();
    });
  }

  if (crew.length === 0) {
    return <p className="text-sm" style={{ color: "var(--text-faint)" }}>No crew users yet. Add users with role “crew”.</p>;
  }
  return (
    <Card className="divide-y divide-white/5 p-0">
      {crew.map((c) => (
        <div key={c.id} className="flex items-center gap-3 p-4" data-testid="crew-pin-row" data-user-id={c.id}>
          <div className="flex-1">
            <div className="font-medium">{c.name}</div>
            <div className="text-xs" style={{ color: "var(--text-muted)" }}>{c.hasPin ? "PIN set" : "no PIN"}</div>
          </div>
          <Input
            inputMode="numeric"
            placeholder="new PIN"
            value={pins[c.id] ?? ""}
            onChange={(e) => setPins((p) => ({ ...p, [c.id]: e.target.value }))}
            className="w-28"
          />
          <Button onClick={() => save(c.id)} disabled={pending} data-testid="crew-pin-save">Set</Button>
        </div>
      ))}
    </Card>
  );
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm --filter @savvy/web typecheck
git add apps/web/src/lib/crew-admin-actions.ts "apps/web/src/app/(app)/settings/crew"
git commit -m "feat(web): crew PIN admin settings"
```
Expected: typecheck PASS.

---

## Task 11: `resolveAgent` photo.* → SCOUT branch

**Files:** Modify `apps/web/src/lib/agents.ts`.

- [ ] **Step 1: Add the branch**

In `apps/web/src/lib/agents.ts`, `resolveAgent` has:
```ts
    case "scheduling": key = "MILO"; break;
```
Replace it with:
```ts
    case "scheduling": key = action.startsWith("photo.") ? "SCOUT" : "MILO"; break;
```
(`action` is the lowercased `taskKey`, already computed at the top of the function. So `scheduling` + `photo.companycam` → SCOUT, `scheduling` + `crew.checkin` → MILO.)

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm --filter @savvy/web typecheck
git add apps/web/src/lib/agents.ts
git commit -m "feat(web): scheduling photo.* runs resolve to SCOUT"
```
Expected: typecheck PASS.

---

## Task 12: CompanyCam connection + project link actions/UI

**Files:** Create `apps/web/src/lib/companycam-actions.ts`; modify the job-detail page to add a link input (see Task 14 for the Docs-tab render).

- [ ] **Step 1: Actions**

Create `apps/web/src/lib/companycam-actions.ts`:
```ts
"use server";
import { adminDb, withTenant, tenant, job, eq } from "@savvy/db";
import { getNangoConnection } from "@savvy/integrations";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";

// Mirrors saveQuickBooksConnection: adminDb write to the tenant row, IDOR-checked.
export async function saveCompanyCamConnection(
  connectionId: string,
): Promise<{ ok: true } | { error: "missing_connection_id" | "not_verified" }> {
  if (!connectionId) return { error: "missing_connection_id" };
  const tenantId = await getTenantId();
  const integrationId = process.env.NANGO_COMPANYCAM_INTEGRATION_ID ?? "companycam";
  const conn = await getNangoConnection({ connectionId, integrationId });
  if (!conn || conn.organizationId !== tenantId) return { error: "not_verified" };
  await adminDb.update(tenant).set({ companycamConnectionId: connectionId }).where(eq(tenant.id, tenantId));
  revalidatePath("/settings");
  return { ok: true };
}

export async function linkCompanyCamProject(
  jobId: string, projectId: string,
): Promise<{ ok: true } | { error: string }> {
  const tenantId = await getTenantId();
  const res = await withTenant(tenantId, async (tx) => {
    const [j] = await tx.select({ id: job.id }).from(job).where(eq(job.id, jobId));
    if (!j) return null;
    await tx.update(job).set({ companycamProjectId: projectId.trim() || null }).where(eq(job.id, jobId));
    return j;
  });
  if (!res) return { error: "not_found" };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm --filter @savvy/web typecheck
git add apps/web/src/lib/companycam-actions.ts
git commit -m "feat(web): CompanyCam connection + project-link actions"
```
Expected: typecheck PASS. (`getNangoConnection` is exported from `@savvy/integrations`.)

---

## Task 13: CompanyCam webhook route

**Files:** Create `apps/web/src/app/api/companycam/webhook/route.ts`.

- [ ] **Step 1: Create the route**

Create `apps/web/src/app/api/companycam/webhook/route.ts`:
```ts
import { NextResponse } from "next/server";
import { recordCompanyCamPhoto, recordAgentRun } from "@savvy/db";
import { companyCam } from "@savvy/integrations";

export const runtime = "nodejs"; // node:crypto for HMAC

// CompanyCam posts photo events here. Verify HMAC, parse, resolve the job by its
// companycamProjectId (adminDb, inside recordCompanyCamPhoto), insert a
// reference-by-URL document, and log a scheduling/photo.companycam run (-> SCOUT).
export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text();
  const sig = req.headers.get("x-companycam-signature");
  if (!companyCam.verifyWebhook(raw, sig)) return new NextResponse("bad signature", { status: 401 });

  let payload: unknown = null;
  try { payload = JSON.parse(raw); } catch { return new NextResponse("bad payload", { status: 400 }); }

  const ev = companyCam.parseEvent(payload);
  if (!ev) return NextResponse.json({ ok: true }); // non-photo / unparseable -> no-op

  const res = await recordCompanyCamPhoto({ projectId: ev.projectId, photoId: ev.photoId, url: ev.url, capturedAt: ev.capturedAt });
  if (res?.created) {
    await recordAgentRun({ tenantId: res.tenantId, agent: "scheduling", taskKey: "photo.companycam", jobId: res.jobId, status: "ok" });
  }
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm --filter @savvy/web typecheck
git add apps/web/src/app/api/companycam/webhook/route.ts
git commit -m "feat(web): CompanyCam photo webhook"
```
Expected: typecheck PASS.

---

## Task 14: Job-detail Docs tab — CompanyCam photos + link input + check-in strip

**Files:** Modify the job-detail Docs tab component and add a check-in query. First locate the Docs tab: `apps/web/src/app/(app)/jobs/[id]/tabs.tsx` (or the component it renders for documents) and the job-detail page `apps/web/src/app/(app)/jobs/[id]/page.tsx`.

- [ ] **Step 1: Read the current Docs tab**

```bash
sed -n '1,140p' "apps/web/src/app/(app)/jobs/[id]/tabs.tsx"
```
Identify where `document` rows are listed and how photos are rendered (presigned R2 view). Note the prop name carrying documents and whether `externalUrl` is available on those rows (the query that feeds the tab must select `externalUrl` + `source`).

- [ ] **Step 2: Ensure the documents query selects the new columns**

Find the query feeding the Docs tab (in `apps/web/src/app/(app)/jobs/[id]/page.tsx` or a `*-queries.ts`). Add `source: document.source` and `externalUrl: document.externalUrl` to its `.select({...})` if not present, and thread them through the row type. Render branch in the tab where a photo thumbnail is shown:
```tsx
{d.externalUrl ? (
  <img src={d.externalUrl} alt={d.label ?? "photo"} className="h-24 w-24 rounded object-cover" data-testid="companycam-photo" />
) : (
  /* existing presigned-R2 thumbnail */
)}
```
(Keep the existing R2 path untouched; only add the `externalUrl` branch ahead of it.)

- [ ] **Step 3: Add the CompanyCam project link input**

In the Docs tab (a client component), add a small form bound to `linkCompanyCamProject(jobId, projectId)` from `@/lib/companycam-actions`, with `data-testid="companycam-link"` on the input and `data-testid="companycam-link-save"` on the button. Pass the current `job.companycamProjectId` in as the initial value (thread it from the page).

- [ ] **Step 4: Add a check-in history strip**

Create a query `getJobCheckins(tenantId, jobId)` in `apps/web/src/lib/crew-queries.ts`:
```ts
export async function getJobCheckins(tenantId: string, jobId: string): Promise<{ id: string; crewName: string | null; checkedInAt: Date; checkedOutAt: Date | null }[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({ id: crewCheckin.id, crewName: user.name, checkedInAt: crewCheckin.checkedInAt, checkedOutAt: crewCheckin.checkedOutAt })
      .from(crewCheckin)
      .leftJoin(user, eq(user.id, crewCheckin.crewUserId))
      .where(eq(crewCheckin.jobId, jobId))
      .orderBy(desc(crewCheckin.checkedInAt))
      .limit(20));
}
```
(add `user` to the imports in `crew-queries.ts`). In the job-detail page, fetch it and render a small list under the Docs tab or the timeline: each row "MILO · {crewName} · in {time} · out {time|—}", attributed with the MILO `AgentAvatar` (use `resolveAgent({ agent: "scheduling", taskKey: "crew.checkin" })`).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @savvy/web typecheck
git add "apps/web/src/app/(app)/jobs/[id]" apps/web/src/lib/crew-queries.ts
git commit -m "feat(web): job detail — CompanyCam photos, project link, crew check-in strip"
```
Expected: typecheck PASS.

---

## Task 15: e2e — crew flow

**Files:** Create `apps/web/tests/e2e/crew.spec.ts`.

- [ ] **Step 1: Write the spec**

Create `apps/web/tests/e2e/crew.spec.ts`:
```ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, adminDb, tenant, customer, property, job, user, crewCheckin, agentRun, eq, and } from "@savvy/db";
import { hashPin } from "@savvy/core";

const { id: tenantId, key } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

test("crew: PIN sign-in -> see job -> check in -> check out", async ({ page }) => {
  // Seed a crew user with a known PIN + an assigned production job.
  const pin = "246810";
  const { jobId, crewUserId } = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Crew Carl" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "5 Crew Way" }).returning();
    const [u] = await tx.insert(user).values({ tenantId, name: "Field Fred", email: `fred-${Date.now()}@x.com`, role: "crew" }).returning();
    const [j] = await tx.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production", assignedUserId: u!.id }).returning();
    return { jobId: j!.id, crewUserId: u!.id };
  });
  await adminDb.update(user).set({ pinHash: hashPin(pin) }).where(eq(user.id, crewUserId));

  // Sign in with the PIN.
  await page.goto(`/crew/${key}`);
  await expect(page.getByTestId("crew-gate")).toBeVisible();
  await page.getByTestId("crew-pin").fill(pin);
  await page.getByTestId("crew-pin-submit").click();

  // See the assigned job, open it.
  await expect(page.locator(`[data-testid="crew-job-row"][data-job-id="${jobId}"]`)).toBeVisible();
  await page.goto(`/crew/${key}/job/${jobId}`);
  await expect(page.getByTestId("crew-job")).toBeVisible();

  // Check in.
  await page.getByTestId("crew-checkin-toggle").click();
  await expect(async () => {
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(crewCheckin).where(eq(crewCheckin.jobId, jobId)));
    expect(row?.checkedOutAt ?? null).toBeNull();
    expect(row).toBeTruthy();
  }).toPass({ timeout: 10_000 });

  // A scheduling/crew.checkin agent_run was logged.
  const runs = await withTenant(tenantId, (tx) =>
    tx.select().from(agentRun).where(and(eq(agentRun.jobId, jobId), eq(agentRun.taskKey, "crew.checkin"))));
  expect(runs.length).toBeGreaterThan(0);

  // Check out.
  await page.getByTestId("crew-checkin-toggle").click();
  await expect(async () => {
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(crewCheckin).where(eq(crewCheckin.jobId, jobId)));
    expect(row?.checkedOutAt ?? null).not.toBeNull();
  }).toPass({ timeout: 10_000 });
});
```

- [ ] **Step 2: Commit (run happens in Task 17's full e2e pass)**

```bash
git add apps/web/tests/e2e/crew.spec.ts
git commit -m "test(web): crew check-in e2e"
```

---

## Task 16: e2e — CompanyCam webhook

**Files:** Create `apps/web/tests/e2e/companycam.spec.ts`.

- [ ] **Step 1: Write the spec**

Create `apps/web/tests/e2e/companycam.spec.ts`:
```ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, customer, property, job, document, agentRun, eq, and } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

test("companycam: webhook attaches a referenced photo + logs SCOUT run", async ({ request }) => {
  const projectId = `proj-${Date.now()}`;
  const jobId = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "CC Cathy" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "8 Cam Rd" }).returning();
    const [j] = await tx.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production", companycamProjectId: projectId }).returning();
    return j!.id;
  });

  // The webServer runs with no COMPANYCAM_API_KEY -> the fake gateway; its
  // parseEvent reads this simple shape and verifyWebhook returns true.
  const res = await request.post("/api/companycam/webhook", {
    data: { type: "photo.created", projectId, photoId: "cc-photo-1", url: "https://companycam.test/p1.jpg" },
  });
  expect(res.ok()).toBeTruthy();

  const docs = await withTenant(tenantId, (tx) =>
    tx.select().from(document).where(and(eq(document.jobId, jobId), eq(document.source, "companycam"))));
  expect(docs.length).toBe(1);
  expect(docs[0]!.externalUrl).toBe("https://companycam.test/p1.jpg");

  const runs = await withTenant(tenantId, (tx) =>
    tx.select().from(agentRun).where(and(eq(agentRun.jobId, jobId), eq(agentRun.taskKey, "photo.companycam"))));
  expect(runs.length).toBe(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/tests/e2e/companycam.spec.ts
git commit -m "test(web): CompanyCam webhook e2e"
```

---

## Task 17: .env.example + full gate + PR

**Files:** Modify `.env.example`.

- [ ] **Step 1: Document new env**

Append to `.env.example`:
```
# Phase 6D — crew + CompanyCam
CREW_SESSION_SECRET=
NANGO_COMPANYCAM_INTEGRATION_ID=companycam
COMPANYCAM_API_KEY=
COMPANYCAM_WEBHOOK_SECRET=
```

- [ ] **Step 2: Run the full gate**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Expected: typecheck + lint clean (pre-existing warnings OK); all package vitest suites green (the new core/db/integrations tests included).

- [ ] **Step 3: Run the e2e (both new specs)**

Ensure nothing stale is on :3000 (`lsof -ti:3000` → kill a leftover `next dev`), then:
```bash
export AI_STUB_PORT=4010
node apps/web/tests/e2e/ai-stub.mjs & AISTUB_PID=$!
npx --yes inngest-cli@latest dev -u http://localhost:3000/api/inngest --no-discovery & INNGEST_PID=$!
sleep 5
pnpm --filter @savvy/web exec tsx tests/e2e/create-tenant.ts
export TEST_TENANT_ID="$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)")"
pnpm --filter @savvy/web exec playwright test crew.spec.ts companycam.spec.ts
kill $AISTUB_PID $INNGEST_PID 2>/dev/null || true
```
Expected: both specs PASS. (The crew spec relies on the `crew_session` cookie persisting over http://localhost — confirmed because `setCrewCookie` only sets `secure` in production.)

- [ ] **Step 4: Push + PR (base main)**

```bash
git push -u origin feat/phase6d-companycam-crew
gh pr create --base main --title "feat: phase 6D — CompanyCam + crew check-in" --body "Adds a PIN-authed crew field surface (check in/out + photo upload) and a CompanyCam integration (link job→project; ingest photos by reference). Surfaces as MILO/SCOUT in the Command Center. New crew_checkin table + document/job/user/tenant alters (migration 0011). CompanyCam built as gateway+fake (validate against the live service later). Spec: docs/superpowers/specs/2026-06-17-phase6d-companycam-crew-design.md"
```

---

## Self-Review notes (resolved during planning)
- **Spec coverage:** crew PIN auth (T2,T6) ✓; tenant-scoped session (T6) ✓; today's jobs (T7) ✓; check in/out + GPS (T7,T9) ✓; crew photo upload (T8,T9) ✓; crew_checkin table (T1) ✓; CompanyCam gateway+fake (T5) ✓; webhook reference-by-URL + dedupe (T4,T13) ✓; job↔project link + connection (T12) ✓; agent mapping MILO/SCOUT (T11) ✓; Docs-tab render + check-in strip (T14) ✓; PIN admin (T10) ✓; tests (T2–T5 unit/integration, T15–T16 e2e) ✓; env (T17) ✓.
- **Secure-cookie/localhost trap** handled (`secure` only in production) — the crew e2e depends on it.
- **No name drift:** `openCheckIn`/`closeCheckIn`, `recordCompanyCamPhoto`, `getCrewSession`/`setCrewCookie`, `crewCanAccessJob`, `companyCam` used consistently across tasks and tests.
- **Migration safety:** if drizzle-kit omits `r2_key DROP NOT NULL`, T1 step 4 adds it by hand (the companycam document insert leaves `r2Key` null).
- **Known follow-ups (out of scope, noted in spec):** real CompanyCam API/signature validation; PIN lockout; pull-to-R2; customer photo sharing; auto-labeling CompanyCam photos toward the completion gate.
