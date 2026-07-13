# Canvass Slice 2 — Sale→Contract Alerts & CRM Deep-Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alert the selling rep + managers in-app when a canvass sale sits 30 minutes with no signed contract, and give each sale a "View in CRM" deep-link — both powered by stamping the sale knock with `contract_signed_at` + `lead_id` when its contract signs.

**Architecture:** The knock is the source of truth. The field app stamps the sale knock on contract-sign (the `/contract` POST already returns `{leadId}`). The knocks route emits `canvass/sale.logged` on a fresh sale; a durable Inngest workflow sleeps 30 min, re-reads the knock, and writes `canvass_alert` rows (one per recipient) if it's still an unsigned sale. In-app only this slice (text is a documented, unbuilt seam).

**Tech Stack:** TypeScript, Drizzle + Postgres (RLS), Next.js App Router route handlers, Inngest, Vitest, vanilla-JS PWA (`~/Sites/savvy-canvass`).

## Global Constraints

- **Tenant isolation on every table and query.** New table `canvass_alert` gets `tenant_id` + `tenantIsolation()` RLS (role `savvy_app`); all DB access via `withTenant`. Lifecycle fns take a `tenantId` param for signature parity even though RLS scopes (house convention).
- **Alert kind** is exactly `sale_no_contract` (only kind in v1; the column is generic). **Recipients** = the selling rep + every active manager, deduped, one `canvass_alert` row each.
- **Bearer session + rate limit** on every endpoint, mirroring the Phase 3 spiff routes exactly (`verifyCanvassToken(bearerToken(...))`, `checkRateLimit`, `canvassCors`).
- **30-minute threshold is a fixed constant** (`SALE_CONTRACT_GRACE = "30m"` for the sleep). No per-tenant config.
- **No SMS this slice.** The recipient-insert step is the documented seam; do not call any SMS sender.
- **Additive only.** Existing knock/contract/scoreboard/eod behavior is unchanged except the two documented knock columns, the new emit, and the two response fields (`leadId`).
- **Idempotency.** The `canvass/sale.logged` emit uses event `id: "sale:" + knockId` so re-emits (edits, appt→sale) dedupe; the alert-creation guards on an existing `sale_no_contract` alert for the same `knock_id`.

## File Structure

- `packages/db/src/schema/canvass.ts` — **modify.** Add `contractSignedAt` + `leadId` columns to `canvassKnock`; append `canvassAlert` table.
- `packages/db/drizzle/NNNN_*.sql` — **generated.**
- `packages/db/src/lifecycle/canvass-knock.ts` — **modify.** `CanvassKnockUpsert` + mutable set gain `contractSignedAt`/`leadId`.
- `packages/db/src/lifecycle/canvass-alert.ts` — **new.** `createSaleNoContractAlerts`, `listAlerts`, `markAlertRead`, `markAllAlertsRead`, `readKnockForAlert`, `activeManagerIds`.
- `packages/db/src/index.ts` — **modify.** Re-export the new lifecycle fns.
- `packages/db/tests/canvass-alert.test.ts` — **new.** DB-backed.
- `packages/agents/src/functions/canvass-sale-watch.ts` — **new.** `canvassSaleContractWatch` workflow.
- `packages/agents/src/index.ts` — **modify.** Register 3 ways (import/export/`functions[]`).
- `packages/core/src/canvass.ts` — **modify.** Add `contractSignedAt`/`leadId` to `canvassKnockObject`.
- `apps/web/src/app/api/canvass/knocks/route.ts` — **modify.** Pass the two fields to the upsert; emit `canvass/sale.logged`; add `leadId` to the GET select.
- `apps/web/src/app/api/canvass/eod/route.ts` — **modify.** Add `leadId` to the sales query + `sales[]` rows.
- `apps/web/src/app/api/canvass/alerts/route.ts` — **new.** GET list + POST `?action=read-all`.
- `apps/web/src/app/api/canvass/alerts/[id]/route.ts` — **new.** POST `?action=read`.
- `apps/web/src/middleware.ts` — **modify.** Allowlist `alerts` + `alerts/:id`.
- `~/Sites/savvy-canvass/index.html` + `sw.js` — **modify.** Stamp on contract sign, alerts bell + sheet, `pullAlerts`, CRM link. `v1.17.0-beta`.

---

### Task 1: DB — knock columns + canvass_alert table + migration

