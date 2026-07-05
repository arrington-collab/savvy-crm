# Cell 6 — A2P 10DLC + SMS Deliverability Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the SMS deliverability monitoring machine for Savvy: track Twilio delivery receipts, model per-tenant A2P/10DLC registration state, run a `comms.deliverability` evidence check that turns an unregistered tenant (or a low delivery rate / spam-error spike) into a break-glass card with exact registration steps, auto-throttle outbound below threshold, and surface registration state on the Agents page.

**Architecture:** A delivery-status column on `communication` fed by a Twilio `StatusCallback` webhook; A2P registration state stored in the existing `integration_connection.metadata` jsonb (no new table, mirrors the Vapi pattern); a custom `comms.deliverability` `EvidenceCheck` in the existing verification framework; a small extension to the exception reconciler so delivery-critical checks can force break-glass without a dollar threshold; an outbound throttle gate; and an Agents-page tile + Today-card remediation content rendered from the failing `check_key`.

**Tech Stack:** TypeScript · Drizzle/Postgres (RLS) · `@savvy/core` pure helpers + verification framework (Vitest) · `@savvy/integrations` Twilio wrapper (Vitest) · `@savvy/agents` health sweep + Inngest (Vitest, DI) · Next.js App Router route handler + server components · Playwright e2e.

**Spec:** `docs/superpowers/specs/first-20-cells.md` (Cell 6). Cell is DONE-in-prod when both tenants are A2P-registered and the delivery-rate check is green 14 days; this plan delivers the machine (merge ≠ done, per the contract). Only Bloom exists today; Alta's card is produced automatically when Alta exists (Cell 20). Twilio is mock-only today, so live sends are exercised via injected stubs.

**Base:** `origin/main` @ `b4f38f3`. **Next migration:** `0052` (verified: last is `0051_neat_phalanx`).

## Global Constraints

- **Tenant isolation on every table/query.** `communication` already carries `tenant_id` + `tenantIsolation()` RLS. The delivery webhook has no tenant session, so it updates by the globally-unique `twilio_sid` via `adminDb` (RLS-bypass) — this is the ONLY admin-scoped write and it must be keyed on `twilio_sid` only. No new tenant-scoped table is added; A2P state lives in `integration_connection.metadata`.
- **Fail-soft everywhere.** The check never throws (framework wraps it). The webhook returns 200 even on unknown SID (Twilio retries otherwise). The throttle defaults to "allow" on any error (never silently drops sends because of a monitoring bug).
- **No live provider hard-coding.** Twilio creds resolve through the existing `resolveTelephonyCreds` / secret-box path. The status-callback URL comes from env (`APP_BASE_URL`), never a literal.
- **No secrets in the repo.** Nothing reads or writes a literal key. `INTEGRATION_SECRET_KEY` stays in env.
- **Migrations via `pnpm --filter @savvy/db db:generate`** — never hand-numbered. Next = `0052`.
- **`apps/web` is NOT in vitest** — validate web changes with typecheck + lint + Playwright e2e.
- **No `.js` import extensions** in package/app `src` (breaks Turbopack). The `packages/db` *tests* do use `.js` — match each file's existing convention.
- **Evidence key is `comms.deliverability`** (supersedes the deferred `comms.delivery` stub named in `checks.ts:14`). Delivery-rate threshold and the spam error code (`30007`) are named constants, not magic numbers inline.
- **Local dev DB has known 0045 journal drift** — `db:migrate` may fail mid-sequence; apply the new migration's SQL directly to the local DB if so (it's additive), and note it. CI applies cleanly on a fresh DB.

---

### Task 1: DB — delivery-status columns on `communication` (migration 0052) + receipt writer

**Files:**
- Modify: `packages/db/src/schema/comms.ts` (add 2 columns to `communication`)
- Create: `packages/db/src/lifecycle/delivery-status.ts`
- Modify: `packages/db/src/index.ts` (export)
- Create: `packages/db/src/lifecycle/delivery-status.test.ts`
- Generate: `packages/db/drizzle/0052_*.sql` via `db:generate`

**Interfaces:**
- Produces:
  - `communication.deliveryStatus: text | null` (`queued|sent|delivered|undelivered|failed` — raw Twilio MessageStatus) and `communication.deliveryErrorCode: text | null` (e.g. `"30007"`).
  - `applyDeliveryReceipt(input: { twilioSid: string; status: string; errorCode?: string | null }): Promise<{ updated: number }>` — updates the matching `communication` row(s) by `twilio_sid` via `adminDb` (webhook has no tenant session). Returns count (0 if SID unknown — caller treats as no-op).

- [ ] **Step 1: Add the columns** — in `packages/db/src/schema/comms.ts`, add to the `communication` table definition (after `twilioSid`):
```ts
  deliveryStatus: text("delivery_status"),      // raw Twilio MessageStatus of the last receipt
  deliveryErrorCode: text("delivery_error_code"), // Twilio ErrorCode on failed/undelivered (e.g. 30007)
```
(`text` is already imported in this file.)

- [ ] **Step 2: Generate the migration** — `pnpm --filter @savvy/db db:generate`. Confirm it produces `packages/db/drizzle/0052_*.sql` that only `ALTER TABLE "communication" ADD COLUMN "delivery_status"` + `"delivery_error_code"` and touches NO other table. Paste the SQL into your report. If it numbers other than 0052 or bundles unrelated drift, STOP and report BLOCKED.

