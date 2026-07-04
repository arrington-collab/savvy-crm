# Cell 7 — Comms Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the seeded `comms.body_quality` invariant green (stop shipping raw ~139-char JWT status links in comms bodies) and structurally harden `comms.no_double_send` (claim-then-send idempotency on the homeowner-stage notifier), so both run green in production.

**Architecture:** Generalize the existing `/b/` short-link shortener to a second destination `kind` (`status`) so the three homeowner notifiers embed a short `/b/{code}` link instead of a raw `/status/{jwt}`. Add a `dedupe_key` idempotency column to `communication` and a `claimCommunication` helper; restructure the homeowner-stage notifier (the one with the send-then-mark ledger race) to claim-then-send. Crew/delivery notifiers are already idempotent via Inngest durable `step.run`, so they only get the short-link change.

**Tech Stack:** Drizzle + Postgres (RLS), drizzle-kit migrations, Next.js 16 route handlers, Inngest, Vitest, pnpm monorepo.

## Global Constraints

- **Tenant isolation (non-negotiable):** every DB access via `withTenant`/`adminDb` scoped by `tenant_id`; the dedupe index is `(tenant_id, dedupe_key)`.
- **Done bar:** the two invariants already exist and are wired into the health sweep (`packages/core/src/verification/checks.ts:25` `comms.no_double_send`, `:42` `comms.body_quality`; `packages/agents/src/health-sweep.ts`). Do NOT add a new invariant. `body_quality` flags `body ~ 'https?://[^[:space:]]{33,}'` — a `/b/{8-char-code}` link must keep the whole URL under 33 chars.
- **Backward compatible:** `booking_link.kind` defaults `'booking'`; the dedupe index is partial (`WHERE dedupe_key IS NOT NULL`) so existing keyless `communication` inserts are unaffected.
- **Migrations:** generate with `pnpm --filter @savvy/db db:generate` (NEVER hand-number — avoids journal collisions); apply locally with `pnpm --filter @savvy/db db:migrate`. Next migration is **0046**. In production, run the migration manually from this worktree after merge, then verify the columns exist.
- **Fail-soft sends unchanged:** the actual send stays wrapped in try/catch; the `communication` row records intent-to-send regardless (as today).
- **Test command:** db → `cd packages/db && pnpm exec vitest run <file>`; agents → `cd packages/agents && pnpm exec vitest run <file>`. Local Postgres test DB (`postgres://postgres:postgres@localhost:5432/savvy`) is running; db/agents tests run serially.
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: DB — short-link `kind` + `communication` dedupe (migration 0046)

**Files:**
- Modify: `packages/db/src/schema/booking-link.ts` (add `kind`)
- Modify: `packages/db/src/schema/comms.ts` (add `dedupe_key` + partial unique index to `communication`)
- Modify: `packages/db/src/lifecycle/booking-link.ts` (`createStatusLink`; `resolveBookingLink` → `{token,kind}`)
- Create: `packages/db/src/lifecycle/claim-communication.ts` (`claimCommunication`)
- Modify: `packages/db/src/index.ts` (barrel: add `createStatusLink`, `claimCommunication`)
- Create: `packages/db/drizzle/0046_*.sql` (generated, do not hand-write)
- Test: `packages/db/src/lifecycle/comms-hygiene.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  // booking-link.ts
  createStatusLink(args: { tenantId: string; token: string; expiresAt?: Date | null }): Promise<string> // returns short code
  resolveBookingLink(code: string): Promise<{ token: string; kind: string } | null>   // CHANGED shape (was string|null)
  // claim-communication.ts
  claimCommunication(input: {
    tenantId: string; jobId: string | null; customerId: string | null;
    channel: "sms" | "email"; direction: "outbound"; to: string; body: string; dedupeKey: string;
  }): Promise<{ id: string } | null>   // null on dedupe conflict
  ```
- Note: `resolveBookingLink`'s new shape breaks `apps/web/src/app/b/[code]/route.ts` until Task 2 — that is expected within this one branch/PR; Task 1 verification only runs `@savvy/db` typecheck.

- [ ] **Step 1: Add the schema changes**

In `packages/db/src/schema/booking-link.ts`, add the `kind` column to `bookingLink`:
```ts
export const bookingLink = pgTable("booking_link", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  code: text("code").notNull().unique(),
  token: text("token").notNull(),
  kind: text("kind").notNull().default("booking"), // 'booking' | 'status'
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("booking_link_code_idx").on(t.code),
  tenantIsolation(),
]);
```