**Files:**
- Modify: `packages/db/src/schema/canvass.ts`
- Generate: `packages/db/drizzle/NNNN_*.sql`

**Interfaces:**
- Consumes: existing `canvassKnock`, `canvassRep`, `tenant` in the same file; `idCol`/`createdAt`/`tenantIsolation` from `./_rls`; drizzle `text`/`uuid`/`timestamp`/`index`.
- Produces: two new `canvassKnock` columns; `canvassAlert` table export.

- [ ] **Step 1: Read conventions.** Open `packages/db/src/schema/canvass.ts`; study `canvassKnock` (columns, the `timestamp("...", { withTimezone: true })` style) and the `canvassSpiff` table at the end (id/tenant/`createdAt()`/`tenantIsolation(t)`/index pattern). Match them.

- [ ] **Step 2: Add the two knock columns.** In the `canvassKnock` `pgTable({...})` column object, add (near `scheduledAt`):

```ts
    contractSignedAt: timestamp("contract_signed_at", { withTimezone: true }),
    leadId: uuid("lead_id"), // soft ref to lead(id); no FK to avoid a cross-schema import cycle
```

- [ ] **Step 3: Append the `canvassAlert` table** at the end of the file:

```ts
export const canvassAlert = pgTable(
  "canvass_alert",
  {
    id: idCol(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // 'sale_no_contract'
    repId: uuid("rep_id").notNull().references(() => canvassRep.id, { onDelete: "cascade" }), // recipient
    knockId: uuid("knock_id").references(() => canvassKnock.id, { onDelete: "set null" }),
    leadId: uuid("lead_id"), // soft ref for the CRM deep-link
    title: text("title").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    index("canvass_alert_tenant_rep_idx").on(t.tenantId, t.repId, t.readAt),
    index("canvass_alert_knock_idx").on(t.knockId),
    tenantIsolation(t),
  ],
);
```

> Match the actual `idCol()`/`createdAt()`/`tenantIsolation()` helpers used by `canvassSpiff` in this file. If `canvassSpiff` chains `.enableRLS()`, do the same; if it relies on policy detection (no `.enableRLS()`), match that. Add any missing import (`text`/`uuid`/`timestamp`/`index`) to the existing import block.

- [ ] **Step 4: Generate + apply.** `pnpm db:generate` → open the new `packages/db/drizzle/NNNN_*.sql`; confirm it (a) `ALTER TABLE canvass_knock ADD contract_signed_at` + `lead_id`, (b) `CREATE TABLE canvass_alert` with `ENABLE ROW LEVEL SECURITY` + a `savvy_app` `tenant_isolation` policy (same shape as `canvass_spiff`). Then `pnpm db:up && pnpm db:migrate` — no error.

- [ ] **Step 5: Commit** the schema file + the whole `packages/db/drizzle` change: `feat(canvass): knock contract_signed_at/lead_id + canvass_alert table`.

---

### Task 2: DB — knock upsert accepts contract_signed_at / lead_id

**Files:**
- Modify: `packages/db/src/lifecycle/canvass-knock.ts`
- Test: extend `packages/db/tests/canvass-knock-upsert.test.ts`

**Interfaces:**
- Produces: `CanvassKnockUpsert` gains `contractSignedAt?: Date | null` and `leadId?: string | null`; both flow through the insert + `onConflictDoUpdate` mutable set.

- [ ] **Step 1: Extend the interface.** In `CanvassKnockUpsert` add:

```ts
  contractSignedAt?: Date | null;
  leadId?: string | null;
```

- [ ] **Step 2: Add to the mutable set** (inside `upsertCanvassKnock`, in the `mutable` object):

```ts
    contractSignedAt: k.contractSignedAt ?? null,
    leadId: k.leadId ?? null,
```

(No other change — `mutable` is used for both the insert `.values` and the `onConflictDoUpdate` set, so a same-rep re-upsert stamps them; the `setWhere: eq(canvassKnock.repId, k.repId)` anti-steal guard is unchanged.)

- [ ] **Step 3: Add a test** to `packages/db/tests/canvass-knock-upsert.test.ts` — a new `it` inside `describe("upsertCanvassKnock", ...)`:

```ts
  it("stamps contract_signed_at + lead_id on a same-rep re-upsert (contract signed)", async () => {
    const leadUuid = "11111111-1111-1111-1111-111111111111";
    const signedAt = new Date("2026-07-12T18:30:00.000Z");
    // base(repA) uses clientId "knock-1", already owned by repA from earlier tests
    const { id } = await withTenant(tId, (tx) =>
      upsertCanvassKnock(tx, { ...base(repA), outcome: "sale", amount: 9000, contractSignedAt: signedAt, leadId: leadUuid }),
    );
    expect(id).toBeTruthy();
    const [row] = await adminDb.select().from(canvassKnock).where(eq(canvassKnock.clientId, "knock-1"));
    expect(row!.leadId).toBe(leadUuid);
    expect(row!.contractSignedAt?.toISOString()).toBe(signedAt.toISOString());
  });
```

- [ ] **Step 4: Run** (clear synthetic debris first): `docker exec savvy_db psql -U postgres -d savvy -c "DELETE FROM job_task WHERE task_id>=9000; DELETE FROM task_registry WHERE id>=9000;" >/dev/null 2>&1` then `npx vitest run packages/db/tests/canvass-knock-upsert.test.ts --no-file-parallelism`. Expected: PASS (existing + new).

- [ ] **Step 5: Commit** `feat(canvass): upsert persists knock contract_signed_at + lead_id`.

---

### Task 3: DB — alert lifecycle

**Files:**
- Create: `packages/db/src/lifecycle/canvass-alert.ts`
- Modify: `packages/db/src/index.ts` (re-export)
- Test: `packages/db/tests/canvass-alert.test.ts`

**Interfaces:**
- Consumes: `Tx`; `canvassAlert`, `canvassRep`, `canvassKnock` from `../schema/index`; drizzle `and`/`eq`/`desc`/`isNull`.
- Produces: `createSaleNoContractAlerts`, `listAlerts`, `markAlertRead`, `markAllAlertsRead`, `readKnockForAlert`, `activeManagerIds`, `AlertRow`.

- [ ] **Step 1: Write the module.**

```ts
// packages/db/src/lifecycle/canvass-alert.ts
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Tx } from "../tenant";
import { canvassAlert, canvassRep, canvassKnock } from "../schema/index";

export interface AlertRow {
  id: string;
  kind: string;
  knockId: string | null;
  leadId: string | null;
  title: string;
  body: string;
  createdAt: Date;
  readAt: Date | null;
}

function toRow(r: typeof canvassAlert.$inferSelect): AlertRow {
  return { id: r.id, kind: r.kind, knockId: r.knockId, leadId: r.leadId, title: r.title, body: r.body, createdAt: r.createdAt, readAt: r.readAt };
}

// Active managers for the tenant (recipients of supervisory alerts).
export async function activeManagerIds(tx: Tx, tenantId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: canvassRep.id })
    .from(canvassRep)
    .where(and(eq(canvassRep.tenantId, tenantId), eq(canvassRep.manager, true), eq(canvassRep.active, true)));
  return rows.map((r) => r.id);
}

// Minimal knock read for the 30-min watcher.
export async function readKnockForAlert(
  tx: Tx,
  knockId: string,
): Promise<{ outcome: string; contractSignedAt: Date | null; contactName: string | null; address: string | null; repId: string } | null> {
  const [k] = await tx
    .select({ outcome: canvassKnock.outcome, contractSignedAt: canvassKnock.contractSignedAt, contactName: canvassKnock.contactName, address: canvassKnock.address, repId: canvassKnock.repId })
    .from(canvassKnock)
    .where(eq(canvassKnock.id, knockId));
  return k ?? null;
}

// Write one sale_no_contract alert per recipient (seller + active managers, deduped).
// Idempotent: if any alert already exists for this knock, write nothing.
export async function createSaleNoContractAlerts(
  tx: Tx,
  tenantId: string,
  a: { knockId: string; sellerRepId: string; contactLabel: string },
): Promise<{ created: number }> {
  const existing = await tx.select({ id: canvassAlert.id }).from(canvassAlert).where(eq(canvassAlert.knockId, a.knockId));
  if (existing.length > 0) return { created: 0 };
  const managers = await activeManagerIds(tx, tenantId);
  const recipients = [...new Set([a.sellerRepId, ...managers])];
  if (recipients.length === 0) return { created: 0 };
  const title = "Sale needs a contract";
  const body = `${a.contactLabel} — 30 min in, still no signed contract.`;
  await tx.insert(canvassAlert).values(
    recipients.map((repId) => ({ tenantId, kind: "sale_no_contract" as const, repId, knockId: a.knockId, leadId: null, title, body })),
  );
  return { created: recipients.length };
}

// A rep's alerts, newest first (+ unread count).
export async function listAlerts(tx: Tx, tenantId: string, repId: string): Promise<{ alerts: AlertRow[]; unread: number }> {
  const rows = await tx.select().from(canvassAlert).where(eq(canvassAlert.repId, repId)).orderBy(desc(canvassAlert.createdAt));
  return { alerts: rows.map(toRow), unread: rows.filter((r) => r.readAt === null).length };
}

// Flip one unread alert to read (only the owner's). Returns whether a row changed.
export async function markAlertRead(tx: Tx, tenantId: string, alertId: string, repId: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(canvassAlert)
    .set({ readAt: now })
    .where(and(eq(canvassAlert.id, alertId), eq(canvassAlert.repId, repId), isNull(canvassAlert.readAt)))
    .returning({ id: canvassAlert.id });
  return rows.length > 0;
}

// Flip all the caller's unread alerts to read. Returns how many changed.
export async function markAllAlertsRead(tx: Tx, tenantId: string, repId: string, now: Date): Promise<number> {
  const rows = await tx
    .update(canvassAlert)
    .set({ readAt: now })
    .where(and(eq(canvassAlert.repId, repId), isNull(canvassAlert.readAt)))
    .returning({ id: canvassAlert.id });
  return rows.length;
}
```