- [ ] **Step 3: Write the failing test** — create `packages/db/src/lifecycle/delivery-status.test.ts`. Seed a tenant + a `communication` row (outbound sms, `twilioSid: "SMtest1"`) via `adminDb`, then:
```ts
import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { adminDb, tenant, communication, eq } from "../index";
import { applyDeliveryReceipt } from "./delivery-status";

let tenantId: string; let sid: string;
beforeAll(async () => {
  tenantId = randomUUID(); sid = `SM${randomUUID().slice(0, 10)}`;
  await adminDb.insert(tenant).values({ id: tenantId, name: "DS Co", publicKey: `ds-${tenantId.slice(0,8)}` });
  await adminDb.insert(communication).values({ tenantId, channel: "sms", direction: "outbound", to: "+15551230000", body: "hi", twilioSid: sid });
});
afterAll(async () => {
  await adminDb.delete(communication).where(eq(communication.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

it("updates delivery_status + error_code by twilio_sid", async () => {
  const r = await applyDeliveryReceipt({ twilioSid: sid, status: "delivered" });
  expect(r.updated).toBe(1);
  const [row] = await adminDb.select().from(communication).where(eq(communication.twilioSid, sid));
  expect(row!.deliveryStatus).toBe("delivered");
});
it("records error code on failure", async () => {
  await applyDeliveryReceipt({ twilioSid: sid, status: "undelivered", errorCode: "30007" });
  const [row] = await adminDb.select().from(communication).where(eq(communication.twilioSid, sid));
  expect(row!.deliveryStatus).toBe("undelivered");
  expect(row!.deliveryErrorCode).toBe("30007");
});
it("returns 0 for an unknown sid (no throw)", async () => {
  const r = await applyDeliveryReceipt({ twilioSid: "SMnope", status: "delivered" });
  expect(r.updated).toBe(0);
});
```
(Confirm `communication` and `eq` are exported from `../index` — mirror how `delivery-status.test.ts`'s sibling tests import; if `eq` isn't re-exported there, import it from `drizzle-orm`.)

- [ ] **Step 4: Run to verify it fails** — `cd packages/db && pnpm exec vitest run src/lifecycle/delivery-status.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 5: Implement** — create `packages/db/src/lifecycle/delivery-status.ts`:
```ts
import { eq } from "drizzle-orm";
import { adminDb } from "../admin-client";
import { communication } from "../schema/index";

/** Apply a Twilio delivery receipt to the communication row(s) with this SID.
 *  The status webhook has no tenant session, so this is admin-scoped and keyed
 *  ONLY on the globally-unique twilio_sid. Returns rows updated (0 = unknown SID). */
export async function applyDeliveryReceipt(input: {
  twilioSid: string; status: string; errorCode?: string | null;
}): Promise<{ updated: number }> {
  const rows = await adminDb
    .update(communication)
    .set({ deliveryStatus: input.status, deliveryErrorCode: input.errorCode ?? null })
    .where(eq(communication.twilioSid, input.twilioSid))
    .returning({ id: communication.id });
  return { updated: rows.length };
}
```
(Confirm the admin client import path against a sibling in `packages/db/src/lifecycle/` — several import `adminDb` from `../admin-client`. Match it, no `.js` in src.)

- [ ] **Step 6: Export** — add to `packages/db/src/index.ts`: `export { applyDeliveryReceipt } from "./lifecycle/delivery-status";`

- [ ] **Step 7: Apply locally + verify + typecheck + commit**
```bash
pnpm --filter @savvy/db db:migrate    # if it fails on 0045 drift, apply 0052 SQL directly (additive) and note it
cd packages/db && pnpm exec vitest run src/lifecycle/delivery-status.test.ts   # PASS
cd ../.. && pnpm --filter @savvy/db typecheck
git add packages/db/src/schema/comms.ts packages/db/src/lifecycle/delivery-status.ts packages/db/src/lifecycle/delivery-status.test.ts packages/db/src/index.ts packages/db/drizzle/
git commit -m "feat(db): communication delivery_status + receipt writer (cell 6, migration 0052)"
```
(Run on prod post-merge, alongside any pending migrations.)

---

### Task 2: Integrations — Twilio send path carries statusCallback + messagingServiceSid

**Files:**
- Modify: `packages/integrations/src/twilio.ts`
- Modify: `packages/integrations/src/twilio.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SmsSender.sendSms` opts gain optional `statusCallback?: string` and `messagingServiceSid?: string`. `makeTwilioSms` forwards both to `messages.create` (only when present — when `messagingServiceSid` is set it is passed alongside; `from` stays for non-A2P). Backward compatible: existing callers passing `{ to, from, body }` are unchanged.

- [ ] **Step 1: Write the failing test** — in `packages/integrations/src/twilio.test.ts`, add a case that injects a fake twilio client (mirror how the file already stubs `messages.create`) and asserts that when `statusCallback` + `messagingServiceSid` are passed, they reach `messages.create`:
```ts
it("forwards statusCallback and messagingServiceSid to messages.create when provided", async () => {
  const created: Record<string, unknown>[] = [];
  const fakeClient = { messages: { create: async (o: Record<string, unknown>) => { created.push(o); return { sid: "SM1" }; } } };
  const sender = makeTwilioSmsWithClient(fakeClient); // see Step 3 note on injection
  await sender.sendSms({ to: "+1", from: "+2", body: "b", statusCallback: "https://x/cb", messagingServiceSid: "MG1" });
  expect(created[0]).toMatchObject({ to: "+1", body: "b", statusCallback: "https://x/cb", messagingServiceSid: "MG1" });
});
it("omits statusCallback/messagingServiceSid when not provided", async () => {
  const created: Record<string, unknown>[] = [];
  const fakeClient = { messages: { create: async (o: Record<string, unknown>) => { created.push(o); return { sid: "SM2" }; } } };
  const sender = makeTwilioSmsWithClient(fakeClient);
  await sender.sendSms({ to: "+1", from: "+2", body: "b" });
  expect(created[0]).not.toHaveProperty("statusCallback");
  expect(created[0]).not.toHaveProperty("messagingServiceSid");
});
```
Read the existing `twilio.test.ts` first: if it already has a client-injection seam, use it and drop the `makeTwilioSmsWithClient` note. If not, in Step 3 refactor `makeTwilioSms` to build its client via a small internal factory and export a test-only `makeTwilioSmsWithClient(client)` used by both — do NOT change the public `makeTwilioSms(creds)` signature.

- [ ] **Step 2: Run to verify it fails** — `cd packages/integrations && pnpm exec vitest run src/twilio.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** — in `packages/integrations/src/twilio.ts`:
  - Extend the `SmsSender` opts type:
