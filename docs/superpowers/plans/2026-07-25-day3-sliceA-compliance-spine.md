# Day 3 · Slice A — Compliance Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make it structurally impossible to send an outbound SMS in Savvy without passing one compliance gateway — global suppression, consent, quiet hours, A2P status, and cadence cap — and give every current and future agent a single global opt-out source of truth.

**Architecture:** A new global `contact_suppression` table + `isSuppressed`/`suppress` API (additive — layered on top of, not replacing, existing per-customer consent). A single `guardedSms()` gateway that every SMS send routes through; the four existing send paths (`lead-intake`, `lead-cadence`, `drip`, `appointment-reminders`) are refactored to call it, closing the `drip.ts` bypass. STOP/HELP wired in the inbound webhook.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Drizzle/Postgres + RLS, Vitest, Inngest (existing functions), Twilio `SmsSender` (mocked in tests).

## Global Constraints

- **Fail closed:** unknown consent, unapproved A2P campaign, or suppression-store error ⇒ do NOT send SMS. Return a blocked verdict; never "assume allowed."
- **Additive, not a rewrite:** the global `contact_suppression` store is a NEW cross-agent layer. Existing per-customer consent (`shouldSendChannel` in `packages/core/src/lead-followup.ts`, columns `smsOptOut`/`emailOptOut`/`smsConsentAt`) and the cadence cap (`governTouchRequest` in `packages/core/src/touch-governor.ts`) stay; the gateway enforces ALL of them, in order.
- **No bypass:** after this slice, no code path may call `SmsSender.sendSms` for a proactive/outbound message except through the gateway. A reviewer must be able to grep and confirm.
- **RLS non-negotiable:** `contact_suppression` carries `tenant_id` + `tenantIsolation()`; `isSuppressed`/`suppress` go through `withTenant`.
- **Money/PII:** suppression records store phone/email (the suppression key) — that's their purpose; no message bodies.
- **Migration:** next number is **0121** (0120 is the latest on main); generate with `pnpm db:generate`.
- **`noUncheckedIndexedAccess` ON.** Tests: `pnpm --filter @savvy/<pkg> test`; typecheck: `pnpm --filter @savvy/<pkg> typecheck`.
- **Commit trailer:** `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Merges need Brett's explicit per-PR word.
- **Verdict vocabulary (frozen for this slice + Slice B):** the gateway returns
  `{ status: "sent"; sid: string } | { status: "deferred"; untilIso: string } | { status: "blocked"; reason: "suppressed" | "no_consent" | "a2p_unapproved" | "cap_exceeded" }`.
  Quiet-hours ⇒ `deferred` (caller schedules); everything else disallowed ⇒ `blocked`.

---

## File Structure
- `packages/db/src/schema/comms-suppression.ts` (create) — `contactSuppression` table.
- `packages/db/drizzle/0121_*.sql` (generated).
- `packages/db/src/lifecycle/contact-suppression.ts` (create) — `isSuppressed`, `suppress`.
- `packages/db/src/index.ts` (modify) — export the above + the table.
- `packages/core/src/comms-gateway.ts` (create) — the pure decision core: `evaluateGuard(...)` (suppression/consent/quiet-hours/a2p/cap → verdict, no I/O) + the quiet-hours helper if not already present.
- `packages/agents/src/comms-gateway.ts` (create) — `guardedSms(...)` (wires `evaluateGuard` to real deps: `isSuppressed`, tenant consent load, A2P status, `getTenantSms`, and performs the send when allowed).
- `packages/agents/src/functions/{lead-intake,lead-cadence,drip,appointment-reminders}.ts` (modify) — route SMS through `guardedSms`.
- `apps/web/src/app/api/twilio/inbound/route.ts` (modify) — STOP → `suppress` + emit `contact.opted_out`; HELP → info reply.
- Tests colocated per package.

---

## Task 1: `contact_suppression` table + migration 0121

**Files:**
- Create: `packages/db/src/schema/comms-suppression.ts`
- Modify: `packages/db/src/schema/index.ts` (append `export * from "./comms-suppression";`)
- Create: `packages/db/drizzle/0121_*.sql` (generated)

**Interfaces:**
- Produces: `contactSuppression` Drizzle table.

- [ ] **Step 1: Write the schema** (follow `packages/db/src/schema/import-record.ts` pattern)

`packages/db/src/schema/comms-suppression.ts`:
```ts
import { pgTable, uuid, text, uniqueIndex, index } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