- [ ] **Step 2: Re-export** in `packages/db/src/index.ts` (mirror the spiff lifecycle re-export line):

```ts
export { createSaleNoContractAlerts, listAlerts, markAlertRead, markAllAlertsRead, readKnockForAlert, activeManagerIds, type AlertRow } from "./lifecycle/canvass-alert";
```

- [ ] **Step 3: Write the DB test** `packages/db/tests/canvass-alert.test.ts` (model on `canvass-spiff.test.ts` — seed tenant + 3 reps incl. a manager + one sale knock; afterAll cleans `canvassAlert`, `canvassKnock`, `canvassRep`, `tenant`):

```ts
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { adminDb, adminPool, pool, eq, tenant, canvassRep, canvassKnock, canvassAlert } from "../src/index";
import { withTenant } from "../src/tenant";
import { createSaleNoContractAlerts, listAlerts, markAlertRead, markAllAlertsRead, readKnockForAlert } from "../src/lifecycle/canvass-alert";

let tId: string, seller: string, mgr: string, other: string, knockId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "Alert Co", publicKey: `al-${Date.now()}`, clerkOrgId: `org_al_${Date.now()}` }).returning();
  tId = t!.id;
  const reps = await adminDb.insert(canvassRep).values([
    { tenantId: tId, name: "Seller", pinHash: "x" },
    { tenantId: tId, name: "Manager", pinHash: "x", manager: true },
    { tenantId: tId, name: "Other", pinHash: "x" },
  ]).returning();
  seller = reps[0]!.id; mgr = reps[1]!.id; other = reps[2]!.id;
  const [k] = await adminDb.insert(canvassKnock).values({ tenantId: tId, repId: seller, clientId: "sale-1", lat: 33.4, lng: -111.8, outcome: "sale", amount: 8000, contactName: "Jane HO", gpsFlagged: false }).returning();
  knockId = k!.id;
});

afterAll(async () => {
  await adminDb.delete(canvassAlert).where(eq(canvassAlert.tenantId, tId));
  await adminDb.delete(canvassKnock).where(eq(canvassKnock.tenantId, tId));
  await adminDb.delete(canvassRep).where(eq(canvassRep.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

describe("createSaleNoContractAlerts", () => {
  it("writes one alert to the seller + each active manager, deduped, and is idempotent per knock", async () => {
    const { created } = await withTenant(tId, (tx) => createSaleNoContractAlerts(tx, tId, { knockId, sellerRepId: seller, contactLabel: "Jane HO" }));
    expect(created).toBe(2); // seller + manager (other is a plain rep, not notified)
    // seller and manager each see it; other sees nothing
    expect((await withTenant(tId, (tx) => listAlerts(tx, tId, seller))).alerts.length).toBe(1);
    expect((await withTenant(tId, (tx) => listAlerts(tx, tId, mgr))).alerts.length).toBe(1);
    expect((await withTenant(tId, (tx) => listAlerts(tx, tId, other))).alerts.length).toBe(0);
    // second call for the same knock writes nothing
    const again = await withTenant(tId, (tx) => createSaleNoContractAlerts(tx, tId, { knockId, sellerRepId: seller, contactLabel: "Jane HO" }));
    expect(again.created).toBe(0);
  });
});

describe("read state", () => {
  it("marks one alert read (owner only) and then all", async () => {
    const { alerts, unread } = await withTenant(tId, (tx) => listAlerts(tx, tId, seller));
    expect(unread).toBe(1);
    const aid = alerts[0]!.id;
    // a different rep cannot read the seller's alert
    expect(await withTenant(tId, (tx) => markAlertRead(tx, tId, aid, other, new Date()))).toBe(false);
    expect(await withTenant(tId, (tx) => markAlertRead(tx, tId, aid, seller, new Date()))).toBe(true);
    // re-marking is a no-op
    expect(await withTenant(tId, (tx) => markAlertRead(tx, tId, aid, seller, new Date()))).toBe(false);
    expect((await withTenant(tId, (tx) => listAlerts(tx, tId, seller))).unread).toBe(0);
    // mark-all on the manager
    expect(await withTenant(tId, (tx) => markAllAlertsRead(tx, tId, mgr, new Date()))).toBe(1);
    expect((await withTenant(tId, (tx) => listAlerts(tx, tId, mgr))).unread).toBe(0);
  });
});

describe("readKnockForAlert", () => {
  it("returns the sale's outcome/contract state for the watcher", async () => {
    const k = await withTenant(tId, (tx) => readKnockForAlert(tx, knockId));
    expect(k?.outcome).toBe("sale");
    expect(k?.contractSignedAt).toBeNull();
    expect(k?.contactName).toBe("Jane HO");
  });
});
```