```ts
export interface SmsSender {
  sendSms(opts: { to: string; from: string; body: string; statusCallback?: string; messagingServiceSid?: string }): Promise<{ sid: string }>;
}
```
  - In the sender, build the create payload conditionally so unset fields are omitted:
```ts
async sendSms({ to, from, body, statusCallback, messagingServiceSid }) {
  const client = twilio(creds.accountSid, creds.authToken);
  const payload: Record<string, unknown> = { to, from, body };
  if (statusCallback) payload.statusCallback = statusCallback;
  if (messagingServiceSid) payload.messagingServiceSid = messagingServiceSid;
  const msg = await client.messages.create(payload as Parameters<typeof client.messages.create>[0]);
  return { sid: msg.sid };
}
```
  - Add the client-injection seam if the test needs it (test-only export), keeping `makeTwilioSms(creds)` and `twilioSms` behavior identical.

- [ ] **Step 4: Run + full integrations suite + typecheck + commit**
```bash
cd packages/integrations && pnpm exec vitest run src/twilio.test.ts   # PASS
pnpm --filter @savvy/integrations test                                 # full suite green (comms.test etc.)
cd ../.. && pnpm --filter @savvy/integrations typecheck
git add packages/integrations/src/twilio.ts packages/integrations/src/twilio.test.ts
git commit -m "feat(integrations): sendSms carries statusCallback + messagingServiceSid (cell 6)"
```

---

### Task 3: Web — Twilio SMS status-callback webhook

**Files:**
- Create: `apps/web/src/app/api/twilio/status/route.ts`
- Read first (pattern): `apps/web/src/app/api/twilio/inbound/route.ts` (signature validation + form parsing)

**Interfaces:**
- Consumes: `applyDeliveryReceipt` (Task 1).
- Produces: `POST /api/twilio/status` — parses Twilio's `application/x-www-form-urlencoded` StatusCallback (`MessageSid`, `MessageStatus`, `ErrorCode`), calls `applyDeliveryReceipt`, always returns `200`.

- [ ] **Step 1: Read the inbound route** — open `apps/web/src/app/api/twilio/inbound/route.ts` and replicate exactly: how it reads the raw body / form fields, whether/how it validates the `X-Twilio-Signature` header, and the response shape. Match that validation approach (do not invent a weaker one). Note in your report which validation the inbound route uses.

- [ ] **Step 2: Implement the route** — create `apps/web/src/app/api/twilio/status/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { applyDeliveryReceipt } from "@savvy/db";
// If inbound/route.ts validates X-Twilio-Signature via a shared helper, import and use the SAME helper here.

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const sid = String(form.get("MessageSid") ?? form.get("SmsSid") ?? "");
  const status = String(form.get("MessageStatus") ?? form.get("SmsStatus") ?? "");
  const errorCode = form.get("ErrorCode") ? String(form.get("ErrorCode")) : null;
  if (sid && status) {
    try { await applyDeliveryReceipt({ twilioSid: sid, status, errorCode }); }
    catch { /* fail-soft: never 500 a delivery receipt */ }
  }
  return new NextResponse("", { status: 200 });
}
```
Add signature validation to match the inbound route (reject with 403 on mismatch, same as inbound) BEFORE the body parse if inbound does so. Keep the 200-on-success contract.

- [ ] **Step 3: Typecheck + lint + commit**
```bash
pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint   # clean (pre-existing warnings OK)
git add "apps/web/src/app/api/twilio/status/route.ts"
git commit -m "feat(web): Twilio SMS delivery status-callback webhook (cell 6)"
```
(e2e coverage lands in Task 8.)

---

### Task 4: Core + DB — A2P registration state model

**Files:**
- Create: `packages/core/src/a2p.ts`
- Create: `packages/core/src/a2p.test.ts`
- Modify: `packages/core/src/index.ts` (export)
- Create: `packages/db/src/lifecycle/a2p.ts`
- Modify: `packages/db/src/index.ts` (export)
- Create: `packages/db/src/lifecycle/a2p.test.ts`
- Read first (pattern): `packages/db/src/lifecycle/telephony.ts` (`getTelephonyConnection`, `upsertTwilioConnection`, metadata merge)

**Interfaces:**
- Produces:
  - Core (pure): `interface A2pState { brandStatus: string | null; campaignStatus: string | null; messagingServiceSid: string | null }` and `isA2pRegistered(state: A2pState | null, connectionActive: boolean): boolean` — true iff `connectionActive && messagingServiceSid` present && `campaignStatus` is one of `A2P_REGISTERED_STATUSES` (`["verified","registered","active"]`).
  - DB: `getA2pRegistration(tenantId): Promise<{ registered: boolean; state: A2pState; connectionActive: boolean }>` (reads the twilio `integration_connection`; missing connection ⇒ `registered:false`, empty state, `connectionActive:false`) and `setA2pRegistration(tenantId, patch: Partial<A2pState>): Promise<void>` (merges into `metadata.a2p` on the twilio connection).