// Global opt-out / suppression — the single source of truth every comms agent
// reads before sending. Additive to per-customer consent (smsOptOut etc.):
// this suppresses by phone/email GLOBALLY across all agents + campaigns.
export const contactSuppression = pgTable("contact_suppression", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  locationId: uuid("location_id"),        // nullable until locations modeled
  contactId: uuid("contact_id"),          // best-effort link; the key is phone/email
  phoneE164: text("phone_e164"),
  email: text("email"),
  channel: text("channel").notNull(),     // 'sms' | 'email' | 'all'
  reason: text("reason").notNull(),       // 'stop' | 'manual' | 'bounce' | 'complaint'
  source: text("source").notNull(),       // which agent/flow recorded it
  createdAt: createdAt(),
}, (t) => [
  // Idempotent intake: one suppression per (tenant, key, channel). The key is
  // phone OR email; a partial unique index per key keeps both usable.
  uniqueIndex("contact_suppression_phone_uq").on(t.tenantId, t.phoneE164, t.channel).where(sqlPhoneNotNull()),
  uniqueIndex("contact_suppression_email_uq").on(t.tenantId, t.email, t.channel).where(sqlEmailNotNull()),
  index("contact_suppression_contact_idx").on(t.tenantId, t.contactId),
  tenantIsolation(),
]);
```
Add the partial-index predicates using drizzle `sql`:
```ts
import { sql } from "drizzle-orm";
function sqlPhoneNotNull() { return sql`phone_e164 is not null`; }
function sqlEmailNotNull() { return sql`email is not null`; }
```
(Inline the `.where(sql\`phone_e164 is not null\`)` directly if the helper reads awkwardly — the point is two partial unique indexes so a row keyed by phone and a row keyed by email don't collide on NULLs.)

- [ ] **Step 2: Register + generate** — append the barrel export; `pnpm db:generate` → `0121_*.sql`. Open it and confirm: CREATE TABLE, `ENABLE ROW LEVEL SECURITY`, `tenant_isolation` policy `TO savvy_app`, and the two partial unique indexes.

- [ ] **Step 3: Apply locally** — `pnpm db:migrate`; on shared-DB drift, apply `0121_*.sql` directly as `postgres` superuser then `GRANT SELECT, INSERT, UPDATE, DELETE ON contact_suppression TO savvy_app;`.

- [ ] **Step 4: typecheck + commit**

Run `pnpm --filter @savvy/db typecheck` (clean).
```bash
git add packages/db/src/schema packages/db/drizzle packages/db/src/schema/index.ts
git commit -m "feat(db): contact_suppression table (global opt-out, RLS), migration 0121

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: `isSuppressed` / `suppress` API

**Files:**
- Create: `packages/db/src/lifecycle/contact-suppression.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/src/lifecycle/contact-suppression.test.ts`

**Interfaces:**
- Consumes: `contactSuppression` (Task 1), `withTenant`.
- Produces (FROZEN — Appendix A.2 of the spec; every future comms agent calls exactly this):
  - `isSuppressed(a: { tenantId: string; contactId?: string; phoneE164?: string; email?: string; channel: "sms" | "email" }): Promise<boolean>`
  - `suppress(a: { tenantId: string; locationId?: string; contactId?: string; phoneE164?: string; email?: string; channel: "sms" | "email" | "all"; reason: "stop" | "manual" | "bounce" | "complaint"; source: string }): Promise<void>`

- [ ] **Step 1: Write the failing integration test** (real local pg; pattern from `packages/db/src/orchestrator/store.test.ts`)

```ts
import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { adminDb, tenant } from "../index";
import { contactSuppression } from "../schema/comms-suppression";
import { isSuppressed, suppress } from "./contact-suppression";

let tenantId: string;
beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "Sup-Test", publicKey: `sup-${tenantId.slice(0,8)}` });
});
afterAll(async () => {
  await adminDb.delete(contactSuppression).where(eq(contactSuppression.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

it("not suppressed by default; suppress() then isSuppressed() true for the phone+channel", async () => {
  expect(await isSuppressed({ tenantId, phoneE164: "+15551230000", channel: "sms" })).toBe(false);
  await suppress({ tenantId, phoneE164: "+15551230000", channel: "sms", reason: "stop", source: "test" });
  expect(await isSuppressed({ tenantId, phoneE164: "+15551230000", channel: "sms" })).toBe(true);
});

it("channel 'all' suppresses both sms and email lookups", async () => {
  await suppress({ tenantId, phoneE164: "+15551239999", email: "x@y.com", channel: "all", reason: "manual", source: "test" });
  expect(await isSuppressed({ tenantId, phoneE164: "+15551239999", channel: "sms" })).toBe(true);
  expect(await isSuppressed({ tenantId, email: "x@y.com", channel: "email" })).toBe(true);
});

it("suppress() is idempotent (second call no-throw, one effective row per key/channel)", async () => {
  await suppress({ tenantId, phoneE164: "+15551235555", channel: "sms", reason: "stop", source: "a" });
  await suppress({ tenantId, phoneE164: "+15551235555", channel: "sms", reason: "stop", source: "b" });
  expect(await isSuppressed({ tenantId, phoneE164: "+15551235555", channel: "sms" })).toBe(true);
});
```

- [ ] **Step 2: Run RED** — `pnpm --filter @savvy/db test contact-suppression` → FAIL (module missing).

- [ ] **Step 3: Implement** `packages/db/src/lifecycle/contact-suppression.ts`:
```ts
import { and, eq, or, inArray } from "drizzle-orm";
import { withTenant } from "../tenant";
import { contactSuppression } from "../schema/comms-suppression";

export async function isSuppressed(a: {
  tenantId: string; contactId?: string; phoneE164?: string; email?: string; channel: "sms" | "email";
}): Promise<boolean> {
  return withTenant(a.tenantId, async (tx) => {
    const keyMatch = [
      a.phoneE164 ? eq(contactSuppression.phoneE164, a.phoneE164) : undefined,
      a.email ? eq(contactSuppression.email, a.email) : undefined,
      a.contactId ? eq(contactSuppression.contactId, a.contactId) : undefined,
    ].filter(Boolean);
    if (keyMatch.length === 0) return false;
    const rows = await tx.select({ id: contactSuppression.id }).from(contactSuppression).where(and(
      eq(contactSuppression.tenantId, a.tenantId),
      inArray(contactSuppression.channel, [a.channel, "all"]),
      or(...(keyMatch as [typeof keyMatch[number], ...typeof keyMatch])),
    )).limit(1);
    return rows.length > 0;
  });
}

export async function suppress(a: {
  tenantId: string; locationId?: string; contactId?: string; phoneE164?: string; email?: string;
  channel: "sms" | "email" | "all"; reason: "stop" | "manual" | "bounce" | "complaint"; source: string;
}): Promise<void> {
  await withTenant(a.tenantId, async (tx) => {
    await tx.insert(contactSuppression).values({
      tenantId: a.tenantId, locationId: a.locationId ?? null, contactId: a.contactId ?? null,
      phoneE164: a.phoneE164 ?? null, email: a.email ?? null, channel: a.channel, reason: a.reason, source: a.source,
    }).onConflictDoNothing();
  });
  // NOTE: emission of `contact.opted_out` is wired in Slice B's bridge (the
  // caller in the inbound webhook emits it); suppress() stays a pure DB write
  // here so it has no orchestrator dependency. (Spec A.2 lists the emit as the
  // suppress side effect; Slice B moves it into publishDomainEvent — flagged.)
}
```

> Implementer note: `onConflictDoNothing()` relies on the two partial unique indexes from Task 1. If Drizzle can't infer the target, pass explicit `target`/`targetWhere` matching the phone/email partial index (mirror the pattern used in `packages/db/src/orchestrator/store.ts`).

- [ ] **Step 4: Run GREEN** — `pnpm --filter @savvy/db test contact-suppression` → PASS (3). Export from `packages/db/src/index.ts`:
```ts
export { isSuppressed, suppress } from "./lifecycle/contact-suppression";
export { contactSuppression } from "./schema/comms-suppression";
```
Typecheck clean.

- [ ] **Step 5: Commit**
```bash
git add packages/db/src
git commit -m "feat(db): global suppression API isSuppressed/suppress (RLS, idempotent)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: the pure gateway decision core (`evaluateGuard`)

**Files:**
- Create: `packages/core/src/comms-gateway.ts`
- Modify: `packages/core/src/index.ts` (export)
- Test: `packages/core/src/comms-gateway.test.ts`

**Interfaces:**
- Consumes: existing `shouldSendChannel` (`packages/core/src/lead-followup.ts`), quiet-hours helper (`packages/core/src/quiet-hours.ts` — check exact export; use it), `governTouchRequest` (`packages/core/src/touch-governor.ts`).
- Produces:
  - `type GuardVerdict = { status: "allow" } | { status: "deferred"; untilIso: string } | { status: "blocked"; reason: "suppressed" | "no_consent" | "a2p_unapproved" | "cap_exceeded" }`
  - `function evaluateGuard(input: GuardInput): GuardVerdict` — PURE, no I/O. Order: suppressed → no_consent → a2p_unapproved → quiet-hours(deferred) → cap_exceeded → allow.
  - `interface GuardInput { channel: "sms" | "email"; suppressed: boolean; consent: { smsOptOut: boolean; emailOptOut: boolean; smsConsentAt: Date | null }; a2pApproved: boolean; quiet: { tz: string; now: Date } | null; cap: { verdict: "admit" | "cap_exceeded" | "opt_out" } }`

- [ ] **Step 1: Write the failing test**

```ts
import { it, expect } from "vitest";
import { evaluateGuard } from "./comms-gateway";

const consentOk = { smsOptOut: false, emailOptOut: false, smsConsentAt: new Date("2026-01-01") };
const base = { channel: "sms" as const, suppressed: false, consent: consentOk, a2pApproved: true, quiet: null, cap: { verdict: "admit" as const } };

it("allows when everything passes", () => { expect(evaluateGuard(base).status).toBe("allow"); });
it("blocks suppressed first, before anything else", () => {
  expect(evaluateGuard({ ...base, suppressed: true, a2pApproved: false })).toEqual({ status: "blocked", reason: "suppressed" });
});
it("blocks no_consent when sms has no smsConsentAt", () => {
  expect(evaluateGuard({ ...base, consent: { ...consentOk, smsConsentAt: null } })).toEqual({ status: "blocked", reason: "no_consent" });
});
it("fails closed on unapproved A2P (sms)", () => {
  expect(evaluateGuard({ ...base, a2pApproved: false })).toEqual({ status: "blocked", reason: "a2p_unapproved" });
});
it("defers inside quiet hours (before cap)", () => {
  // 6am America/Denver = before 8am window
  const now = new Date("2026-07-01T12:00:00Z"); // 06:00 MDT
  const v = evaluateGuard({ ...base, quiet: { tz: "America/Denver", now } });
  expect(v.status).toBe("deferred");
});
it("blocks cap_exceeded when governor refuses", () => {
  expect(evaluateGuard({ ...base, cap: { verdict: "cap_exceeded" } })).toEqual({ status: "blocked", reason: "cap_exceeded" });
});
it("email path ignores A2P + sms consent, honors suppression + email opt-out", () => {
  expect(evaluateGuard({ ...base, channel: "email", a2pApproved: false, consent: { ...consentOk, smsConsentAt: null } }).status).toBe("allow");
  expect(evaluateGuard({ ...base, channel: "email", consent: { ...consentOk, emailOptOut: true } })).toEqual({ status: "blocked", reason: "no_consent" });
});
```

- [ ] **Step 2: Run RED** — `pnpm --filter @savvy/core test comms-gateway` → FAIL.

- [ ] **Step 3: Implement `comms-gateway.ts`** (use the real `shouldSendChannel` + a quiet-hours check). Confirm the quiet-hours helper's exact name in `packages/core/src/quiet-hours.ts` and use it; if it exposes `nextAllowedSendTime(tz, now)`/`isWithinQuietHours(tz, now)`, use those. Enforcement order per the Global Constraints. A2P only gates `sms`. `deferred.untilIso` = next allowed send instant.

```ts
import { shouldSendChannel } from "./lead-followup";
// import the real quiet-hours helpers — VERIFY names in quiet-hours.ts:
import { isWithinQuietHours, nextAllowedSendTime } from "./quiet-hours";

export type GuardVerdict =
  | { status: "allow" }
  | { status: "deferred"; untilIso: string }
  | { status: "blocked"; reason: "suppressed" | "no_consent" | "a2p_unapproved" | "cap_exceeded" };

export interface GuardInput {
  channel: "sms" | "email";
  suppressed: boolean;
  consent: { smsOptOut: boolean; emailOptOut: boolean; smsConsentAt: Date | null };
  a2pApproved: boolean;
  quiet: { tz: string; now: Date } | null;
  cap: { verdict: "admit" | "cap_exceeded" | "opt_out" };
}

export function evaluateGuard(i: GuardInput): GuardVerdict {
  if (i.suppressed) return { status: "blocked", reason: "suppressed" };
  if (!shouldSendChannel(i.channel, i.consent)) return { status: "blocked", reason: "no_consent" };
  if (i.channel === "sms" && !i.a2pApproved) return { status: "blocked", reason: "a2p_unapproved" };
  if (i.quiet && isWithinQuietHours(i.quiet.tz, i.quiet.now)) {
    return { status: "deferred", untilIso: nextAllowedSendTime(i.quiet.tz, i.quiet.now).toISOString() };
  }
  if (i.cap.verdict !== "admit") return { status: "blocked", reason: "cap_exceeded" };
  return { status: "allow" };
}
```
> If `quiet-hours.ts` doesn't export those exact helpers, adapt to what it does export (it is used by `lead-cadence.ts` via `nextAllowedSendTime` per the audit) — keep the ORDER and the verdict shape; only the helper calls change.

- [ ] **Step 4: Run GREEN + typecheck** — PASS (7). Export from `packages/core/src/index.ts`. Commit.
```bash
git add packages/core/src
git commit -m "feat(core): evaluateGuard — pure compliance decision (suppress/consent/a2p/quiet/cap)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: `guardedSms()` — the wired chokepoint

**Files:**
- Create: `packages/agents/src/comms-gateway.ts`
- Test: `packages/agents/src/comms-gateway.test.ts`

**Interfaces:**
- Consumes: `evaluateGuard`/`GuardVerdict` (Task 3), `isSuppressed` (Task 2), `SmsSender` (from `getTenantSms`), the tenant's A2P-approved flag (load from tenant settings — check `resolveTelephonyCreds`/tenant.settings for an A2P/campaign status field; if none exists yet, treat `a2pApproved = false` in production mode and `true` only when a MOCK sender is in use, so tests pass and prod fails-closed until A2P is wired).
- Produces:
  - `type GuardedSmsResult = { status: "sent"; sid: string } | { status: "deferred"; untilIso: string } | { status: "blocked"; reason: GuardVerdict extends { reason: infer R } ? R : never }`
  - `async function guardedSms(deps, args): Promise<GuardedSmsResult>` where `args = { tenantId; channel: "sms"; to: string; from?: string; body: string; consent; a2pApproved: boolean; quietTz?: string; now?: Date; capVerdict?: "admit"|"cap_exceeded"|"opt_out"; contactId?: string }` and `deps = { isSuppressed; sms: SmsSender; smsFrom: () => string }`. It calls `isSuppressed`, builds a `GuardInput`, runs `evaluateGuard`, and ONLY on `allow` calls `deps.sms.sendSms(...)`.

- [ ] **Step 1: Write the failing test** (mock deps — no real Twilio, no DB)

```ts
import { it, expect, vi } from "vitest";
import { guardedSms } from "./comms-gateway";

const okConsent = { smsOptOut: false, emailOptOut: false, smsConsentAt: new Date("2026-01-01") };
function deps(over: Partial<{ suppressed: boolean; sendSpy: ReturnType<typeof vi.fn> }> = {}) {
  const sendSms = over.sendSpy ?? vi.fn(async () => ({ sid: "SM1" }));
  return { isSuppressed: vi.fn(async () => over.suppressed ?? false), sms: { sendSms }, smsFrom: () => "+15550000000" };
}
const args = { tenantId: "t1", channel: "sms" as const, to: "+15551231234", body: "hi", consent: okConsent, a2pApproved: true };

it("sends when allowed and returns the sid", async () => {
  const d = deps();
  const r = await guardedSms(d, args);
  expect(r).toEqual({ status: "sent", sid: "SM1" });
  expect(d.sms.sendSms).toHaveBeenCalledOnce();
});
it("does NOT call the sender when suppressed", async () => {
  const spy = vi.fn(async () => ({ sid: "X" }));
  const r = await guardedSms(deps({ suppressed: true, sendSpy: spy }), args);
  expect(r).toEqual({ status: "blocked", reason: "suppressed" });
  expect(spy).not.toHaveBeenCalled();
});
it("fails closed (no send) when a2p not approved", async () => {
  const spy = vi.fn(async () => ({ sid: "X" }));
  const r = await guardedSms(deps({ sendSpy: spy }), { ...args, a2pApproved: false });
  expect(r).toEqual({ status: "blocked", reason: "a2p_unapproved" });
  expect(spy).not.toHaveBeenCalled();
});
it("defers (no send) inside quiet hours", async () => {
  const spy = vi.fn(async () => ({ sid: "X" }));
  const r = await guardedSms(deps({ sendSpy: spy }), { ...args, quietTz: "America/Denver", now: new Date("2026-07-01T12:00:00Z") });
  expect(r.status).toBe("deferred");
  expect(spy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run RED** — `pnpm --filter @savvy/agents test comms-gateway` → FAIL.

- [ ] **Step 3: Implement `guardedSms`** — thin wiring around `evaluateGuard`:
```ts
import { evaluateGuard, type GuardVerdict } from "@savvy/core";
import type { SmsSender } from "@savvy/integrations";

export type GuardedSmsResult =
  | { status: "sent"; sid: string }
  | { status: "deferred"; untilIso: string }
  | { status: "blocked"; reason: "suppressed" | "no_consent" | "a2p_unapproved" | "cap_exceeded" };

export interface GuardedSmsDeps {
  isSuppressed: (a: { tenantId: string; contactId?: string; phoneE164?: string; channel: "sms" }) => Promise<boolean>;
  sms: SmsSender;
  smsFrom: () => string;
}

export async function guardedSms(deps: GuardedSmsDeps, a: {
  tenantId: string; channel: "sms"; to: string; from?: string; body: string;
  consent: { smsOptOut: boolean; emailOptOut: boolean; smsConsentAt: Date | null };
  a2pApproved: boolean; quietTz?: string; now?: Date;
  capVerdict?: "admit" | "cap_exceeded" | "opt_out"; contactId?: string;
}): Promise<GuardedSmsResult> {
  const suppressed = await deps.isSuppressed({ tenantId: a.tenantId, contactId: a.contactId, phoneE164: a.to, channel: "sms" });
  const verdict: GuardVerdict = evaluateGuard({
    channel: "sms", suppressed, consent: a.consent, a2pApproved: a.a2pApproved,
    quiet: a.quietTz ? { tz: a.quietTz, now: a.now ?? new Date() } : null,
    cap: { verdict: a.capVerdict ?? "admit" },
  });
  if (verdict.status === "deferred") return verdict;
  if (verdict.status === "blocked") return verdict;
  const res = await deps.sms.sendSms({ to: a.to, from: a.from ?? deps.smsFrom(), body: a.body });
  return { status: "sent", sid: res.sid };
}
```
> `now`/`new Date()` — this runs in an Inngest `step.run`, so a live clock is acceptable here (it's the actual send time), unlike the pure Day-1/Day-2 logic. Tests inject `now`.

- [ ] **Step 4: Run GREEN + typecheck** — PASS (4). Commit.
```bash
git add packages/agents/src/comms-gateway.ts packages/agents/src/comms-gateway.test.ts
git commit -m "feat(agents): guardedSms — the single compliant SMS chokepoint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: route the four senders through `guardedSms` (close the bypass)

**Files:**
- Modify: `packages/agents/src/functions/lead-intake.ts`, `lead-cadence.ts`, `drip.ts`, `appointment-reminders.ts`
- Test: extend each function's existing `*.test.ts` (or add a focused test) asserting a suppressed contact is NOT sent.

**Interfaces:**
- Consumes: `guardedSms` (Task 4), `isSuppressed` (Task 2).

- [ ] **Step 1: Inventory the current SMS send sites** — for each of the four files, find every place that calls `sms.sendSms(...)` / the tenant SMS sender directly, and the consent/quiet-hours/cadence data already in scope there.
```bash
grep -n "sendSms\|getTenantSms\|shouldSendChannel\|nextAllowedSendTime\|governTouchRequest" packages/agents/src/functions/{lead-intake,lead-cadence,drip,appointment-reminders}.ts
```
`drip.ts` is the one that currently BYPASSES `shouldSendChannel` — it is the priority.

- [ ] **Step 2: Write the failing regression test** — for `drip.ts` (the bypass), add a test that a drip step to a suppressed contact does not call the sender. Use the file's existing test harness/mocks; assert the send spy isn't called once `isSuppressed` returns true. Run it → RED (drip currently sends regardless).

- [ ] **Step 3: Refactor each send site** to call `guardedSms(deps, {...})` instead of the raw sender, passing the consent record already loaded, the lead's quiet-hours tz, the A2P-approved flag, and the cadence verdict where the function already computes one. On `blocked`/`deferred`, do NOT send: for `deferred` schedule via the function's existing `step.sleepUntil` pattern (cadence/reminders already do this) and re-attempt; for `blocked` record the reason (a later Slice B task turns `blocked` into a `compliance-block` escalation — for now, log via the existing `recordAgentRun`/communication log). Keep each function's existing tests green.

- [ ] **Step 4: Prove no bypass remains** — grep must show every outbound proactive `sendSms` in these four files now goes through `guardedSms`:
```bash
grep -n "sendSms" packages/agents/src/functions/{lead-intake,lead-cadence,drip,appointment-reminders}.ts
```
Only `guardedSms`'s own internal call (in `comms-gateway.ts`) should call `sms.sendSms`.

- [ ] **Step 5: Run all four functions' tests + typecheck** — `pnpm --filter @savvy/agents test` green; `pnpm --filter @savvy/agents typecheck` clean.

- [ ] **Step 6: Commit**
```bash
git add packages/agents/src/functions
git commit -m "refactor(agents): route lead-intake/cadence/drip/reminders SMS through guardedSms (close drip.ts bypass)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: STOP / HELP in the inbound webhook

**Files:**
- Modify: `apps/web/src/app/api/twilio/inbound/route.ts`
- Test: add/extend the route's test (or a focused unit test of the STOP/HELP branch).

**Interfaces:**
- Consumes: `isStopKeyword` (`packages/core/src/comms.ts`), `suppress` (Task 2).

- [ ] **Step 1: Read the current inbound route** — see how it parses `From`/`Body` and replies (TwiML). Identify where to branch on `isStopKeyword(body)` and a new HELP check.

- [ ] **Step 2: Write the failing test** — an inbound `STOP` from `+1555…` calls `suppress({ ..., phoneE164, channel: "sms", reason: "stop", source: "twilio-inbound" })` and replies with a confirmation; an inbound `HELP` replies with an info message and does NOT suppress. (Mock `suppress`.)

- [ ] **Step 3: Implement the branch** — on `isStopKeyword(body)` → resolve tenant from the `To` number (reuse the route's existing tenant resolution), `await suppress(...)`, reply "You're unsubscribed. Reply START to opt back in."; add a `HELP`/`INFO` keyword → reply with company + "Reply STOP to opt out" and no suppression. STOP takes precedence.

- [ ] **Step 4: Run GREEN + `pnpm --filter @savvy/web typecheck`** clean.

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/app/api/twilio/inbound/route.ts
git commit -m "feat(web): inbound STOP → global suppress + HELP info reply

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: Slice A gate

- [ ] **Step 1: Full gate**
```bash
pnpm typecheck
pnpm lint
pnpm --filter @savvy/core test
pnpm --filter @savvy/agents test
pnpm --filter @savvy/db test contact-suppression
```
Expected: all green. (A pre-existing unrelated `rederive-job-stages` timeout on the shared local DB is NOT this branch's regression — note it; CI on a fresh DB is authoritative.)

- [ ] **Step 2: Push + PR (stop for Brett's word)**
```bash
git push -u origin day3-speed-to-lead
gh pr create --title "Day 3 · Slice A — compliance spine (global suppression + one SMS gateway)" --body "Closes the live drip.ts consent bypass. New global contact_suppression store (mig 0121) + isSuppressed/suppress API; one guardedSms gateway (suppress→consent→a2p→quiet→cap, fail-closed) that lead-intake/cadence/drip/reminders now all route through; inbound STOP→global suppress + HELP. Mock-Twilio tested. Slices B (bridge + escalations), C (missed-call/no-show/bilingual), D (acceptance) follow.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
Report the PR link + CI status. Do NOT merge.

---

## Self-Review (author)
- **Spec coverage (Slice A portion):** global suppression store + API (Task 1–2) ✓ · single gateway with fail-closed order suppress→consent→a2p→quiet→cap (Task 3–4) ✓ · close drip.ts bypass by routing all four senders (Task 5) ✓ · STOP→global suppress + HELP (Task 6) ✓. Deferred to later slices (correctly, per spec): `contact.opted_out` emission + `compliance-block` escalation (Slice B bridge), missed-call/no-show/bilingual (Slice C), the 11-check acceptance test (Slice D).
- **Type consistency:** `GuardVerdict`/`GuardedSmsResult` reason union identical across Tasks 3–4; `isSuppressed`/`suppress` signatures identical in Tasks 2, 4, 6.
- **Known implementer verifications flagged inline:** exact quiet-hours helper names in `quiet-hours.ts` (Task 3); the A2P-approved source on the tenant (Task 4 — fail-closed default until wired); Drizzle partial-index onConflict target (Task 2).
- **Fail-closed** is enforced in `evaluateGuard` order + the `guardedSms` "only send on allow" structure.