- [ ] **Step 4: Run** (clear debris first, `--no-file-parallelism`): `npx vitest run packages/db/tests/canvass-alert.test.ts --no-file-parallelism`. Expected: all PASS.

- [ ] **Step 5: Commit** `feat(canvass): alert lifecycle (create/list/read) + recipient resolution`.

---

### Task 4: Agents — 30-minute sale→contract watcher

**Files:**
- Create: `packages/agents/src/functions/canvass-sale-watch.ts`
- Modify: `packages/agents/src/index.ts`

**Interfaces:**
- Consumes: `withTenant`, `readKnockForAlert`, `createSaleNoContractAlerts` from `@savvy/db`; `inngest` from `../client`.
- Produces: `canvassSaleContractWatch`, triggered by `canvass/sale.logged`.

- [ ] **Step 1: Write the workflow.**

```ts
// packages/agents/src/functions/canvass-sale-watch.ts
import { withTenant, readKnockForAlert, createSaleNoContractAlerts } from "@savvy/db";
import { inngest } from "../client";

// A sale with no signed contract after 30 minutes → alert the seller + managers.
// Silent when the contract landed in time (the field app stamps contract_signed_at
// on the knock) or the knock is no longer a sale.
export const canvassSaleContractWatch = inngest.createFunction(
  { id: "canvass-sale-contract-watch", concurrency: { limit: 10 } },
  { event: "canvass/sale.logged" },
  async ({ event, step }) => {
    const { tenantId, knockId, repId } = event.data as { tenantId: string; knockId: string; repId: string };
    await step.sleep("grace-30m", "30m");
    return await step.run("alert-if-no-contract", () =>
      withTenant(tenantId, async (tx) => {
        const k = await readKnockForAlert(tx, knockId);
        if (!k || k.outcome !== "sale" || k.contractSignedAt) return { alerted: 0, reason: "resolved" as const };
        const label = k.contactName || k.address || "A sale";
        const { created } = await createSaleNoContractAlerts(tx, tenantId, { knockId, sellerRepId: repId, contactLabel: label });
        return { alerted: created };
      }),
    );
  },
);
```

- [ ] **Step 2: Register 3 ways** in `packages/agents/src/index.ts` (mirror `challengeSettleHourly`):
  - import: `import { canvassSaleContractWatch } from "./functions/canvass-sale-watch";`
  - re-export: `export { canvassSaleContractWatch } from "./functions/canvass-sale-watch";`
  - append to the `export const functions = [ ... ]` array: add `, canvassSaleContractWatch` before the closing `]`.

- [ ] **Step 3: Typecheck.** `pnpm typecheck 2>&1 | tail -3` — clean (ignore only the pre-existing `@savvy/integrations` vapi.ts error, if any).