- [ ] **Step 1: Core failing test** — `packages/core/src/a2p.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { isA2pRegistered } from "./a2p";

describe("isA2pRegistered", () => {
  it("false when connection inactive", () => {
    expect(isA2pRegistered({ brandStatus: "verified", campaignStatus: "verified", messagingServiceSid: "MG1" }, false)).toBe(false);
  });
  it("false when no messaging service", () => {
    expect(isA2pRegistered({ brandStatus: "verified", campaignStatus: "verified", messagingServiceSid: null }, true)).toBe(false);
  });
  it("false when campaign not in registered set", () => {
    expect(isA2pRegistered({ brandStatus: "verified", campaignStatus: "pending", messagingServiceSid: "MG1" }, true)).toBe(false);
  });
  it("true when active + messaging service + campaign registered", () => {
    expect(isA2pRegistered({ brandStatus: "verified", campaignStatus: "verified", messagingServiceSid: "MG1" }, true)).toBe(true);
  });
  it("false for null state", () => {
    expect(isA2pRegistered(null, true)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `cd packages/core && pnpm exec vitest run src/a2p.test.ts`. FAIL.

- [ ] **Step 3: Implement core** — `packages/core/src/a2p.ts`:
```ts
/** Per-tenant A2P 10DLC registration state (Cell 6). Stored on the Twilio
 *  integration_connection.metadata.a2p; empty until the owner registers. */
export interface A2pState {
  brandStatus: string | null;
  campaignStatus: string | null;
  messagingServiceSid: string | null;
}

export const A2P_REGISTERED_STATUSES = ["verified", "registered", "active"] as const;

/** True only when the connection is active, a Messaging Service exists, and the
 *  campaign is in a registered status — i.e. SMS can flow through A2P. */
export function isA2pRegistered(state: A2pState | null, connectionActive: boolean): boolean {
  if (!state || !connectionActive) return false;
  if (!state.messagingServiceSid) return false;
  const s = (state.campaignStatus ?? "").toLowerCase();
  return (A2P_REGISTERED_STATUSES as readonly string[]).includes(s);
}
```
Export from `packages/core/src/index.ts`: `export * from "./a2p";`

- [ ] **Step 4: DB failing test** — `packages/db/src/lifecycle/a2p.test.ts`. Seed a tenant, upsert a twilio connection (use `upsertTwilioConnection` from `telephony.ts` — read its signature; it seals a secret + sets status). Then:
```ts
// after upserting an ACTIVE twilio connection for tenantId:
await setA2pRegistration(tenantId, { messagingServiceSid: "MG1", campaignStatus: "verified", brandStatus: "verified" });
const r = await getA2pRegistration(tenantId);
expect(r.connectionActive).toBe(true);
expect(r.state.messagingServiceSid).toBe("MG1");
expect(r.registered).toBe(true);
// and for a tenant with NO connection:
const none = await getA2pRegistration(otherTenantId);
expect(none.registered).toBe(false);
expect(none.connectionActive).toBe(false);
```
(Match the seeding/teardown style of `telephony`'s existing lifecycle tests if present; otherwise mirror `supplier-allowlist.test.ts`. Set the connection status to `active` so `connectionActive` is true — check `setTelephonyConnectionStatus`.)

- [ ] **Step 5: Run to verify fail** — `cd packages/db && pnpm exec vitest run src/lifecycle/a2p.test.ts`. FAIL.

- [ ] **Step 6: Implement DB** — `packages/db/src/lifecycle/a2p.ts`. Read `telephony.ts` for the exact `integration_connection` query + metadata-merge pattern (`requestManagedTelephonySetup` shows a metadata merge). Implement:
```ts
import { and, eq } from "drizzle-orm";
import { withTenant } from "../tenant";
import { integrationConnection } from "../schema/integrations";
import type { A2pState } from "@savvy/core";
import { isA2pRegistered } from "@savvy/core";

const emptyState = (): A2pState => ({ brandStatus: null, campaignStatus: null, messagingServiceSid: null });

export async function getA2pRegistration(tenantId: string): Promise<{ registered: boolean; state: A2pState; connectionActive: boolean }> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.select({ status: integrationConnection.status, metadata: integrationConnection.metadata })
      .from(integrationConnection)
      .where(and(eq(integrationConnection.tenantId, tenantId), eq(integrationConnection.provider, "twilio")));
    if (!row) return { registered: false, state: emptyState(), connectionActive: false };
    const a2p = ((row.metadata ?? {}) as Record<string, unknown>).a2p as Partial<A2pState> | undefined;
    const state: A2pState = { brandStatus: a2p?.brandStatus ?? null, campaignStatus: a2p?.campaignStatus ?? null, messagingServiceSid: a2p?.messagingServiceSid ?? null };
    const connectionActive = row.status === "active";
    return { registered: isA2pRegistered(state, connectionActive), state, connectionActive };
  });
}