In `packages/db/src/schema/comms.ts`, add `dedupeKey` + a partial unique index to `communication`. The `communication` table currently ends `createdAt: createdAt(), }, (t) => [index("comm_tenant_job_idx").on(t.tenantId, t.jobId), tenantIsolation()]);`. Change to:
```ts
  dedupeKey: text("dedupe_key"),
  createdAt: createdAt(),
}, (t) => [
  index("comm_tenant_job_idx").on(t.tenantId, t.jobId),
  uniqueIndex("communication_dedupe_uniq").on(t.tenantId, t.dedupeKey).where(sql`dedupe_key is not null`),
  tenantIsolation(),
]);
```
(`sql` and `uniqueIndex` are already imported at the top of `comms.ts`.)

- [ ] **Step 2: Generate + apply the migration**

Run: `pnpm --filter @savvy/db db:generate` — creates `packages/db/drizzle/0046_*.sql`. Inspect it: it must `ALTER TABLE "booking_link" ADD COLUMN "kind" ... DEFAULT 'booking'` and `ALTER TABLE "communication" ADD COLUMN "dedupe_key" text` + `CREATE UNIQUE INDEX "communication_dedupe_uniq" ... WHERE dedupe_key is not null`. If drizzle-kit prompts, accept the column adds.
Run: `pnpm --filter @savvy/db db:migrate` — applies it (and RLS grants) to the local Postgres. No new `rls-grants.sql` entry is needed (both tables already exist; new columns inherit table grants).

- [ ] **Step 3: Write the failing tests**

Create `packages/db/src/lifecycle/comms-hygiene.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { adminDb, tenant, customer, job, property, communication, withTenant, eq, and } from "../index";
import { createBookingLink, createStatusLink, resolveBookingLink, claimCommunication } from "../index";

async function seedTenant() {
  const [t] = await adminDb.insert(tenant).values({ name: "C7", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` }).returning();
  return t!.id;
}
async function seedJob(tenantId: string) {
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "C" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 A St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  return { customerId: c!.id, jobId: j!.id };
}

describe("short-link kinds", () => {
  it("createStatusLink resolves to a status kind; createBookingLink stays booking", async () => {
    const tenantId = await seedTenant();
    const sCode = await createStatusLink({ tenantId, token: "status-jwt-123" });
    const bCode = await createBookingLink({ tenantId, token: "book-tok-456" });
    expect(await resolveBookingLink(sCode)).toEqual({ token: "status-jwt-123", kind: "status" });
    expect(await resolveBookingLink(bCode)).toEqual({ token: "book-tok-456", kind: "booking" });
    expect(await resolveBookingLink("nope")).toBeNull();
  });
});