- [ ] **Step 4: Commit** `feat(canvass): 30-min sale-without-contract watcher (Inngest)`.

---

### Task 5: Web — knocks route emit + fields; eod leadId

**Files:**
- Modify: `packages/core/src/canvass.ts` (zod)
- Modify: `apps/web/src/app/api/canvass/knocks/route.ts`
- Modify: `apps/web/src/app/api/canvass/eod/route.ts`

**Interfaces:**
- Consumes: `inngest` from `@savvy/agents`; the upsert fields from Task 2.

- [ ] **Step 1: Extend the zod object.** In `packages/core/src/canvass.ts`, inside `canvassKnockObject = z.object({ ... })`, add (near `scheduledAt`):

```ts
  contractSignedAt: z.string().datetime({ offset: true }).optional(),
  leadId: z.string().uuid().optional(),
```

- [ ] **Step 2: Pass the fields + emit in the knocks route.** In `apps/web/src/app/api/canvass/knocks/route.ts`:
  - Add to the imports: `import { inngest } from "@savvy/agents";`
  - In the `upsertCanvassKnock({ ... })` call, add:

```ts
      contractSignedAt: k.contractSignedAt ? new Date(k.contractSignedAt) : null,
      leadId: k.leadId ?? null,
```

  - After `if ("denied" in result) return reply({ error: "unauthorized" }, 401);` (and before the badge block), emit for a fresh unsigned sale:

```ts
  // A fresh sale with no contract yet starts the 30-min watch. Idempotent event
  // id so edits / appt→sale re-saves don't restart the clock.
  if (result.id && k.outcome === "sale" && !k.contractSignedAt) {
    try {
      await inngest.send({
        id: `sale:${result.id}`,
        name: "canvass/sale.logged",
        data: { tenantId: sess.tenantId, knockId: result.id, repId: sess.repId },
      });
    } catch (e) {
      log.error("canvass/sale.logged emit failed", { route: "/api/canvass/knocks", tenantId: sess.tenantId, msg: String(e) });
    }
  }
```

  - In the **GET** handler's `.select({ ... })`, add `leadId: canvassKnock.leadId,` so the field app can build the CRM link from team knocks.

- [ ] **Step 3: Add leadId to the eod sales list.** In `apps/web/src/app/api/canvass/eod/route.ts`:
  - Add `leadId: canvassKnock.leadId,` to the knocks `.select({ ... })`.
  - Add `leadId: string | null;` to the `sales` array's element type, and `leadId: k.leadId,` to the pushed sale object.

- [ ] **Step 4: Typecheck + lint.** `pnpm typecheck 2>&1 | tail -3 && pnpm lint 2>&1 | tail -3` — clean.

- [ ] **Step 5: Commit** `feat(canvass): knocks route emits sale.logged + carries lead_id; eod sales include leadId`.

---

### Task 6: Web — alerts endpoints + middleware

**Files:**
- Create: `apps/web/src/app/api/canvass/alerts/route.ts`
- Create: `apps/web/src/app/api/canvass/alerts/[id]/route.ts`
- Modify: `apps/web/src/middleware.ts`

**Interfaces:**
- Consumes: `withTenant`, `listAlerts`, `markAlertRead`, `markAllAlertsRead` from `@savvy/db`; the canvass-session/cors/rate-limit libs. Mirror the Phase 3 spiff routes exactly (imports, `runtime`, `OPTIONS`, `reply` helper, auth→rate-limit order, `await ctx.params`).

- [ ] **Step 1: `alerts/route.ts`** — GET list + POST `?action=read-all`:

```ts
import { NextResponse } from "next/server";
import { withTenant, listAlerts, markAllAlertsRead } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, POST, OPTIONS") });
}

export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });
  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass-read", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);
  const out = await withTenant(sess.tenantId, (tx) => listAlerts(tx, sess.tenantId, sess.repId));
  return reply(out, 200);
}

export async function POST(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });
  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);
  if (new URL(req.url).searchParams.get("action") !== "read-all") return reply({ error: "bad_action" }, 400);
  const n = await withTenant(sess.tenantId, (tx) => markAllAlertsRead(tx, sess.tenantId, sess.repId, new Date()));
  return reply({ ok: true, read: n }, 200);
}
```

- [ ] **Step 2: `alerts/[id]/route.ts`** — POST `?action=read`:

```ts
import { NextResponse } from "next/server";
import { withTenant, markAlertRead } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "POST, OPTIONS") });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const headers = canvassCors(req, "POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });
  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);
  const { id } = await ctx.params;
  if (new URL(req.url).searchParams.get("action") !== "read") return reply({ error: "bad_action" }, 400);
  const changed = await withTenant(sess.tenantId, (tx) => markAlertRead(tx, sess.tenantId, id, sess.repId, new Date()));
  return reply({ ok: changed }, 200);
}
```

- [ ] **Step 3: Middleware allowlist.** In `apps/web/src/middleware.ts`, add `alerts` to the main canvass alternation (`...|spiffs|spiff|alerts)$/`) and a new element mirroring the spiff `/:id` one: `/^\/api\/canvass\/alerts\/[^/]+$/,`. Read the exact current form first; drop nothing.

- [ ] **Step 4: Typecheck + lint** clean. **Commit** `feat(canvass): alerts endpoints (list / read / read-all) + middleware allowlist`.

---

### Task 7: Field app — stamp on sign, alerts bell, CRM link (v1.17.0-beta)

**Files:**
- Modify: `~/Sites/savvy-canvass/index.html`, `~/Sites/savvy-canvass/sw.js`

**Interfaces:**
- Consumes existing helpers: `canvassBase()`, `authHeaders()`, `esc()`, `flash()`, `save()`, `pushKnock()`, `isMgr()`, `db.knocks`, `db.docs`, `cur`. New: `crmBase()`, `pullAlerts()`, `renderAlerts()`, `window.alertOpen`, `window.markAllAlerts`.