export async function setA2pRegistration(tenantId: string, patch: Partial<A2pState>): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [row] = await tx.select({ metadata: integrationConnection.metadata })
      .from(integrationConnection)
      .where(and(eq(integrationConnection.tenantId, tenantId), eq(integrationConnection.provider, "twilio")));
    const prior = (row?.metadata ?? {}) as Record<string, unknown>;
    const priorA2p = (prior.a2p ?? {}) as Record<string, unknown>;
    await tx.update(integrationConnection)
      .set({ metadata: { ...prior, a2p: { ...priorA2p, ...patch } } })
      .where(and(eq(integrationConnection.tenantId, tenantId), eq(integrationConnection.provider, "twilio")));
  });
}
```
Export from `packages/db/src/index.ts`: `export { getA2pRegistration, setA2pRegistration } from "./lifecycle/a2p";`

- [ ] **Step 7: Verify pass + typecheck + commit**
```bash
cd packages/core && pnpm exec vitest run src/a2p.test.ts && cd ../db && pnpm exec vitest run src/lifecycle/a2p.test.ts   # PASS
cd ../.. && pnpm --filter @savvy/core typecheck && pnpm --filter @savvy/db typecheck
git add packages/core/src/a2p.ts packages/core/src/a2p.test.ts packages/core/src/index.ts packages/db/src/lifecycle/a2p.ts packages/db/src/lifecycle/a2p.test.ts packages/db/src/index.ts
git commit -m "feat(core,db): A2P 10DLC registration state model (cell 6)"
```

---

### Task 5: Core — `comms.deliverability` evidence check + break-glass forcing

**Files:**
- Create: `packages/core/src/verification/deliverability.ts`
- Modify: `packages/core/src/verification/checks.ts` (register the key)
- Modify: `packages/core/src/verification/deliverability.test.ts` (create)
- Create: `packages/core/src/verification/break-glass-keys.ts`
- Modify: `packages/db/src/lifecycle/task-health.ts` (`reconcileTaskExceptions` — force break-glass for delivery-critical keys)
- Modify/Read: the registry seed `packages/db/seeds/master-task-list.ts` (add a `comms.deliverability` task row)
- Modify: `packages/db/src/lifecycle/task-health.test.ts` OR `packages/db/tests/*` (reconcile break-glass test)

**Interfaces:**
- Consumes: `communication.deliveryStatus` (Task 1), `getA2pRegistration` (Task 4).
- Produces:
  - `evidenceChecks["comms.deliverability"]` — a custom `EvidenceCheck`.
  - `BREAK_GLASS_ON_FAIL_CHECK_KEYS: ReadonlySet<string>` in `@savvy/core` (contains `"comms.deliverability"`).
  - `reconcileTaskExceptions` forces `breakGlass=true` + `severity="high"` when the failing task's `check_key ∈ BREAK_GLASS_ON_FAIL_CHECK_KEYS`, regardless of dollar impact.

**Check semantics (from the spec):**
- Tenant NOT A2P-registered ⇒ **fail** (details: "A2P 10DLC not registered — SMS may be filtered"). This is the unregistered break-glass card.
- Registered ⇒ compute delivery rate over the window from `communication` outbound sms rows that have a terminal `delivery_status`: `delivered / (delivered + failed + undelivered)`. Fail if rate `< DELIVERY_RATE_FLOOR` (0.90) OR any row carries the spam error code `30007`. Otherwise pass. If registered and there are zero terminal rows in the window ⇒ **skip** (nothing to measure yet).
- 14-day-green is applied by the health layer, not here.

- [ ] **Step 1: Break-glass key set** — create `packages/core/src/verification/break-glass-keys.ts`:
```ts
/** Check keys whose failure is a break-glass event on a non-dollar basis —
 *  active customer-facing bleed the owner must see immediately (Cell 6). */
export const BREAK_GLASS_ON_FAIL_CHECK_KEYS: ReadonlySet<string> = new Set(["comms.deliverability"]);
```
Export it from `packages/core/src/verification/index.ts` (add `export * from "./break-glass-keys";`) and ensure it's reachable via `@savvy/core` (check how `verification/index` is surfaced in `packages/core/src/index.ts`).

- [ ] **Step 2: Constants + failing test** — create `packages/core/src/verification/deliverability.test.ts`. Use the framework's DI: an `EvidenceCtx` with a fake `db.query` and an injected `getRegistration`. Because the check needs `getA2pRegistration` (DB) but the check module must stay pure/testable, the check factory takes the registration loader as a parameter and `checks.ts` wires the real one. Test:
```ts
import { describe, it, expect } from "vitest";
import { makeDeliverabilityCheck, DELIVERY_RATE_FLOOR, SPAM_ERROR_CODE } from "./deliverability";

const ctx = (rows: Record<string, unknown>[]) => ({
  tenantId: "t", window: { start: new Date(0), end: new Date() },
  db: { query: async () => ({ rows }) },
}) as any;

describe("comms.deliverability", () => {
  it("fails when not registered", async () => {
    const check = makeDeliverabilityCheck(async () => ({ registered: false }));
    const r = await check(ctx([]));
    expect(r.status).toBe("fail");
    expect(r.details).toMatch(/not registered/i);
  });
  it("skips when registered but no terminal rows", async () => {
    const check = makeDeliverabilityCheck(async () => ({ registered: true }));
    const r = await check(ctx([{ delivered: 0, failed: 0, undelivered: 0, spam: 0 }]));
    expect(r.status).toBe("skip");
  });
  it("passes when delivery rate above floor and no spam", async () => {
    const check = makeDeliverabilityCheck(async () => ({ registered: true }));
    const r = await check(ctx([{ delivered: 98, failed: 1, undelivered: 1, spam: 0 }]));
    expect(r.status).toBe("pass");
  });
  it("fails below the delivery-rate floor", async () => {
    const check = makeDeliverabilityCheck(async () => ({ registered: true }));
    const r = await check(ctx([{ delivered: 50, failed: 30, undelivered: 20, spam: 0 }]));
    expect(r.status).toBe("fail");
  });
  it("fails on a spam error-code (30007) even with high delivery", async () => {
    const check = makeDeliverabilityCheck(async () => ({ registered: true }));
    const r = await check(ctx([{ delivered: 99, failed: 1, undelivered: 0, spam: 3 }]));
    expect(r.status).toBe("fail");
    expect(r.details).toMatch(new RegExp(SPAM_ERROR_CODE));
  });
});
```

- [ ] **Step 3: Run to verify fail** — `cd packages/core && pnpm exec vitest run src/verification/deliverability.test.ts`. FAIL.

- [ ] **Step 4: Implement the check** — create `packages/core/src/verification/deliverability.ts`:
```ts
import type { EvidenceCheck, EvidenceCtx } from "./types";

export const DELIVERY_RATE_FLOOR = 0.9;
export const SPAM_ERROR_CODE = "30007";