describe("claimCommunication", () => {
  it("first claim inserts, second identical claim returns null (idempotent)", async () => {
    const tenantId = await seedTenant();
    const { customerId, jobId } = await seedJob(tenantId);
    const base = { tenantId, jobId, customerId, channel: "sms" as const, direction: "outbound" as const, to: "+15551230000", body: "hi", dedupeKey: "stage:sms:+15551230000:evt-1" };
    const first = await claimCommunication(base);
    expect(first).not.toBeNull();
    const second = await claimCommunication(base);
    expect(second).toBeNull();
    const rows = await withTenant(tenantId, (tx) => tx.select().from(communication).where(and(eq(communication.tenantId, tenantId), eq(communication.dedupeKey, base.dedupeKey))));
    expect(rows).toHaveLength(1);
  });
  it("different dedupeKey → both succeed", async () => {
    const tenantId = await seedTenant();
    const { customerId, jobId } = await seedJob(tenantId);
    const a = await claimCommunication({ tenantId, jobId, customerId, channel: "email", direction: "outbound", to: "a@x.com", body: "b", dedupeKey: "stage:email:a@x.com:evt-9" });
    const b = await claimCommunication({ tenantId, jobId, customerId, channel: "email", direction: "outbound", to: "a@x.com", body: "b", dedupeKey: "stage:email:a@x.com:evt-10" });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd packages/db && pnpm exec vitest run src/lifecycle/comms-hygiene.test.ts`
Expected: FAIL — `createStatusLink` / `claimCommunication` not exported (and `resolveBookingLink` returns a string, not the object).

- [ ] **Step 5: Implement the helpers**

In `packages/db/src/lifecycle/booking-link.ts`: change `resolveBookingLink` to select+return `{ token, kind }`, and add `createStatusLink` (mirrors `createBookingLink` but inserts `kind: "status"`). Replace the `resolveBookingLink` body and add the new function:
```ts
export async function createStatusLink(args: {
  tenantId: string; token: string; expiresAt?: Date | null;
}): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomShortCode();
    try {
      await adminDb.insert(bookingLink).values({ tenantId: args.tenantId, code, token: args.token, kind: "status", expiresAt: args.expiresAt ?? null });
      return code;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("23505")) continue;
      throw err;
    }
  }
  throw new Error("Failed to generate unique status link code after 5 attempts");
}

export async function resolveBookingLink(code: string): Promise<{ token: string; kind: string } | null> {
  const now = new Date();
  const [row] = await adminDb
    .select({ token: bookingLink.token, kind: bookingLink.kind })
    .from(bookingLink)
    .where(and(eq(bookingLink.code, code), or(isNull(bookingLink.expiresAt), gte(bookingLink.expiresAt, now))));
  return row ? { token: row.token, kind: row.kind } : null;
}
```
(`createBookingLink` stays as-is; it does not set `kind`, so it defaults to `'booking'`.)

Create `packages/db/src/lifecycle/claim-communication.ts`:
```ts
import { adminDb } from "../admin-client";
import { withTenant } from "../tenant";
import { communication } from "../schema/index";

/**
 * Idempotent "claim then send": inserts a communication row keyed by dedupeKey.
 * Returns the row on success, or null if a row with the same (tenant_id, dedupe_key)
 * already exists (partial unique index). Callers skip the actual send when null.
 */
export async function claimCommunication(input: {
  tenantId: string; jobId: string | null; customerId: string | null;
  channel: "sms" | "email"; direction: "outbound"; to: string; body: string; dedupeKey: string;
}): Promise<{ id: string } | null> {
  return withTenant(input.tenantId, async (tx) => {
    const rows = await tx
      .insert(communication)
      .values({
        tenantId: input.tenantId, jobId: input.jobId, customerId: input.customerId,
        channel: input.channel, direction: input.direction, to: input.to, body: input.body,
        dedupeKey: input.dedupeKey, aiHandled: false,
      })
      .onConflictDoNothing({ target: [communication.tenantId, communication.dedupeKey] })
      .returning({ id: communication.id });
    return rows[0] ?? null;
  });
}
```

- [ ] **Step 6: Barrel exports**

In `packages/db/src/index.ts`: extend the booking-link export line (line ~60) to add `createStatusLink`, and add a new export for `claimCommunication`:
```ts
export { createBookingLink, createStatusLink, resolveBookingLink } from "./lifecycle/booking-link";
export { claimCommunication } from "./lifecycle/claim-communication";
```

- [ ] **Step 7: Run tests + typecheck**

Run: `cd packages/db && pnpm exec vitest run src/lifecycle/comms-hygiene.test.ts` → PASS (3 tests).
Run: `pnpm --filter @savvy/db typecheck` → clean. (apps/web typecheck will be red until Task 2 — that's expected; do not fix it here.)

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema/booking-link.ts packages/db/src/schema/comms.ts packages/db/src/lifecycle/booking-link.ts packages/db/src/lifecycle/claim-communication.ts packages/db/src/index.ts packages/db/src/lifecycle/comms-hygiene.test.ts packages/db/drizzle/
git commit -m "feat(db): short-link kind + communication dedupe key (migration 0046)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: apps/web — `/b/{code}` redirects by kind

**Files:**
- Modify: `apps/web/src/app/b/[code]/route.ts`

**Interfaces:**
- Consumes: `resolveBookingLink(code): Promise<{ token: string; kind: string } | null>` (Task 1).

- [ ] **Step 1: Update the route to branch on kind**

Replace the body of `apps/web/src/app/b/[code]/route.ts`'s `GET` with:
```ts
export async function GET(
  req: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  const link = await resolveBookingLink(code);
  if (!link) {
    return new NextResponse("not found", { status: 404 });
  }
  const path = link.kind === "status" ? `/status/${link.token}` : `/book/${link.token}`;
  return NextResponse.redirect(new URL(path, req.url), 307);
}
```
(Imports at the top stay: `NextResponse` from `next/server`, `resolveBookingLink` from `@savvy/db`.)

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @savvy/web typecheck` → clean (this resolves the Task-1 shape change).
Run: `pnpm --filter @savvy/web lint` → 0 errors.

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/b/[code]/route.ts"
git commit -m "feat(web): /b short-link redirects to /status for status-kind links

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: agents — short-link the 3 notifiers + claim-then-send on homeowner-stage

**Files:**
- Modify: `packages/agents/src/functions/homeowner-notify.ts` (short-link + claim-then-send)
- Modify: `packages/agents/src/functions/homeowner-crew-notify.ts` (short-link only)
- Modify: `packages/agents/src/functions/homeowner-delivery-notify.ts` (short-link only)
- Test: `packages/agents/src/functions/homeowner-notify.test.ts` (create or extend)

**Interfaces:**
- Consumes: `createStatusLink`, `claimCommunication` (Task 1).
- Rationale for asymmetry: `homeowner-notify` runs on a `*/15` cron with a send-then-mark ledger (the real duplicate-send race) → gets claim-then-send. `homeowner-crew-notify` and `homeowner-delivery-notify` are per-entity Inngest functions whose sends live in durable `step.run(...)` (idempotent on replay) → they only need the short-link fix, not the dedupe restructure.

- [ ] **Step 1: Short-link all three notifiers**

In EACH of the three files, replace the raw link construction. The current line (all three) is:
```ts
const link = `${base}/status/${signPayloadToken({ tenantId, jobId: <X> }, secret)}`;
```
(where `<X>` is `ev.jobId` in homeowner-notify, `ctx.jobId` in crew/delivery). Replace with:
```ts
const statusToken = signPayloadToken({ tenantId, jobId: <X> }, secret);
const code = await createStatusLink({ tenantId, token: statusToken });
const link = `${base}/b/${code}`;
```
Add `createStatusLink` to the `@savvy/db` import in each file. In `homeowner-notify.ts` the link is built per-event inside the loop (fine — `await` is allowed there). In crew/delivery the link is built once before the `step.run` send — keep it there (it's inside the Inngest handler, `await` is fine).

- [ ] **Step 2: Claim-then-send in homeowner-notify.ts**

In `packages/agents/src/functions/homeowner-notify.ts`, replace the send-then-insert blocks inside the `for (const ev of events)` loop. The current SMS block is:
```ts
if (ev.phone && !ev.smsOptOut && !smsQuiet) {
  try { if (smsSender) { const { sender, from } = smsSender; await sender.sendSms({ to: ev.phone, from, body }); } } catch { /* fail-soft */ }
  await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId: ev.jobId, customerId: ev.customerId, channel: "sms", direction: "outbound", to: ev.phone, body, aiHandled: false }));
}
```
Replace with claim-then-send:
```ts
if (ev.phone && !ev.smsOptOut && !smsQuiet) {
  const claimed = await claimCommunication({ tenantId, jobId: ev.jobId, customerId: ev.customerId, channel: "sms", direction: "outbound", to: ev.phone, body, dedupeKey: `stage:sms:${ev.phone}:${ev.eventId}` });
  if (claimed && smsSender) {
    try { const { sender, from } = smsSender; await sender.sendSms({ to: ev.phone, from, body }); } catch { /* fail-soft */ }
  }
}
```
And the email block, currently:
```ts
if (ev.email && !ev.emailOptOut) {
  try { await getEmailSender({ gmailConnectionId }).sendEmail({ ... }); } catch { /* fail-soft */ }
  await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId: ev.jobId, customerId: ev.customerId, channel: "email", direction: "outbound", to: ev.email, body, aiHandled: false }));
}
```
Replace with:
```ts
if (ev.email && !ev.emailOptOut) {
  const claimed = await claimCommunication({ tenantId, jobId: ev.jobId, customerId: ev.customerId, channel: "email", direction: "outbound", to: ev.email, body, dedupeKey: `stage:email:${ev.email}:${ev.eventId}` });
  if (claimed) {
    try { await getEmailSender({ gmailConnectionId }).sendEmail({ to: ev.email, from: process.env.EMAIL_FROM ?? "noreply@example.com", subject: copy.headline, html: `<p>${copy.body}</p><p><a href="${link}">Track your project</a></p>` }); } catch { /* fail-soft */ }
  }
}
```
Add `claimCommunication` to the `@savvy/db` import. Leave the `markStageEventNotified(tenantId, ev.eventId)` call after the branches as-is (belt-and-suspenders; correctness now comes from the dedupe claim). Remove the now-unused `communication` import ONLY if nothing else in the file uses it (check — the direct `insert(communication)` calls are gone; drop the import if unreferenced to avoid a lint warning).

- [ ] **Step 3: Write the tests**

Create/extend `packages/agents/src/functions/homeowner-notify.test.ts`. Seed a tenant with `homeowner.enabled` + a job + a stage event to notify (mirror the existing homeowner-notify seed pattern; look at how `listStageEventsToNotify` expects data — a `job_stage_event` row with `homeownerNotifiedAt IS NULL` for a notify stage, and a customer with a phone). Then:

- **body_quality:** run `evaluateTenantHomeownerNotifs(tenantId, now)` once; select the resulting outbound `communication` rows; assert every `body` contains `/b/` AND that none matches the invariant's offending pattern. Assert directly with the invariant's own regex so the test tracks the check:
  ```ts
  const rows = await withTenant(tenantId, (tx) => tx.select({ body: communication.body }).from(communication).where(eq(communication.tenantId, tenantId)));
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.body).toContain("/b/");
    expect(r.body).not.toMatch(/https?:\/\/[^\s]{33,}/);   // same rule as comms.body_quality
  }
  ```
- **dedupe / no double send:** call `evaluateTenantHomeownerNotifs(tenantId, now)` TWICE (simulate the mark-failed / cron-overlap re-run — do not stamp the ledger between calls, or seed two identical unstamped events). Assert only ONE outbound `communication` row exists per (channel, recipient) for that event — i.e. the dedupe key prevented a second row:
  ```ts
  const smsRows = await withTenant(tenantId, (tx) => tx.select().from(communication).where(and(eq(communication.tenantId, tenantId), eq(communication.channel, "sms"))));
  expect(smsRows).toHaveLength(1);
  ```
  (If the test's first call stamps `homeownerNotifiedAt` so the second call sees no events, force the race instead by seeding the stage event and calling `claimCommunication`'s path twice via two `evaluateTenantHomeownerNotifs` runs BEFORE any mark — or assert at the `claimCommunication` level. The invariant is: two runs over the same unstamped event produce one row.)

Run: `cd packages/agents && pnpm exec vitest run src/functions/homeowner-notify.test.ts` → PASS.

- [ ] **Step 4: Typecheck + full agents suite**

Run: `pnpm --filter @savvy/agents typecheck` → clean.
Run: `cd packages/agents && pnpm exec vitest run src/functions/homeowner-notify.test.ts src/functions/homeowner-crew-notify.test.ts src/functions/homeowner-delivery-notify.test.ts` (whichever exist) → PASS. Confirm no regression in the crew/delivery notifiers from the short-link change.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/functions/homeowner-notify.ts packages/agents/src/functions/homeowner-crew-notify.ts packages/agents/src/functions/homeowner-delivery-notify.ts packages/agents/src/functions/homeowner-notify.test.ts
git commit -m "feat(agents): short-link status URLs in comms bodies + claim-then-send dedupe

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Unit 1 (generalize shortener: `booking_link.kind`, `/b` branch, `createStatusLink`) → Task 1 (schema/helper) + Task 2 (route). ✓
- Unit 2 (short-link the 3 notifiers) → Task 3 Step 1. ✓
- Unit 3 (`communication.dedupe_key` + partial unique index + `claimCommunication` + claim-then-send) → Task 1 (column/helper) + Task 3 Step 2 (homeowner-notify restructure). ✓
- Migration 0046 (both columns) → Task 1 Step 2 (generated). ✓
- Done bar: no new invariant; body_quality green via short links (Task 3 test asserts the rule) + no_double_send hardened via dedupe (Task 3 test). ✓
- Backward compat: `kind` default `'booking'`; partial dedupe index → keyless inserts unaffected. ✓
- Crew/delivery already Inngest-idempotent → short-link only (documented in Task 3 rationale). ✓

**Placeholder scan:** No TBD/TODO. Task 3 Step 3 describes the seed by pattern-to-mirror (the existing homeowner-notify data shape) rather than pasting a full seed, because the exact seed depends on `listStageEventsToNotify`'s row expectations in the current code — the assertions and the two behaviors under test are fully specified. All production code is given verbatim.

**Type consistency:** `resolveBookingLink → {token,kind}|null` is consistent between Task 1 (def) and Task 2 (route consumer). `createStatusLink(args)→Promise<string>` and `claimCommunication(input)→{id}|null` match between Task 1 (def + tests) and Task 3 (callers). `dedupeKey` format `stage:{channel}:{to}:{eventId}` is consistent between the spec, Task 1 test, and Task 3 callers.

## Out of scope / follow-ups
- Tenant-tz "Tomorrow, 2:00 PM" datetime rendering (bodies carry no datetimes; not invariant-linked).
- Extending the `claimCommunication` claim pattern to `appointment-reminders` or other send paths (crew/delivery are already Inngest-idempotent).
- Renaming `booking_link` → `short_link` (cosmetic; deferred).