- [ ] **Step 1: Read anchors.** In `index.html`: `pushCRM(id)` (~1428-1463 — POSTs the contract to `db.company.webhook` and gets `{leadId}` back; currently reads only `r.ok`), `newDoc.knockId` (docs carry their sale knock's id), `syncTick()` / `startTeamSync()` (30s loop), `renderHeader()` + the `#syncChip` header area, `updateSyncChip()`, `APP_VERSION` (line ~399), and `canvassBase()` (~1928).

- [ ] **Step 2: Stamp the sale knock on contract sign.** In `pushCRM`, where the response comes back (`const r = await fetch(db.company.webhook, ...)` → `d.crm = r.ok ? 'sent ✓' : ...`), on success parse the body and stamp the linked knock:

```js
    const r=await fetch(db.company.webhook,{method:'POST',headers:hdrs,body:JSON.stringify(payload)});
    d.crm=r.ok?'sent ✓':'failed ('+r.status+')';
    if(r.ok){
      let leadId=null;try{leadId=(await r.json()).leadId||null}catch(e){}
      const k=d.knockId&&db.knocks.find(x=>x.id===d.knockId);
      if(k){k.contractSignedAt=new Date().toISOString();if(leadId)k.leadId=leadId;k.synced=false;save();pushKnock(k,null)}
    }
```

> This re-upserts the sale knock (same clientId, same rep) with `contractSignedAt` + `leadId`, silencing the 30-min watcher and giving the sale a CRM link. `pushKnock` must send `contractSignedAt`/`leadId` — confirm the knock-push body (search the `pushKnock` fn / the `/knocks` POST body builder ~line 2076) includes them; if not, ADD `contractSignedAt:k.contractSignedAt||undefined, leadId:k.leadId||undefined` to that JSON body.

- [ ] **Step 3: CRM deep-link helper + apply.** Add near `canvassBase()`:

```js
function crmBase(){return canvassBase().replace(/\/api\/canvass$/,'')}
function crmLink(leadId){return leadId?'<a href="'+crmBase()+'/leads/'+encodeURIComponent(leadId)+'" target="_blank" rel="noopener" style="color:var(--acc)">View in CRM ↗</a>':''}
```

In Slice 1's `openReportSale` read-only card and (Step 5) the alert item, replace the "coming soon" placeholder with `crmLink(s.leadId)` when a `leadId` is present (the `/eod` sales now include `leadId`).

- [ ] **Step 4: Alerts bell in the header.** In the header markup (next to `#syncChip`), add:

```html
<button id="alertBell" class="btn sec sm" style="display:none;position:relative" onclick="alertOpen()">🔔<span id="alertDot" style="display:none;position:absolute;top:-4px;right:-4px;background:var(--red);color:#fff;border-radius:10px;font-size:10px;padding:0 5px"></span></button>
```

Add an Alerts modal/sheet (reuse the `detailModal`/`detailSheet` pattern, or a new `#alertModal` with `#alertSheet`).

- [ ] **Step 5: pullAlerts + render.**

```js
let _alerts=[];
async function pullAlerts(){
  const h=authHeaders();if(!h){const b=document.getElementById('alertBell');if(b)b.style.display='none';return}
  try{
    const r=await fetch(canvassBase()+'/alerts',{headers:h});
    if(!r.ok)return;
    const j=await r.json();_alerts=j.alerts||[];
    const bell=document.getElementById('alertBell'),dot=document.getElementById('alertDot');
    if(!bell)return;
    bell.style.display=_alerts.length?'':'none';
    if(j.unread>0){dot.style.display='';dot.textContent=j.unread}else dot.style.display='none';
  }catch(e){}
}
window.alertOpen=()=>{
  const sheet=document.getElementById('alertSheet');
  sheet.innerHTML='<h3>Alerts</h3>'+(_alerts.length?_alerts.map(a=>{
    const dotc=a.readAt?'':'style="border-left:3px solid var(--red);padding-left:8px"';
    const knockLink=a.knockId?'<span style="text-decoration:underline;cursor:pointer;color:var(--acc)" onclick="openReportSale(\''+esc(a.knockId)+'\')">open</span>':'';
    return '<div class="list-item" '+dotc+'><div class="t"><span>'+esc(a.title)+'</span></div><div class="s">'+esc(a.body)+'</div><div class="s" style="margin-top:4px">'+[knockLink,crmLink(a.leadId)].filter(Boolean).join(' · ')+'</div></div>';
  }).join(''):'<div class="empty">No alerts.</div>')+'<div class="row" style="margin-top:12px"><button class="btn sec" onclick="closeAlerts()">Close</button>'+(_alerts.some(a=>!a.readAt)?'<button class="btn" onclick="markAllAlerts()">Mark all read</button>':'')+'</div>';
  document.getElementById('alertModal').classList.add('open');
};
window.closeAlerts=()=>document.getElementById('alertModal').classList.remove('open');
window.markAllAlerts=async()=>{const h=authHeaders();if(!h)return;try{await fetch(canvassBase()+'/alerts?action=read-all',{method:'POST',headers:h});await pullAlerts();alertOpen()}catch(e){}};
```

> `openReportSale` (Slice 1) resolves a local knock → editable card, else a read-only card. An alert's `knockId` is the SERVER knock id; the rep's own sale knock has `id === clientId === server id`, so `openReportSale` finds it. For a manager whose device lacks the knock, `openReportSale` currently returns silently for an unknown id — acceptable (the CRM link is the manager's path); optionally have it fall back to a minimal read-only card.

- [ ] **Step 6: Wire pullAlerts into the sync loop.** In `syncTick()`, add `await pullAlerts();` alongside the existing `pullTeamKnocks()`.

- [ ] **Step 7: Version bumps.** `APP_VERSION='1.17.0-beta'`; `sw.js` `V='canvass-v1.17.0'`.

- [ ] **Step 8: JS validity** — parse every inline `<script>` via `new Function(body)` in Node (the Slice-1 technique) + `node --check sw.js`.

- [ ] **Step 9: Commit + deploy.** `git add index.html sw.js && git commit -m "..."` then the exact prod command used by Slice 1: `npx wrangler pages deploy . --project-name savvy-canvass --commit-dirty=true`. Report the deploy URL + confirm the prod alias serves `1.17.0-beta`.

---

## Post-execution (controller, after all tasks pass review)

1. Full suite green: clear synthetic debris, `pnpm typecheck && pnpm lint && npx vitest run --no-file-parallelism`.
2. Final whole-branch review (most capable model) over `merge-base(main,HEAD)..HEAD` — adversarial on the alert money/PII path + tenant isolation + the emit/idempotency logic.
3. Merge to main.
4. Apply the migration to prod Supabase via MCP `apply_migration` (project ref `ngczjltbcuvrjosxgqrm`; local drizzle number is one behind — the local `0078_*` applies as prod `0079`).
5. Deploy backend `npx vercel --prod --archive=tgz --force --scope advosy`.
6. Verify `/api/canvass/alerts` returns 401 unauthenticated; field app v1.17.0-beta serves on the prod alias.

## Non-goals (YAGNI)

- No SMS/text (documented seam only). No push notifications. No alert preferences or configurable threshold. No auto-dismiss of a late-stamped alert. No new alert kinds beyond `sale_no_contract`.