/** Aggregate one window's terminal SMS receipts for a tenant. One row expected. */
const AGG_SQL = `
  select
    count(*) filter (where delivery_status = 'delivered')   as delivered,
    count(*) filter (where delivery_status = 'failed')      as failed,
    count(*) filter (where delivery_status = 'undelivered') as undelivered,
    count(*) filter (where delivery_error_code = '${SPAM_ERROR_CODE}') as spam
  from communication
  where tenant_id = $1 and direction = 'outbound' and channel = 'sms'
    and created_at >= $2 and created_at < $3
    and delivery_status in ('delivered','failed','undelivered')`;

/** Factory so the A2P registration loader is injectable (real one wired in checks.ts). */
export function makeDeliverabilityCheck(
  loadRegistration: (tenantId: string) => Promise<{ registered: boolean }>,
): EvidenceCheck {
  return async (ctx: EvidenceCtx) => {
    const reg = await loadRegistration(ctx.tenantId);
    if (!reg.registered) {
      return { status: "fail", details: "A2P 10DLC not registered — SMS may be silently filtered", refs: [] };
    }
    const { rows } = await ctx.db.query<Record<string, number>>(AGG_SQL, [ctx.tenantId, ctx.window.start, ctx.window.end]);
    const r = rows[0] ?? { delivered: 0, failed: 0, undelivered: 0, spam: 0 };
    const delivered = Number(r.delivered), failed = Number(r.failed), undelivered = Number(r.undelivered), spam = Number(r.spam);
    const total = delivered + failed + undelivered;
    if (total === 0) return { status: "skip", details: "no terminal SMS receipts in window", refs: [] };
    if (spam > 0) return { status: "fail", details: `${spam} message(s) carrier-filtered (error ${SPAM_ERROR_CODE})`, refs: [] };
    const rate = delivered / total;
    if (rate < DELIVERY_RATE_FLOOR) {
      return { status: "fail", details: `delivery rate ${(rate * 100).toFixed(1)}% < ${DELIVERY_RATE_FLOOR * 100}% floor`, refs: [] };
    }
    return { status: "pass", details: `delivery rate ${(rate * 100).toFixed(1)}% over ${total} sends`, refs: [] };
  };
}
```

- [ ] **Step 5: Register the key** — in `packages/core/src/verification/checks.ts`, import the factory + the DB loader and register:
```ts
import { makeDeliverabilityCheck } from "./deliverability";
import { getA2pRegistration } from "@savvy/db";
// ...inside evidenceChecks:
  "comms.deliverability": makeDeliverabilityCheck((tenantId) => getA2pRegistration(tenantId).then((r) => ({ registered: r.registered }))),
```
**Check for an import cycle:** `@savvy/core` importing `@savvy/db` may be disallowed (db already imports core). If typecheck/build reveals a cycle, invert it: keep `makeDeliverabilityCheck` in core, and wire the real `getA2pRegistration` loader where the sweep builds the ctx (in `packages/agents/src/health-sweep.ts`), passing the check in via the registry lookup — i.e. register a placeholder in core that reads `ctx.loadRegistration` and have the sweep populate it. Prefer the simple direct wire; fall back to the ctx-injection form only if the cycle is real. Document which you used.

- [ ] **Step 6: Force break-glass in reconcile** — in `packages/db/src/lifecycle/task-health.ts`, `reconcileTaskExceptions`: after computing `dollarImpactCents` and the dollar-threshold `breakGlass`, OR-in the key-based force. You'll need the failing task's `check_key` (join `task_registry`). Change the break-glass computation to:
```ts
import { BREAK_GLASS_ON_FAIL_CHECK_KEYS } from "@savvy/core";
// ...where breakGlass is computed (~line 268), given the task's checkKey in scope:
const forced = ex.checkKey != null && BREAK_GLASS_ON_FAIL_CHECK_KEYS.has(ex.checkKey);
const breakGlass = forced || (thresholdCents !== null && dollarImpactCents >= thresholdCents);
const severity = forced ? "high" : ex.severity;
// use `severity` in the insert/update set()
```
Read the surrounding code to get `ex.checkKey` into scope — the open-exceptions/candidate loop must select `task_registry.check_key`. If it doesn't already, add the join/select. Keep all existing behavior when the key is not in the set.

- [ ] **Step 7: Seed the registry task** — read `packages/db/seeds/master-task-list.ts` and add one task row with `check_key = "comms.deliverability"` (domain: comms; owner persona matching the comms agent; severity high). Match the exact row shape of a sibling comms task (e.g. the `comms.body_quality` row). **Do NOT add a `CHECK_BINDINGS` entry if that breaks `master-task-list.test.ts`'s bound-set assertion** (known gotcha) — check that test first and update its expected count/set in the SAME commit if it asserts an exhaustive list.

- [ ] **Step 8: Reconcile break-glass test** — add a focused test (in the db package, mirroring existing `reconcileTaskExceptions` tests) proving: a `verification_mismatch`/fail on a task whose `check_key = "comms.deliverability"` yields `break_glass = true` + `severity = "high"` even with `$0` dollar impact; and a non-listed check with `$0` stays `break_glass = false`.

- [ ] **Step 9: Verify + full core + db suites + typecheck + commit**
```bash
cd packages/core && pnpm exec vitest run src/verification/deliverability.test.ts && pnpm --filter @savvy/core test
cd ../db && pnpm exec vitest run   # includes reconcile + seed tests; all green
cd ../.. && pnpm --filter @savvy/core typecheck && pnpm --filter @savvy/db typecheck
git add packages/core/src/verification/ packages/db/src/lifecycle/task-health.ts packages/db/seeds/master-task-list.ts packages/db/src/lifecycle/task-health.test.ts packages/db/tests/
git commit -m "feat(core,db): comms.deliverability check + break-glass forcing + registry seed (cell 6)"
```

---

### Task 6: Agents — auto-throttle outbound below the deliverability floor

**Files:**
- Create: `packages/core/src/deliverability-throttle.ts`
- Create: `packages/core/src/deliverability-throttle.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/agents/src/telephony.ts` (consult the throttle in the tenant SMS resolution/send path)
- Modify: `packages/agents/src/telephony.test.ts` (or the nearest send-path test)

**Interfaces:**
- Consumes: recent `communication` delivery aggregates.
- Produces: `shouldThrottleOutbound(agg: { delivered: number; failed: number; undelivered: number }, floor?: number): boolean` (pure) — true when terminal volume ≥ `MIN_SAMPLE` (20) AND rate `< floor` (default `DELIVERY_RATE_FLOOR`). Below the sample floor ⇒ never throttle (not enough signal). The send path calls a DB-backed `isOutboundThrottled(tenantId)` that loads a recent aggregate and applies `shouldThrottleOutbound`; when throttled it SKIPS the send (records nothing sent) so the existing `comms.deliverability` fail/card already surfaces the cause. Fail-soft: any error ⇒ not throttled.

- [ ] **Step 1: Pure failing test** — `packages/core/src/deliverability-throttle.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { shouldThrottleOutbound, MIN_SAMPLE } from "./deliverability-throttle";

describe("shouldThrottleOutbound", () => {
  it("does not throttle below the minimum sample", () => {
    expect(shouldThrottleOutbound({ delivered: 1, failed: 9, undelivered: 0 })).toBe(false); // 10 < MIN_SAMPLE
  });
  it("throttles when rate below floor with enough sample", () => {
    expect(shouldThrottleOutbound({ delivered: 10, failed: 15, undelivered: 5 })).toBe(true); // 30 samples, 33%
  });
  it("does not throttle a healthy rate", () => {
    expect(shouldThrottleOutbound({ delivered: 95, failed: 3, undelivered: 2 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify fail** → FAIL.

- [ ] **Step 3: Implement pure** — `packages/core/src/deliverability-throttle.ts`:
```ts
import { DELIVERY_RATE_FLOOR } from "./verification/deliverability";

export const MIN_SAMPLE = 20;

/** True when we have enough terminal receipts to trust the rate AND it's below floor. */
export function shouldThrottleOutbound(
  agg: { delivered: number; failed: number; undelivered: number },
  floor: number = DELIVERY_RATE_FLOOR,
): boolean {
  const total = agg.delivered + agg.failed + agg.undelivered;
  if (total < MIN_SAMPLE) return false;
  return agg.delivered / total < floor;
}
```
Export from `packages/core/src/index.ts`: `export * from "./deliverability-throttle";`

- [ ] **Step 4: Wire the send path** — read `packages/agents/src/telephony.ts` (`getTenantSms`). Add a DB-backed `isOutboundThrottled(tenantId)` (query the last-N-hours aggregate from `communication`, apply `shouldThrottleOutbound`, fail-soft to `false`), and in the SMS send path, when throttled, skip the actual `sendSms` and return a sentinel (mirroring the existing mock/fail-soft SID pattern in `drip.ts:104`) so no message goes out but the pipeline doesn't crash. Add a test to `telephony.test.ts` (or the send-path test) asserting: throttled tenant ⇒ `sendSms` NOT called; healthy tenant ⇒ called. Use DI/stubs consistent with the file.

- [ ] **Step 5: Verify + full agents suite + typecheck + commit**
```bash
cd packages/core && pnpm exec vitest run src/deliverability-throttle.test.ts
cd ../agents && pnpm exec vitest run src/telephony.test.ts && pnpm --filter @savvy/agents test
cd ../.. && pnpm --filter @savvy/core typecheck && pnpm --filter @savvy/agents typecheck
git add packages/core/src/deliverability-throttle.ts packages/core/src/deliverability-throttle.test.ts packages/core/src/index.ts packages/agents/src/telephony.ts packages/agents/src/telephony.test.ts
git commit -m "feat(agents): auto-throttle outbound SMS below deliverability floor (cell 6)"
```

---

### Task 7: Web — Agents page registration tile + Today-card remediation content

**Files:**
- Create: `apps/web/src/lib/deliverability-queries.ts`
- Modify: `apps/web/src/app/(app)/agents/page.tsx` (render the tile)
- Create: `apps/web/src/app/(app)/agents/DeliverabilityTile.tsx`
- Modify: the Today exception-card renderer (find it: the component that maps an exception/`check_key` to card copy — search `check_key`/exception rendering under `apps/web/src/app/(app)/today` or `components`)
- Read first: `apps/web/src/lib/agent-roster-queries.ts`, `apps/web/src/app/(app)/settings/integrations/TelephonyCard.tsx`

**Interfaces:**
- Consumes: `getA2pRegistration` (Task 4).
- Produces: UI only (validated by typecheck + lint).

- [ ] **Step 1: Query loader** — `apps/web/src/lib/deliverability-queries.ts`:
```ts
import "server-only";
import { getA2pRegistration } from "@savvy/db";
import { getTenantId } from "./tenant";

export async function getDeliverabilityStatus() {
  const tenantId = await getTenantId();
  return getA2pRegistration(tenantId); // { registered, state, connectionActive }
}
```

- [ ] **Step 2: Tile component** — create `DeliverabilityTile.tsx` (`"use client"` optional; server component fine). Render a card titled "SMS Deliverability (10DLC)" showing: `registered` → green "Registered"; else amber "Not registered — action required" plus the exact registration steps (see Step 4 copy). Mirror the card structure/classes of `TelephonyCard.tsx` / the existing Agents roster cards. Add `data-testid="deliverability-tile"`.

- [ ] **Step 3: Mount on Agents page** — in `agents/page.tsx`, call `getDeliverabilityStatus()` and render `<DeliverabilityTile status={...} />` in/near the roster grid (follow how the page currently lays out cards; keep the existing roster intact).

- [ ] **Step 4: Remediation copy (single source)** — create the registration-steps copy as a shared constant so the tile and the Today card agree. Put it in `apps/web/src/lib/deliverability-copy.ts`:
```ts
export const A2P_REGISTRATION_STEPS: { title: string; detail: string }[] = [
  { title: "Register your A2P Brand", detail: "In Twilio Console → Messaging → Regulatory Compliance, submit your business (legal name, EIN, address, contact)." },
  { title: "Create a 10DLC Campaign", detail: "Use-case: Mixed / Customer Care. Provide sample messages (appointment reminders, status updates) and opt-in language." },
  { title: "Create a Messaging Service", detail: "Add your sending number(s) to a Messaging Service and attach it to the approved campaign." },
  { title: "Confirm in Savvy", detail: "Once Twilio marks the campaign Verified, Savvy will read the registration and clear this card automatically." },
];
```
Render these steps in both the tile (when not registered) and the Today card for `check_key === "comms.deliverability"`.

- [ ] **Step 5: Today card wiring** — in the exception-card renderer, when a card's `check_key` (or task) is `comms.deliverability` and unresolved, render the `A2P_REGISTRATION_STEPS`. Match the existing card component's API (read it first; if cards are generic and don't currently branch on `check_key`, add a minimal per-key remediation lookup keyed by `comms.deliverability` → `A2P_REGISTRATION_STEPS`).

- [ ] **Step 6: Typecheck + lint + commit**
```bash
pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint   # clean
git add "apps/web/src/lib/deliverability-queries.ts" "apps/web/src/lib/deliverability-copy.ts" "apps/web/src/app/(app)/agents/DeliverabilityTile.tsx" "apps/web/src/app/(app)/agents/page.tsx" <the-today-card-file>
git commit -m "feat(web): Agents 10DLC registration tile + Today registration-steps card (cell 6)"
```

---

### Task 8: E2e + PR — webhook→status→check path

**Files:**
- Create: `apps/web/tests/e2e/deliverability.spec.ts`

**Interfaces:** consumes the full pipeline (Tasks 1–5).

- [ ] **Step 1: E2e** — mirror an existing spec's isolated-tenant seeding (e.g. `supplier-invoice-guard.spec.ts`). Test A (webhook): seed a tenant + an outbound sms `communication` with a known `twilioSid`; POST `application/x-www-form-urlencoded` to `/api/twilio/status` with `MessageSid`, `MessageStatus=delivered`; assert the `communication.delivery_status` becomes `delivered`. Test B (unregistered ⇒ fail): seed a tenant with NO twilio connection; run the `comms.deliverability` check via its registry task in the sweep (or call the check path the other e2e uses) and assert the resulting `task_exception` for that task has `break_glass = true`. Clean teardown.

- [ ] **Step 2: Commit**
```bash
git add apps/web/tests/e2e/deliverability.spec.ts
git commit -m "test(e2e): SMS delivery webhook + unregistered break-glass (cell 6)"
```

- [ ] **Step 3: Open PR + watch + (owner) merge**
```bash
git push -u origin cell-6-deliverability
gh pr create --base main --title "feat(cell-6): A2P 10DLC + SMS deliverability monitor" --body "…cell 6 of first-20-cells…"
gh pr checks <n> --watch
```
(Post-merge: run migration 0052 on prod. Cell is DONE-in-prod after registration + 14 green days — surface via the check, not a merge claim.)

---

## Definition of Done (this PR delivers the machine; prod-green is owner+time)

- [ ] `communication.delivery_status` + `delivery_error_code` (migration 0052); receipt writer keyed on `twilio_sid`.
- [ ] `sendSms` carries `statusCallback` + `messagingServiceSid`; `/api/twilio/status` webhook updates receipts (fail-soft, signature-validated like inbound).
- [ ] A2P registration state model (`isA2pRegistered`, `getA2pRegistration`/`setA2pRegistration`) on `integration_connection.metadata.a2p`.
- [ ] `comms.deliverability` check: unregistered ⇒ fail; registered ⇒ delivery-rate + `30007` watch; registry-seeded; reconcile forces break-glass for it.
- [ ] Auto-throttle skips outbound below the floor (with a min-sample guard), fail-soft.
- [ ] Agents page 10DLC tile + Today card render the exact registration steps from one shared copy source.
- [ ] Unit + e2e green; typecheck + lint clean; full core/db/agents suites green.

## Self-Review

- **Spec coverage:** audit-via-registration-state (no live creds today) → Task 4+5 (unregistered ⇒ card) ✓; delivery-rate monitor + 30007 watch → Task 5 ✓; auto-throttle + card → Task 6 + reconcile ✓; bind `comms.deliverability` evidence → Task 5 ✓; registration state on Agents page → Task 7 ✓; break-glass card with exact steps → Task 5 (force) + Task 7 (copy) ✓. Live Twilio API audit + actual carrier registration + 14-day-green are owner/time-gated (documented).
- **Type consistency:** `A2pState` defined Task 4, consumed Tasks 5/7; `isA2pRegistered(state, connectionActive)` Task 4 → used Task 4 DB; `DELIVERY_RATE_FLOOR`/`SPAM_ERROR_CODE` Task 5 → reused Task 6; `BREAK_GLASS_ON_FAIL_CHECK_KEYS` Task 5 core → consumed Task 5 db reconcile; `applyDeliveryReceipt` Task 1 → Task 3 webhook.
- **Deferred (out of scope, documented):** live Twilio A2P sync poll (no creds), Alta's card (Cell 20), the 14-day prod-green clock, RingCentral deliverability (Twilio-first).
- **Watch items for the executor:** (a) possible `@savvy/core → @savvy/db` import cycle in Task 5 Step 5 — fallback documented; (b) `CHECK_BINDINGS`/`master-task-list.test.ts` bound-set assertion when seeding the new task; (c) local `db:migrate` 0045 drift — apply additive SQL directly.
