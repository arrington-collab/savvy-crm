# Phase 3 — Comms Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the SMS-drip + email core of the Comms agent: durable, templated/AI-drafted message sequences that send on schedule, stop automatically on reply/convert/opt-out/manual, all logged to `communication` and tenant-scoped.

**Architecture:** New tenant-scoped tables (`message_template`, `drip`, `drip_enrollment`) + opt-out booleans on `customer`. One Inngest function (`dripRun`) per enrollment: it creates the enrollment, then loops the drip's steps with `step.sleep` between them, re-checking enrollment status each step. Stops use a belt-and-suspenders model: the stop *source* sets `status='stopped'` in the DB synchronously AND emits `drip/stop`, which `cancelOn` uses to kill the sleeping run (matched on `customerId`). Rendering is either `{{var}}` template substitution or an AI draft via the capability gateway. Email goes through a Resend-backed `EmailSender` interface; SMS reuses the existing `SmsSender`. A `/comms` UI does CRUD over the three tables; inbound SMS / email-unsubscribe / a voice capture stub feed stops and logs.

**Tech Stack:** Next.js 16 (App Router) · Drizzle + Postgres RLS · Inngest · Vitest + Playwright · Resend · the LiteLLM capability gateway. pnpm + Turborepo monorepo.

---

## Conventions (Phase 0/2 — every task MUST follow)

- App/agent code imports drizzle operators (`eq`, `and`, `sql`, …) and tables from **`@savvy/db`**, and `z` from **`@savvy/core`** — never from `drizzle-orm`/`zod` directly (pnpm duplicate-instance → type errors).
- In-package tests use **relative** imports with **`.js` extensions** (e.g. `../src/tenant.js`) — that's how the existing `packages/db/tests/isolation.test.ts` does it (tsx/vitest resolve `.js`→`.ts`).
- App/agent **source** (non-test) internal relative imports carry **no extension** (Turbopack can't resolve `.js`→`.ts` for source-only workspace packages).
- Every app DB access goes through **`withTenant(tenantId, (tx) => …)`**. New tenant tables get **`tenantIsolation()`** in the schema.
- All AI calls go through the gateway by **capability** (`reason` | `summarize` | `cheap-classify`), never a model string in feature code.
- Anything multi-step/async is an **Inngest** function. Integrations sit **behind an interface** and are **mocked in tests**.
- Server actions start with `"use server"`. No secrets in the repo — document new env in `.env.example`.

## Run / test reference (use throughout)

- Start DB: `docker compose up -d`
- DB env (export once in your shell for DB-touching tests/migrations):
  ```bash
  export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
  export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
  ```
- **Running tests:** only `@savvy/db` and `@savvy/agents` have a `test` script. `@savvy/core`/`@savvy/integrations`/`apps/web` do NOT — `pnpm --filter @savvy/core test` is a silent no-op. Run from the repo root: **`pnpm test <filename-pattern>`** (root `test` = `vitest run` over the `packages/*` workspace; the pattern filters by test filename). Examples: `pnpm test enums`, `pnpm test render-template`, `pnpm test email`. DB-touching tests need the DB env exported (e.g. `pnpm test stop-drip`). Wherever a task step says `pnpm --filter <pkg> test <pattern>`, substitute `pnpm test <pattern>` from the root.
- Full gate: `pnpm typecheck && pnpm lint && pnpm test` (with DB env exported)
- Branch is already `feat/phase3-comms-agent`. Commit per task.

## File map (what each task creates/modifies)

**Create:**
- `packages/core/src/render-template.ts` — `renderTemplate(body, vars)`
- `packages/core/src/comms.ts` — drip types, `isStopKeyword`, unsubscribe token sign/verify
- `packages/integrations/src/email.ts` — `EmailSender` interface + `resendEmail`
- `packages/db/src/lifecycle/stop-drip.ts` — `stopDripEnrollments`
- `packages/agents/src/functions/drip.ts` — `draftMessage`, `sendDripStep`, `dripRun`
- `packages/agents/src/functions/drip.test.ts` — pure-helper unit tests
- `packages/db/tests/stop-drip.test.ts` — `stopDripEnrollments` integration test
- `packages/agents/src/functions/drip-send.test.ts` — `sendDripStep` integration test
- `apps/web/src/app/api/unsubscribe/[token]/route.ts`
- `apps/web/src/app/api/twilio/voice/route.ts`
- `apps/web/src/lib/comms-queries.ts`
- `apps/web/src/lib/comms-actions.ts`
- `apps/web/src/app/(app)/comms/page.tsx` (+ `templates/page.tsx`, `drips/page.tsx`, `enrollments/page.tsx`, `template-form.tsx`, `enroll-controls.tsx`)
- `apps/web/tests/e2e/comms.spec.ts`

**Modify:**
- `packages/core/src/enums.ts` — drip/message enums + types
- `packages/core/src/index.ts` — export new modules
- `packages/db/src/schema/enums.ts` — new pgEnums
- `packages/db/src/schema/crm.ts` — `smsOptOut`/`emailOptOut` on `customer`
- `packages/db/src/schema/comms.ts` — 3 new tables
- `packages/db/src/index.ts` — export `stopDripEnrollments`
- `packages/db/tests/isolation.test.ts` — extend to new tables
- `packages/integrations/src/index.ts` — export email
- `packages/agents/src/client.ts` — `drip/enroll`, `drip/stop` events
- `packages/agents/src/index.ts` — register `dripRun`
- `packages/agents/src/functions/lead-intake.ts` — emit `drip/stop {converted}` in `leadBooked`
- `apps/web/src/app/api/twilio/inbound/route.ts` — inbound-SMS handling
- `apps/web/src/app/(app)/layout.tsx` — `Comms` nav link
- `packages/db/src/seed.ts` — starter templates + drip
- `.env.example` — `RESEND_API_KEY`, `EMAIL_FROM`, `UNSUBSCRIBE_SECRET`

---

## Task 1: Core enums + drip types

**Files:**
- Modify: `packages/core/src/enums.ts`
- Test: `packages/core/src/enums.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/enums.test.ts
import { describe, it, expect } from "vitest";
import { MESSAGE_CHANNEL, DRIP_STATUS, DRIP_STOP_REASON } from "./enums";

describe("phase 3 enums", () => {
  it("message channel is sms|email only (no call)", () => {
    expect(MESSAGE_CHANNEL).toEqual(["sms", "email"]);
  });
  it("drip status + stop reasons", () => {
    expect(DRIP_STATUS).toEqual(["active", "stopped", "completed"]);
    expect(DRIP_STOP_REASON).toEqual(["reply", "converted", "opted_out", "manual"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core test enums`
Expected: FAIL — `MESSAGE_CHANNEL` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/core/src/enums.ts`:

```ts
// --- Phase 3 (comms) ---
export const MESSAGE_CHANNEL = ["sms", "email"] as const;
export const DRIP_STATUS = ["active", "stopped", "completed"] as const;
export const DRIP_STOP_REASON = ["reply", "converted", "opted_out", "manual"] as const;
export const AI_DRAFT_CAPABILITY = ["reason", "summarize"] as const;

export type MessageChannel = (typeof MESSAGE_CHANNEL)[number];
export type DripStatus = (typeof DRIP_STATUS)[number];
export type DripStopReason = (typeof DRIP_STOP_REASON)[number];

// One step in a drip sequence. References a template by key OR carries an inline
// AI prompt. delayHours is the wait BEFORE this step sends (relative to prior step).
export type DripStep = {
  stepNum: number;
  delayHours: number;
  channel: MessageChannel;
  templateKey?: string;
  aiPrompt?: string;
  aiCapability?: (typeof AI_DRAFT_CAPABILITY)[number];
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/core test enums`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/enums.ts packages/core/src/enums.test.ts
git commit -m "feat(core): phase 3 comms enums + DripStep type"
```

---

## Task 2: `renderTemplate` helper

**Files:**
- Create: `packages/core/src/render-template.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/render-template.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/render-template.test.ts
import { describe, it, expect, vi } from "vitest";
import { renderTemplate } from "./render-template";

describe("renderTemplate", () => {
  it("substitutes {{var}} (with surrounding whitespace tolerance)", () => {
    expect(renderTemplate("Hi {{name}}, see {{ link }}", { name: "Jane", link: "x" }))
      .toBe("Hi Jane, see x");
  });
  it("renders unknown vars as empty string and does not throw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(renderTemplate("Hi {{missing}}!", { name: "Jane" })).toBe("Hi !");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it("leaves text without placeholders unchanged", () => {
    expect(renderTemplate("plain body", {})).toBe("plain body");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core test render-template`
Expected: FAIL — cannot find `./render-template`.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/render-template.ts

/**
 * Substitutes {{var}} placeholders in `body` with values from `vars`.
 * Unknown vars render as "" and are logged (never throws — a bad template
 * must not break a send).
 */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    if (key in vars) return vars[key]!;
    console.warn(`renderTemplate: unknown variable {{${key}}} -> empty`);
    return "";
  });
}
```

Add to `packages/core/src/index.ts`:

```ts
export * from "./render-template";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/core test render-template`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/render-template.ts packages/core/src/render-template.test.ts packages/core/src/index.ts
git commit -m "feat(core): renderTemplate {{var}} substitution (no-throw on missing)"
```

---

## Task 3: Stop-keyword detection + unsubscribe token

**Files:**
- Create: `packages/core/src/comms.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/comms.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/comms.test.ts
import { describe, it, expect } from "vitest";
import { isStopKeyword, signUnsubToken, verifyUnsubToken } from "./comms";

describe("isStopKeyword", () => {
  it("matches STOP/UNSUBSCRIBE/CANCEL case-insensitively, trimmed", () => {
    for (const w of ["STOP", "stop", " Stop ", "UNSUBSCRIBE", "cancel"]) {
      expect(isStopKeyword(w)).toBe(true);
    }
  });
  it("does not match ordinary replies", () => {
    expect(isStopKeyword("Yes please book me")).toBe(false);
    expect(isStopKeyword("stopwatch")).toBe(false);
  });
});

describe("unsubscribe token", () => {
  const secret = "test-secret";
  it("round-trips a customerId", () => {
    const tok = signUnsubToken("cust-123", secret);
    expect(verifyUnsubToken(tok, secret)).toBe("cust-123");
  });
  it("rejects a tampered token", () => {
    const tok = signUnsubToken("cust-123", secret);
    expect(verifyUnsubToken(tok + "x", secret)).toBeNull();
    expect(verifyUnsubToken(tok, "wrong-secret")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core test comms`
Expected: FAIL — cannot find `./comms`.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/comms.ts
import { createHmac } from "node:crypto";

const STOP_WORDS = new Set(["stop", "unsubscribe", "cancel"]);

/** True if the whole (trimmed) SMS body is a stop keyword. */
export function isStopKeyword(body: string): boolean {
  return STOP_WORDS.has(body.trim().toLowerCase());
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Signed, URL-safe unsubscribe token: `<customerId>.<hmac>`. */
export function signUnsubToken(customerId: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(customerId).digest();
  return `${b64url(Buffer.from(customerId))}.${b64url(sig)}`;
}

/** Returns the customerId if the token is valid, else null. */
export function verifyUnsubToken(token: string, secret: string): string | null {
  const [idPart, sigPart] = token.split(".");
  if (!idPart || !sigPart) return null;
  let customerId: string;
  try {
    customerId = Buffer.from(idPart, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = b64url(createHmac("sha256", secret).update(customerId).digest());
  return expected === sigPart ? customerId : null;
}
```

Add to `packages/core/src/index.ts`:

```ts
export * from "./comms";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/core test comms`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/comms.ts packages/core/src/comms.test.ts packages/core/src/index.ts
git commit -m "feat(core): stop-keyword detection + signed unsubscribe token"
```

---

## Task 4: DB schema — opt-out columns, message_template, drip, drip_enrollment + migration

**Files:**
- Modify: `packages/db/src/schema/enums.ts`
- Modify: `packages/db/src/schema/crm.ts`
- Modify: `packages/db/src/schema/comms.ts`
- Create migration via `db:generate`

- [ ] **Step 1: Add pgEnums**

Edit `packages/db/src/schema/enums.ts` — extend the import and add three enums:

```ts
import { pgEnum } from "drizzle-orm/pg-core";
import {
  JOB_TYPE, JOB_STAGE, TASK_STATUS, AUTOMATION_LEVEL, AGENT,
  COMM_CHANNEL, COMM_DIRECTION, LEAD_STATUS, USER_ROLE,
  MESSAGE_CHANNEL, DRIP_STATUS, DRIP_STOP_REASON,
} from "@savvy/core";

export const jobTypeEnum = pgEnum("job_type", JOB_TYPE);
export const jobStageEnum = pgEnum("job_stage", JOB_STAGE);
export const taskStatusEnum = pgEnum("task_status", TASK_STATUS);
export const automationLevelEnum = pgEnum("automation_level", AUTOMATION_LEVEL);
export const agentEnum = pgEnum("agent", AGENT);
export const commChannelEnum = pgEnum("comm_channel", COMM_CHANNEL);
export const commDirectionEnum = pgEnum("comm_direction", COMM_DIRECTION);
export const leadStatusEnum = pgEnum("lead_status", LEAD_STATUS);
export const userRoleEnum = pgEnum("user_role", USER_ROLE);
export const messageChannelEnum = pgEnum("message_channel", MESSAGE_CHANNEL);
export const dripStatusEnum = pgEnum("drip_status", DRIP_STATUS);
export const dripStopReasonEnum = pgEnum("drip_stop_reason", DRIP_STOP_REASON);
```

- [ ] **Step 2: Add opt-out columns to `customer`**

Edit `packages/db/src/schema/crm.ts`. Add `boolean` to the pg-core import and two columns to `customer`:

```ts
import { pgTable, uuid, text, integer, doublePrecision, boolean, index } from "drizzle-orm/pg-core";
```

In the `customer` table, after `billingAddress`:

```ts
  billingAddress: text("billing_address"),
  smsOptOut: boolean("sms_opt_out").default(false).notNull(),
  emailOptOut: boolean("email_opt_out").default(false).notNull(),
  createdAt: createdAt(),
```

- [ ] **Step 3: Add the three tables**

Edit `packages/db/src/schema/comms.ts`. Replace the import block and append the tables:

```ts
import { pgTable, uuid, text, boolean, integer, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idCol, createdAt, updatedAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";
import { customer } from "./crm";
import { job } from "./jobs";
import { lead } from "./crm";
import { commChannelEnum, commDirectionEnum, messageChannelEnum, dripStatusEnum, dripStopReasonEnum } from "./enums";
import type { DripStep } from "@savvy/core";
```

(Keep the existing `communication` and `appointment` tables unchanged.) Append:

```ts
export const messageTemplate = pgTable("message_template", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  key: text("key").notNull(),                  // stable per-tenant identifier
  name: text("name").notNull(),
  channel: messageChannelEnum("channel").notNull(),
  subject: text("subject"),                    // email only
  body: text("body").notNull(),                // may contain {{vars}}
  aiCapability: text("ai_capability"),         // if set, body is an AI prompt rendered at send
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("msg_tmpl_tenant_key_idx").on(t.tenantId, t.key), tenantIsolation()]);

export const drip = pgTable("drip", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  key: text("key").notNull(),
  name: text("name").notNull(),
  triggerEvent: text("trigger_event"),         // informational, e.g. "lead/created"
  steps: jsonb("steps").$type<DripStep[]>().notNull().default(sql`'[]'::jsonb`),
  active: boolean("active").default(true).notNull(),
  createdAt: createdAt(),
}, (t) => [index("drip_tenant_key_idx").on(t.tenantId, t.key), tenantIsolation()]);

export const dripEnrollment = pgTable("drip_enrollment", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  dripId: uuid("drip_id").notNull().references(() => drip.id),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  jobId: uuid("job_id").references(() => job.id),
  leadId: uuid("lead_id").references(() => lead.id),
  status: dripStatusEnum("status").notNull().default("active"),
  currentStep: integer("current_step").notNull().default(0),
  stoppedReason: dripStopReasonEnum("stopped_reason"),
  inngestRunId: text("inngest_run_id"),
  enrolledAt: createdAt(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [
  index("drip_enr_tenant_customer_idx").on(t.tenantId, t.customerId),
  index("drip_enr_tenant_status_idx").on(t.tenantId, t.status),
  // At most one ACTIVE enrollment per (drip, customer).
  uniqueIndex("drip_enr_active_uniq").on(t.dripId, t.customerId).where(sql`status = 'active'`),
  tenantIsolation(),
]);
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter @savvy/db db:generate`
Expected: a new file `packages/db/drizzle/0002_*.sql` containing `CREATE TYPE message_channel/drip_status/drip_stop_reason`, `ALTER TABLE customer ADD COLUMN sms_opt_out/email_opt_out`, and `CREATE TABLE message_template/drip/drip_enrollment` with `CREATE POLICY tenant_isolation`.

Open the generated SQL and confirm the three `CREATE POLICY "tenant_isolation" ... TO "savvy_app"` statements and the partial unique index are present.

- [ ] **Step 5: Apply migration + verify build**

Run (DB env exported):
```bash
pnpm --filter @savvy/db db:migrate
pnpm --filter @savvy/db typecheck
```
Expected: `migrations + grants applied`; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema packages/db/drizzle
git commit -m "feat(db): message_template, drip, drip_enrollment tables + customer opt-out cols"
```

---

## Task 5: `stopDripEnrollments` DB helper + integration test

**Files:**
- Create: `packages/db/src/lifecycle/stop-drip.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/tests/stop-drip.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/stop-drip.test.ts
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { pool } from "../src/client.js";
import { withTenant } from "../src/tenant.js";
import { stopDripEnrollments } from "../src/lifecycle/stop-drip.js";
import { tenant, customer, drip, dripEnrollment } from "../src/schema/index.js";

let tId: string, custId: string, dripId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "SD", publicKey: "sd", clerkOrgId: "org_sd" }).returning();
  tId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tId, name: "C" }).returning();
  custId = c!.id;
  const [d] = await adminDb.insert(drip).values({ tenantId: tId, key: "k", name: "D", steps: [] }).returning();
  dripId = d!.id;
  await adminDb.insert(dripEnrollment).values({ tenantId: tId, dripId, customerId: custId, status: "active" });
});

afterAll(async () => {
  await adminDb.delete(dripEnrollment).where(eq(dripEnrollment.tenantId, tId));
  await adminDb.delete(drip).where(eq(drip.tenantId, tId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

describe("stopDripEnrollments", () => {
  it("sets active enrollments for a customer to stopped + reason and returns their ids", async () => {
    const ids = await withTenant(tId, (tx) =>
      stopDripEnrollments(tx, { tenantId: tId, customerId: custId, reason: "reply" }),
    );
    expect(ids.length).toBe(1);
    const [row] = await adminDb.select().from(dripEnrollment).where(eq(dripEnrollment.id, ids[0]!));
    expect(row!.status).toBe("stopped");
    expect(row!.stoppedReason).toBe("reply");
  });

  it("is a no-op when there are no active enrollments", async () => {
    const ids = await withTenant(tId, (tx) =>
      stopDripEnrollments(tx, { tenantId: tId, customerId: custId, reason: "manual" }),
    );
    expect(ids).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db test stop-drip`
Expected: FAIL — cannot find `../src/lifecycle/stop-drip.js`.

- [ ] **Step 3: Implement**

```ts
// packages/db/src/lifecycle/stop-drip.ts
import { and, eq } from "drizzle-orm";
import { dripEnrollment } from "../schema/index";
import type { DripStopReason } from "@savvy/core";

type Tx = Parameters<Parameters<typeof import("../client").db.transaction>[0]>[0];

/**
 * Marks every ACTIVE drip enrollment for a customer as stopped with the given
 * reason. Tenant-scoped (call inside withTenant). Returns the affected ids so
 * the caller can decide whether to emit drip/stop. Pure DB — emits no events.
 */
export async function stopDripEnrollments(
  tx: Tx,
  opts: { tenantId: string; customerId: string; reason: DripStopReason },
): Promise<string[]> {
  const rows = await tx
    .update(dripEnrollment)
    .set({ status: "stopped", stoppedReason: opts.reason })
    .where(and(
      eq(dripEnrollment.customerId, opts.customerId),
      eq(dripEnrollment.status, "active"),
    ))
    .returning({ id: dripEnrollment.id });
  return rows.map((r) => r.id);
}
```

Add to `packages/db/src/index.ts` (after the `recordStageChange` export):

```ts
export { stopDripEnrollments } from "./lifecycle/stop-drip";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db test stop-drip`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/stop-drip.ts packages/db/src/index.ts packages/db/tests/stop-drip.test.ts
git commit -m "feat(db): stopDripEnrollments helper (active->stopped, tenant-scoped)"
```

---

## Task 6: Extend RLS isolation test to the new tables

**Files:**
- Modify: `packages/db/tests/isolation.test.ts`

- [ ] **Step 1: Add tenant-B fixtures + assertions**

In `beforeAll`, after the `jobStageEvent` insert, add a template + drip + enrollment for tenant B:

```ts
  await adminDb.insert(messageTemplate).values({ tenantId: b!.id, key: "b-tmpl", name: "B tmpl", channel: "sms", body: "hi" });
  const [bDrip] = await adminDb.insert(drip).values({ tenantId: b!.id, key: "b-drip", name: "B drip", steps: [] }).returning();
  await adminDb.insert(dripEnrollment).values({ tenantId: b!.id, dripId: bDrip!.id, customerId: cb!.id, status: "active" });
```

Update the import line to include the new tables:

```ts
import { tenant, customer, property, job, jobStageEvent, messageTemplate, drip, dripEnrollment } from "../src/schema/index.js";
```

In `afterAll`, delete the new rows BEFORE deleting `customer`/`tenant` (FK order: enrollment → drip/template):

```ts
  await adminDb.delete(dripEnrollment).where(eq(dripEnrollment.tenantId, tenantBId));
  await adminDb.delete(drip).where(eq(drip.tenantId, tenantBId));
  await adminDb.delete(messageTemplate).where(eq(messageTemplate.tenantId, tenantBId));
```

Add assertions in the `describe` block:

```ts
  it("SELECT on comms tables is tenant-scoped (A cannot see B)", async () => {
    const tmpls = await withTenant(tenantAId, (tx) => tx.select().from(messageTemplate));
    expect(tmpls.some((r) => r.tenantId === tenantBId)).toBe(false);
    const drips = await withTenant(tenantAId, (tx) => tx.select().from(drip));
    expect(drips.some((r) => r.tenantId === tenantBId)).toBe(false);
    const enrs = await withTenant(tenantAId, (tx) => tx.select().from(dripEnrollment));
    expect(enrs.some((r) => r.tenantId === tenantBId)).toBe(false);
  });
```

- [ ] **Step 2: Run to verify it passes**

Run: `pnpm --filter @savvy/db test isolation`
Expected: PASS — existing tests + the new one all green (A sees zero of B's comms rows).

- [ ] **Step 3: Commit**

```bash
git add packages/db/tests/isolation.test.ts
git commit -m "test(db): RLS isolation covers message_template/drip/drip_enrollment"
```

---

## Task 7: `EmailSender` (Resend) integration + env

**Files:**
- Create: `packages/integrations/src/email.ts`
- Modify: `packages/integrations/src/index.ts`
- Modify: `.env.example`
- Test: `packages/integrations/src/email.test.ts` (create)

- [ ] **Step 1: Write the failing test**

The real `resendEmail` calls Resend's HTTP API; we test it against an injected `fetch` so no network/creds are needed.

```ts
// packages/integrations/src/email.test.ts
import { describe, it, expect, vi } from "vitest";
import { makeResendEmail } from "./email";

describe("resendEmail", () => {
  it("POSTs to Resend and returns the message id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "resend-123" }),
    });
    const sender = makeResendEmail({ apiKey: "re_test", fetchImpl: fetchMock as never });
    const res = await sender.sendEmail({ to: "a@b.com", from: "x@y.com", subject: "Hi", html: "<p>hi</p>" });
    expect(res.id).toBe("resend-123");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => "bad" });
    const sender = makeResendEmail({ apiKey: "re_test", fetchImpl: fetchMock as never });
    await expect(sender.sendEmail({ to: "a@b.com", from: "x@y.com", subject: "s", html: "h" }))
      .rejects.toThrow(/resend/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/integrations test email`
Expected: FAIL — cannot find `./email`.

- [ ] **Step 3: Implement**

```ts
// packages/integrations/src/email.ts

export interface EmailSender {
  sendEmail(opts: { to: string; from: string; subject: string; html: string }): Promise<{ id: string }>;
}

/** Factory so tests inject apiKey + fetch. Real export reads env below. */
export function makeResendEmail(cfg: { apiKey: string; fetchImpl?: typeof fetch }): EmailSender {
  const doFetch = cfg.fetchImpl ?? fetch;
  return {
    async sendEmail({ to, from, subject, html }) {
      const res = await doFetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({ to, from, subject, html }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`resend send failed: ${res.status} ${detail}`);
      }
      const data = (await res.json()) as { id: string };
      return { id: data.id };
    },
  };
}

// Real implementation bound to env. Feature code imports `resendEmail`.
export const resendEmail: EmailSender = makeResendEmail({
  apiKey: process.env.RESEND_API_KEY ?? "",
});
```

Add to `packages/integrations/src/index.ts`:

```ts
export { resendEmail, makeResendEmail, type EmailSender } from "./email";
```

Append to `.env.example`:

```bash
# Resend (transactional email — Phase 3 comms)
RESEND_API_KEY=
EMAIL_FROM="Savvy <noreply@example.com>"
# Signs email unsubscribe tokens
UNSUBSCRIBE_SECRET=dev-unsubscribe-secret
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/integrations test email`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/integrations/src/email.ts packages/integrations/src/index.ts packages/integrations/src/email.test.ts .env.example
git commit -m "feat(integrations): EmailSender interface + Resend impl + env"
```

---

## Task 8: Inngest events + `draftMessage` pure helper

**Files:**
- Modify: `packages/agents/src/client.ts`
- Create: `packages/agents/src/functions/drip.ts`
- Test: `packages/agents/src/functions/drip.test.ts` (create)

- [ ] **Step 1: Add the two events**

Edit `packages/agents/src/client.ts` `Events` type — add:

```ts
  "drip/enroll": { data: { tenantId: string; dripKey: string; customerId: string; jobId?: string; leadId?: string } };
  "drip/stop": { data: { tenantId: string; customerId: string; reason: "reply" | "converted" | "opted_out" | "manual" } };
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/agents/src/functions/drip.test.ts
import { describe, it, expect, vi } from "vitest";
import { draftMessage } from "./drip";

const ctx = { name: "Jane Homeowner", firstName: "Jane" };

describe("draftMessage", () => {
  it("template step: renders body, aiHandled=false, no AI call", async () => {
    const ai = { complete: vi.fn() };
    const res = await draftMessage(
      { step: { stepNum: 1, delayHours: 0, channel: "sms", templateKey: "welcome" }, templateBody: "Hi {{firstName}}!", ctx },
      ai as never,
    );
    expect(res.body).toBe("Hi Jane!");
    expect(res.aiHandled).toBe(false);
    expect(ai.complete).not.toHaveBeenCalled();
  });

  it("AI step: calls the gateway with the step prompt, aiHandled=true", async () => {
    const ai = { complete: vi.fn().mockResolvedValue({ text: "Drafted hello", model: "gemini-flash" }) };
    const res = await draftMessage(
      { step: { stepNum: 2, delayHours: 0, channel: "email", aiPrompt: "Write a friendly nudge" }, ctx },
      ai as never,
    );
    expect(res.body).toBe("Drafted hello");
    expect(res.aiHandled).toBe(true);
    expect(res.model).toBe("gemini-flash");
    expect(ai.complete).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "summarize" }),
    );
  });

  it("AI step honors an explicit aiCapability", async () => {
    const ai = { complete: vi.fn().mockResolvedValue({ text: "x", model: "claude-sonnet" }) };
    await draftMessage(
      { step: { stepNum: 3, delayHours: 0, channel: "sms", aiPrompt: "nuanced", aiCapability: "reason" }, ctx },
      ai as never,
    );
    expect(ai.complete).toHaveBeenCalledWith(expect.objectContaining({ capability: "reason" }));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @savvy/agents test drip`
Expected: FAIL — cannot find `./drip`.

- [ ] **Step 4: Implement `draftMessage` (start the file)**

```ts
// packages/agents/src/functions/drip.ts
import { renderTemplate, type DripStep } from "@savvy/core";
import * as ai from "@savvy/ai";

export type DripContext = { name: string; firstName: string };

export type DraftedMessage = { body: string; aiHandled: boolean; model?: string };

/**
 * Produces the message body for a drip step. Template step -> {{var}} render;
 * AI step -> capability-gateway draft. Pure: `aiClient` is injectable for tests.
 */
export async function draftMessage(
  input: { step: DripStep; templateBody?: string; ctx: DripContext },
  aiClient: Pick<typeof ai, "complete"> = ai,
): Promise<DraftedMessage> {
  const { step, templateBody, ctx } = input;
  if (step.aiPrompt) {
    const { text, model } = await aiClient.complete({
      capability: step.aiCapability ?? "summarize",
      system: "You write short, friendly roofing-company follow-up messages. No placeholders.",
      prompt: `${step.aiPrompt}\n\nContact: ${ctx.name}. Keep it concise for ${step.channel}.`,
    });
    return { body: text, aiHandled: true, model };
  }
  const vars: Record<string, string> = { name: ctx.name, firstName: ctx.firstName };
  return { body: renderTemplate(templateBody ?? "", vars), aiHandled: false };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @savvy/agents test drip`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/client.ts packages/agents/src/functions/drip.ts packages/agents/src/functions/drip.test.ts
git commit -m "feat(agents): drip/enroll+drip/stop events + draftMessage helper"
```

---

## Task 9: `sendDripStep` (render → send → log) + integration test

**Files:**
- Modify: `packages/agents/src/functions/drip.ts`
- Test: `packages/agents/src/functions/drip-send.test.ts` (create)

- [ ] **Step 1: Write the failing integration test (real DB, mock senders)**

```ts
// packages/agents/src/functions/drip-send.test.ts
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  adminDb, adminPool, pool, withTenant, eq,
  tenant, customer, drip, dripEnrollment, communication,
} from "@savvy/db";
import { sendDripStep } from "./drip";

let tId: string, custId: string, dripId: string, enrId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "DS", publicKey: "ds", clerkOrgId: "org_ds" }).returning();
  tId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tId, name: "Pat Owner", phone: "+15555551234", email: "pat@x.com" }).returning();
  custId = c!.id;
  const [d] = await adminDb.insert(drip).values({ tenantId: tId, key: "k", name: "D", steps: [] }).returning();
  dripId = d!.id;
  const [e] = await adminDb.insert(dripEnrollment).values({ tenantId: tId, dripId, customerId: custId, status: "active" }).returning();
  enrId = e!.id;
});

afterAll(async () => {
  await adminDb.delete(communication).where(eq(communication.tenantId, tId));
  await adminDb.delete(dripEnrollment).where(eq(dripEnrollment.tenantId, tId));
  await adminDb.delete(drip).where(eq(drip.tenantId, tId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

describe("sendDripStep", () => {
  it("sends an SMS template step, logs a communication, advances current_step", async () => {
    const sms = { sendSms: vi.fn().mockResolvedValue({ sid: "sm-1" }) };
    const email = { sendEmail: vi.fn() };
    await sendDripStep(
      {
        tenantId: tId, enrollmentId: enrId, customerId: custId,
        step: { stepNum: 1, delayHours: 0, channel: "sms", templateKey: "welcome" },
        templateBody: "Hi {{firstName}}!",
      },
      { sms, email, ai: { complete: vi.fn() } as never },
    );
    expect(sms.sendSms).toHaveBeenCalledOnce();
    const comms = await adminDb.select().from(communication).where(eq(communication.customerId, custId));
    expect(comms.length).toBe(1);
    expect(comms[0]!.channel).toBe("sms");
    expect(comms[0]!.body).toBe("Hi Pat!");
    const [enr] = await adminDb.select().from(dripEnrollment).where(eq(dripEnrollment.id, enrId));
    expect(enr!.currentStep).toBe(1);
  });

  it("suppresses the send when the channel is opted out (logs nothing sent)", async () => {
    await adminDb.update(customer).set({ smsOptOut: true }).where(eq(customer.id, custId));
    const sms = { sendSms: vi.fn() };
    await sendDripStep(
      {
        tenantId: tId, enrollmentId: enrId, customerId: custId,
        step: { stepNum: 2, delayHours: 0, channel: "sms", templateKey: "welcome" },
        templateBody: "Hi again",
      },
      { sms, email: { sendEmail: vi.fn() }, ai: { complete: vi.fn() } as never },
    );
    expect(sms.sendSms).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/agents test drip-send`
Expected: FAIL — `sendDripStep` is not exported.

- [ ] **Step 3: Implement `sendDripStep`**

Append to `packages/agents/src/functions/drip.ts`:

```ts
import {
  withTenant, eq, customer, communication, agentRun, dripEnrollment,
} from "@savvy/db";
import type { SmsSender, EmailSender } from "@savvy/integrations";

export type SendDeps = { sms: SmsSender; email: EmailSender; ai?: Pick<typeof ai, "complete"> };

function firstNameOf(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

/**
 * Renders + sends one drip step, logs a communication + agent_run, advances
 * current_step. Suppresses (and logs nothing sent) when the channel is opted
 * out. Senders are injected + fail-soft (a missing-creds throw still logs the
 * comm with a mock id). Tenant-scoped.
 */
export async function sendDripStep(
  input: {
    tenantId: string; enrollmentId: string; customerId: string;
    step: DripStep; templateBody?: string; jobId?: string;
  },
  deps: SendDeps,
): Promise<{ sent: boolean }> {
  const { tenantId, enrollmentId, customerId, step, templateBody, jobId } = input;

  const c = await withTenant(tenantId, async (tx) => {
    const [row] = await tx.select().from(customer).where(eq(customer.id, customerId));
    return row!;
  });

  const optedOut = step.channel === "sms" ? c.smsOptOut : c.emailOptOut;
  if (optedOut) {
    await withTenant(tenantId, (tx) =>
      tx.insert(communication).values({
        tenantId, customerId, jobId: jobId ?? null, channel: step.channel, direction: "outbound",
        to: step.channel === "sms" ? c.phone : c.email,
        body: `[suppressed: ${step.channel} opt-out]`, aiHandled: false,
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.update(dripEnrollment).set({ currentStep: step.stepNum }).where(eq(dripEnrollment.id, enrollmentId)),
    );
    return { sent: false };
  }

  const ctx = { name: c.name, firstName: firstNameOf(c.name) };
  const drafted = await draftMessage({ step, templateBody, ctx }, deps.ai ?? ai);

  let providerId = "mock";
  try {
    if (step.channel === "sms") {
      ({ sid: providerId } = await deps.sms.sendSms({
        to: c.phone ?? "", from: process.env.TWILIO_FROM ?? "+15555550000", body: drafted.body,
      }));
    } else {
      ({ id: providerId } = await deps.email.sendEmail({
        to: c.email ?? "", from: process.env.EMAIL_FROM ?? "noreply@example.com",
        subject: "A note from your roofing team", html: drafted.body,
      }));
    }
  } catch {
    // No creds in dev/test — still log the comm with a mock id (fail-soft).
  }

  await withTenant(tenantId, async (tx) => {
    await tx.insert(communication).values({
      tenantId, customerId, jobId: jobId ?? null, channel: step.channel, direction: "outbound",
      to: step.channel === "sms" ? c.phone : c.email, body: drafted.body,
      twilioSid: step.channel === "sms" ? providerId : null, aiHandled: drafted.aiHandled,
    });
    await tx.insert(agentRun).values({
      tenantId, agent: "comms", jobId: jobId ?? null, status: "ok", modelUsed: drafted.model ?? null,
    });
    await tx.update(dripEnrollment).set({ currentStep: step.stepNum }).where(eq(dripEnrollment.id, enrollmentId));
  });

  return { sent: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/agents test drip-send`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the pure unit test again (no regression)**

Run: `pnpm --filter @savvy/agents test drip.test`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/functions/drip.ts packages/agents/src/functions/drip-send.test.ts
git commit -m "feat(agents): sendDripStep — render/send/log one step, opt-out suppression"
```

---

## Task 10: `dripRun` Inngest function + convert-stop wiring + registration

**Files:**
- Modify: `packages/agents/src/functions/drip.ts`
- Modify: `packages/agents/src/index.ts`
- Modify: `packages/agents/src/functions/lead-intake.ts`

- [ ] **Step 1: Implement `dripRun`**

Append to `packages/agents/src/functions/drip.ts`:

```ts
import { and, drip, messageTemplate } from "@savvy/db";
import { twilioSms } from "@savvy/integrations";
import { resendEmail } from "@savvy/integrations";
import { inngest } from "../client";

/**
 * One run per enrollment. Creates the enrollment, then walks the drip's steps:
 * sleep -> re-check status (stopped? exit) -> send. Cancellation: drip/stop
 * matched on customerId kills the run mid-sleep; the stop SOURCE has already
 * set status='stopped' in the DB, and the per-step re-check is the backstop.
 */
export const dripRun = inngest.createFunction(
  { id: "drip-run", concurrency: { limit: 20 }, cancelOn: [{ event: "drip/stop", match: "data.customerId" }] },
  { event: "drip/enroll" },
  async ({ event, step, runId }) => {
    const { tenantId, dripKey, customerId, jobId, leadId } = event.data;

    const setup = await step.run("create-enrollment", async () =>
      withTenant(tenantId, async (tx) => {
        const [d] = await tx.select().from(drip).where(and(eq(drip.key, dripKey), eq(drip.active, true)));
        if (!d) return null;
        // Idempotent: skip if an active enrollment already exists for (drip, customer).
        const existing = await tx.select().from(dripEnrollment).where(and(
          eq(dripEnrollment.dripId, d.id),
          eq(dripEnrollment.customerId, customerId),
          eq(dripEnrollment.status, "active"),
        ));
        if (existing.length > 0) return null;
        const [enr] = await tx.insert(dripEnrollment).values({
          tenantId, dripId: d.id, customerId, jobId: jobId ?? null, leadId: leadId ?? null,
          status: "active", inngestRunId: runId,
        }).returning();
        return { enrollmentId: enr!.id, steps: d.steps as DripStep[] };
      }),
    );
    if (!setup) return { skipped: true };

    for (const s of setup.steps) {
      if (s.delayHours > 0) await step.sleep(`step-${s.stepNum}`, `${s.delayHours}h`);

      const stillActive = await step.run(`check-${s.stepNum}`, async () =>
        withTenant(tenantId, async (tx) => {
          const [enr] = await tx.select().from(dripEnrollment).where(eq(dripEnrollment.id, setup.enrollmentId));
          return enr?.status === "active";
        }),
      );
      if (!stillActive) return { stopped: true, atStep: s.stepNum };

      await step.run(`send-${s.stepNum}`, async () => {
        let templateBody: string | undefined;
        if (s.templateKey) {
          templateBody = await withTenant(tenantId, async (tx) => {
            const [t] = await tx.select().from(messageTemplate).where(eq(messageTemplate.key, s.templateKey!));
            return t?.body;
          });
        }
        return sendDripStep(
          { tenantId, enrollmentId: setup.enrollmentId, customerId, step: s, templateBody, jobId },
          { sms: twilioSms, email: resendEmail },
        );
      });
    }

    await step.run("complete", async () =>
      withTenant(tenantId, (tx) =>
        tx.update(dripEnrollment)
          .set({ status: "completed", completedAt: new Date() })
          .where(and(eq(dripEnrollment.id, setup.enrollmentId), eq(dripEnrollment.status, "active"))),
      ),
    );
    return { completed: true };
  },
);
```

- [ ] **Step 2: Register the function**

Edit `packages/agents/src/index.ts`:

```ts
import { examplePing } from "./functions/example";
import { leadIntake, leadBooked } from "./functions/lead-intake";
import { jobStageChanged } from "./functions/job-stage";
import { dripRun } from "./functions/drip";

export { inngest } from "./client";
export { examplePing } from "./functions/example";
export { leadIntake, leadBooked } from "./functions/lead-intake";
export { jobStageChanged } from "./functions/job-stage";
export { dripRun } from "./functions/drip";
export const functions = [examplePing, leadIntake, leadBooked, jobStageChanged, dripRun];
```

- [ ] **Step 3: Emit `drip/stop {converted}` when a lead books**

In `packages/agents/src/functions/lead-intake.ts`, inside `leadBooked`'s transaction, after `tx.update(lead).set({ status: "booked" })`, stop any active drips for that customer. Add `stopDripEnrollments` to the `@savvy/db` import, and emit the event after the transaction returns.

Change the import:
```ts
import {
  withTenant, lead, customer, job, appointment, communication, agentRun, eq,
  seedJobTasks, recordStageChange, stopDripEnrollments,
} from "@savvy/db";
```

Inside the `book-and-convert` step, before `return { jobId: newJob!.id }`, add:
```ts
        await stopDripEnrollments(tx, { tenantId, customerId: l!.customerId!, reason: "converted" });
```

After the `step.run(...)` call resolves, emit the cancel event (so the durable run is also killed). Replace the `return step.run("book-and-convert", ...)` with capturing the result then emitting:

```ts
    const result = await step.run("book-and-convert", async () =>
      withTenant(tenantId, async (tx) => {
        const [l] = await tx.select().from(lead).where(eq(lead.id, leadId));
        const [newJob] = await tx.insert(job).values({
          tenantId, customerId: l!.customerId!, propertyId: l!.propertyId!,
          type: "retail", stage: "lead", leadId,
        }).returning();
        await seedJobTasks(tx as never, { id: newJob!.id, tenantId, type: "retail" });
        await recordStageChange(tx, { tenantId, jobId: newJob!.id, toStage: "inspected", byAgent: "orchestrator" });
        await tx.insert(appointment).values({
          tenantId, jobId: newJob!.id, type: "inspection", startsAt: new Date(startsAt), status: "scheduled",
        });
        await tx.update(lead).set({ status: "booked" }).where(eq(lead.id, leadId));
        await stopDripEnrollments(tx, { tenantId, customerId: l!.customerId!, reason: "converted" });
        await tx.insert(agentRun).values({ tenantId, agent: "orchestrator", jobId: newJob!.id, status: "ok" });
        return { jobId: newJob!.id, customerId: l!.customerId! };
      }),
    );
    await step.run("emit-drip-stop", () =>
      inngest.send({ name: "drip/stop", data: { tenantId, customerId: result.customerId, reason: "converted" } }),
    );
    return { jobId: result.jobId };
```

(`inngest` is already imported at the top of `lead-intake.ts`.)

- [ ] **Step 4: Typecheck + full unit suite + build**

Run:
```bash
pnpm --filter @savvy/agents typecheck
pnpm --filter @savvy/agents test
pnpm --filter @savvy/web build
```
Expected: typecheck clean; agents tests pass (drip + drip-send + lead-intake); web build succeeds (Inngest route picks up `dripRun`).

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/functions/drip.ts packages/agents/src/index.ts packages/agents/src/functions/lead-intake.ts
git commit -m "feat(agents): dripRun engine (sleep+cancelOn) + convert-stop on lead.booked"
```

---

## Task 11: Inbound-SMS handling (reply + STOP keyword)

**Files:**
- Modify: `apps/web/src/app/api/twilio/inbound/route.ts`
- Create: `apps/web/src/lib/inbound-sms.ts`

- [ ] **Step 1: Implement the inbound-SMS helper**

```ts
// apps/web/src/lib/inbound-sms.ts
import {
  withTenant, customer, communication, eq, stopDripEnrollments,
} from "@savvy/db";
import { isStopKeyword } from "@savvy/core";
import { inngest } from "@savvy/agents";

/**
 * Handles an inbound SMS for a tenant: logs it, then either (a) STOP keyword ->
 * set sms_opt_out + stop drips (opted_out), or (b) ordinary reply -> stop drips
 * (reply). Matches the sender to a customer by phone. Returns what happened.
 */
export async function handleInboundSms(
  tenantId: string,
  opts: { from: string; body: string; twilioSid?: string },
): Promise<{ matched: boolean; stopped: "opted_out" | "reply" | null }> {
  const reason = isStopKeyword(opts.body) ? "opted_out" : "reply";

  const result = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.select().from(customer).where(eq(customer.phone, opts.from));
    await tx.insert(communication).values({
      tenantId, customerId: c?.id ?? null, channel: "sms", direction: "inbound",
      from: opts.from, body: opts.body, twilioSid: opts.twilioSid ?? null,
    });
    if (!c) return { matched: false as const, stopped: null };
    if (reason === "opted_out") {
      await tx.update(customer).set({ smsOptOut: true }).where(eq(customer.id, c.id));
    }
    const ids = await stopDripEnrollments(tx, { tenantId, customerId: c.id, reason });
    return { matched: true as const, customerId: c.id, stoppedCount: ids.length };
  });

  if (result.matched) {
    await inngest.send({ name: "drip/stop", data: { tenantId, customerId: result.customerId, reason } });
    return { matched: true, stopped: reason };
  }
  return { matched: false, stopped: null };
}
```

- [ ] **Step 2: Wire it into the route (SMS vs call)**

Replace `apps/web/src/app/api/twilio/inbound/route.ts` with:

```ts
import { NextResponse } from "next/server";
import { createLeadForTenant, tenantByPhone } from "@/lib/intake";
import { handleInboundSms } from "@/lib/inbound-sms";

export const runtime = "nodejs";

const xml = (body: string) =>
  new NextResponse(body, { status: 200, headers: { "content-type": "text/xml" } });

// Twilio posts application/x-www-form-urlencoded. A `Body` field means SMS;
// otherwise it's a voice call. `To` maps to the tenant; `From` is the contact.
export async function POST(req: Request) {
  const form = await req.formData();
  const to = String(form.get("To") ?? "");
  const from = String(form.get("From") ?? "");
  const body = form.get("Body");
  const sid = form.get("MessageSid");
  const t = await tenantByPhone(to);
  if (!t) return xml("<Response/>");

  if (body !== null) {
    // Inbound SMS: log + stop/opt-out. (Lead creation from SMS stays out of scope here.)
    await handleInboundSms(t.id, { from, body: String(body), twilioSid: sid ? String(sid) : undefined });
    return xml("<Response/>");
  }

  // Inbound voice call -> create a lead (unchanged behavior).
  await createLeadForTenant(t.id, { name: `Caller ${from}`, phone: from, address: "unknown", source: "inbound-call" });
  return xml("<Response><Say>Thanks for calling. We'll text you a booking link.</Say></Response>");
}
```

- [ ] **Step 3: Verify build + typecheck**

Run: `pnpm --filter @savvy/web typecheck`
Expected: clean. (Behavioral verification happens in the e2e task.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/inbound-sms.ts apps/web/src/app/api/twilio/inbound/route.ts
git commit -m "feat(web): inbound SMS -> log + reply/STOP drip stops + opt-out"
```

---

## Task 12: Email unsubscribe route

**Files:**
- Create: `apps/web/src/app/api/unsubscribe/[token]/route.ts`

- [ ] **Step 1: Implement**

```ts
// apps/web/src/app/api/unsubscribe/[token]/route.ts
import { NextResponse } from "next/server";
import { withTenant, adminDb, customer, eq, stopDripEnrollments } from "@savvy/db";
import { verifyUnsubToken } from "@savvy/core";
import { inngest } from "@savvy/agents";

export const runtime = "nodejs";

// Public link from outbound emails: /api/unsubscribe/<signed customerId>.
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const secret = process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret";
  const customerId = verifyUnsubToken(token, secret);
  if (!customerId) return new NextResponse("Invalid unsubscribe link", { status: 400 });

  // Resolve the tenant for this customer via the admin (RLS-bypass) connection,
  // then do the mutation tenant-scoped.
  const [c] = await adminDb.select().from(customer).where(eq(customer.id, customerId));
  if (!c) return new NextResponse("Unknown contact", { status: 404 });

  await withTenant(c.tenantId, async (tx) => {
    await tx.update(customer).set({ emailOptOut: true }).where(eq(customer.id, customerId));
    await stopDripEnrollments(tx, { tenantId: c.tenantId, customerId, reason: "opted_out" });
  });
  await inngest.send({ name: "drip/stop", data: { tenantId: c.tenantId, customerId, reason: "opted_out" } });

  return new NextResponse("You've been unsubscribed from emails.", {
    status: 200, headers: { "content-type": "text/plain" },
  });
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm --filter @savvy/web typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/unsubscribe
git commit -m "feat(web): email unsubscribe route -> email_opt_out + drip stop"
```

---

## Task 13: After-hours voice capture stub

**Files:**
- Create: `apps/web/src/app/api/twilio/voice/route.ts`

- [ ] **Step 1: Implement TwiML greeting + recording callback**

```ts
// apps/web/src/app/api/twilio/voice/route.ts
import { NextResponse } from "next/server";
import { withTenant, communication } from "@savvy/db";
import { tenantByPhone, createLeadForTenant } from "@/lib/intake";

export const runtime = "nodejs";

const xml = (body: string) =>
  new NextResponse(body, { status: 200, headers: { "content-type": "text/xml" } });

// Phase 3 voice = after-hours capture stub (NO LLM conversation). First hit:
// greet + <Record>. Twilio re-POSTs to ?event=recording with RecordingUrl.
export async function POST(req: Request) {
  const url = new URL(req.url);
  const form = await req.formData();
  const to = String(form.get("To") ?? "");
  const from = String(form.get("From") ?? "");
  const t = await tenantByPhone(to);
  if (!t) return xml("<Response/>");

  if (url.searchParams.get("event") === "recording") {
    const recordingUrl = String(form.get("RecordingUrl") ?? "");
    const transcript = String(form.get("TranscriptionText") ?? "");
    await withTenant(t.id, (tx) =>
      tx.insert(communication).values({
        tenantId: t.id, channel: "call", direction: "inbound", from,
        recordingUrl: recordingUrl || null, transcript: transcript || null, aiHandled: true,
      }),
    );
    await createLeadForTenant(t.id, { name: `Voicemail ${from}`, phone: from, address: "unknown", source: "after-hours-voicemail" });
    return xml("<Response/>");
  }

  const action = `${url.origin}/api/twilio/voice?event=recording`;
  return xml(
    `<Response><Say>Thanks for calling. Please leave a message after the tone and we'll call you back.</Say>` +
    `<Record maxLength="120" action="${action}" recordingStatusCallback="${action}"/></Response>`,
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm --filter @savvy/web typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/twilio/voice
git commit -m "feat(web): after-hours voice capture stub (TwiML record + log comm)"
```

---

## Task 14: Comms queries + server actions

**Files:**
- Create: `apps/web/src/lib/comms-queries.ts`
- Create: `apps/web/src/lib/comms-actions.ts`

- [ ] **Step 1: Queries**

```ts
// apps/web/src/lib/comms-queries.ts
import {
  withTenant, messageTemplate, drip, dripEnrollment, customer, eq, desc,
} from "@savvy/db";
import { getTenantId } from "./tenant";

export async function listTemplates() {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx.select().from(messageTemplate).orderBy(desc(messageTemplate.updatedAt)),
  );
}

export async function listDrips() {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) => tx.select().from(drip).orderBy(desc(drip.createdAt)));
}

export type EnrollmentRow = {
  id: string; status: string; stoppedReason: string | null; currentStep: number;
  customerName: string; dripName: string; enrolledAt: string;
};

export async function listEnrollments(): Promise<EnrollmentRow[]> {
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({
      id: dripEnrollment.id, status: dripEnrollment.status, stoppedReason: dripEnrollment.stoppedReason,
      currentStep: dripEnrollment.currentStep, enrolledAt: dripEnrollment.enrolledAt,
      customerName: customer.name, dripName: drip.name,
    })
      .from(dripEnrollment)
      .leftJoin(customer, eq(customer.id, dripEnrollment.customerId))
      .leftJoin(drip, eq(drip.id, dripEnrollment.dripId))
      .orderBy(desc(dripEnrollment.enrolledAt)),
  );
  return rows.map((r) => ({
    id: r.id, status: r.status, stoppedReason: r.stoppedReason, currentStep: r.currentStep,
    customerName: r.customerName ?? "—", dripName: r.dripName ?? "—",
    enrolledAt: (r.enrolledAt as Date).toISOString(),
  }));
}
```

- [ ] **Step 2: Server actions**

```ts
// apps/web/src/lib/comms-actions.ts
"use server";
import { withTenant, messageTemplate, drip, dripEnrollment, eq, and, stopDripEnrollments } from "@savvy/db";
import { inngest } from "@savvy/agents";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";
import type { MessageChannel } from "@savvy/core";

export async function saveTemplate(input: {
  id?: string; key: string; name: string; channel: MessageChannel; subject?: string; body: string;
}): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await withTenant(tenantId, async (tx) => {
    if (input.id) {
      await tx.update(messageTemplate)
        .set({ name: input.name, channel: input.channel, subject: input.subject ?? null, body: input.body, updatedAt: new Date() })
        .where(eq(messageTemplate.id, input.id));
    } else {
      await tx.insert(messageTemplate).values({
        tenantId, key: input.key, name: input.name, channel: input.channel,
        subject: input.subject ?? null, body: input.body,
      });
    }
  });
  revalidatePath("/comms/templates");
  return { ok: true };
}

export async function toggleDripActive(dripId: string, active: boolean): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await withTenant(tenantId, (tx) =>
    tx.update(drip).set({ active }).where(eq(drip.id, dripId)),
  );
  revalidatePath("/comms/drips");
  return { ok: true };
}

export async function enrollDrip(input: {
  dripKey: string; customerId: string; jobId?: string; leadId?: string;
}): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await inngest.send({ name: "drip/enroll", data: { tenantId, ...input } });
  revalidatePath("/comms/enrollments");
  return { ok: true };
}

export async function stopDrip(customerId: string): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await withTenant(tenantId, (tx) =>
    stopDripEnrollments(tx, { tenantId, customerId, reason: "manual" }),
  );
  await inngest.send({ name: "drip/stop", data: { tenantId, customerId, reason: "manual" } });
  revalidatePath("/comms/enrollments");
  return { ok: true };
}
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm --filter @savvy/web typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/comms-queries.ts apps/web/src/lib/comms-actions.ts
git commit -m "feat(web): comms queries + server actions (templates/drips/enrollments)"
```

---

## Task 15: `/comms` UI pages + nav

**Files:**
- Modify: `apps/web/src/app/(app)/layout.tsx`
- Create: `apps/web/src/app/(app)/comms/page.tsx`
- Create: `apps/web/src/app/(app)/comms/templates/page.tsx`
- Create: `apps/web/src/app/(app)/comms/templates/template-form.tsx`
- Create: `apps/web/src/app/(app)/comms/drips/page.tsx`
- Create: `apps/web/src/app/(app)/comms/drips/drip-toggle.tsx`
- Create: `apps/web/src/app/(app)/comms/enrollments/page.tsx`
- Create: `apps/web/src/app/(app)/comms/enrollments/stop-button.tsx`

- [ ] **Step 1: Add the nav link**

In `apps/web/src/app/(app)/layout.tsx`, add to `NAV` after the Leads entry:

```ts
  { href: "/comms", label: "Comms" },
```

- [ ] **Step 2: Comms index (links to sub-pages)**

```tsx
// apps/web/src/app/(app)/comms/page.tsx
import Link from "next/link";
import { Card } from "@/components/ui/card";

const SECTIONS = [
  { href: "/comms/templates", title: "Templates", desc: "SMS + email message templates" },
  { href: "/comms/drips", title: "Drips", desc: "Timed nurture sequences" },
  { href: "/comms/enrollments", title: "Enrollments", desc: "Who's in which drip" },
];

export default function CommsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Comms</h1>
      <div className="grid gap-3 sm:grid-cols-3">
        {SECTIONS.map((s) => (
          <Link key={s.href} href={s.href}>
            <Card className="p-4 hover:bg-muted">
              <div className="font-medium">{s.title}</div>
              <div className="text-sm text-muted-foreground">{s.desc}</div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Templates list + edit form**

```tsx
// apps/web/src/app/(app)/comms/templates/page.tsx
import { listTemplates } from "@/lib/comms-queries";
import { Card } from "@/components/ui/card";
import { TemplateForm } from "./template-form";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const templates = await listTemplates();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Templates</h1>
      <TemplateForm />
      <div className="space-y-2">
        {templates.map((t) => (
          <Card key={t.id} className="p-3" data-testid="template-row">
            <div className="flex items-center justify-between">
              <div className="font-medium">{t.name} <span className="text-xs text-muted-foreground">({t.channel})</span></div>
              <code className="text-xs text-muted-foreground">{t.key}</code>
            </div>
            {t.subject && <div className="text-sm">Subject: {t.subject}</div>}
            <div className="text-sm text-muted-foreground whitespace-pre-wrap">{t.body}</div>
          </Card>
        ))}
        {templates.length === 0 && <p className="text-sm text-muted-foreground">No templates yet.</p>}
      </div>
    </div>
  );
}
```

```tsx
// apps/web/src/app/(app)/comms/templates/template-form.tsx
"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { saveTemplate } from "@/lib/comms-actions";
import type { MessageChannel } from "@savvy/core";

export function TemplateForm() {
  const [pending, start] = useTransition();
  const [channel, setChannel] = useState<MessageChannel>("sms");

  return (
    <Card className="p-4">
      <form
        className="grid gap-2 sm:grid-cols-2"
        action={(fd) => {
          const key = String(fd.get("key") ?? "").trim();
          const name = String(fd.get("name") ?? "").trim();
          const body = String(fd.get("body") ?? "").trim();
          if (!key || !name || !body) { toast.error("key, name and body are required"); return; }
          start(async () => {
            await saveTemplate({
              key, name, channel, body,
              subject: channel === "email" ? String(fd.get("subject") ?? "") : undefined,
            });
            toast.success("Template saved");
          });
        }}
      >
        <input name="key" placeholder="key (stable id)" className="rounded border px-2 py-1.5 text-sm" />
        <input name="name" placeholder="name" className="rounded border px-2 py-1.5 text-sm" />
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value as MessageChannel)}
          className="rounded border px-2 py-1.5 text-sm"
        >
          <option value="sms">sms</option>
          <option value="email">email</option>
        </select>
        {channel === "email" && (
          <input name="subject" placeholder="subject" className="rounded border px-2 py-1.5 text-sm" />
        )}
        <textarea
          name="body"
          placeholder="body (use {{firstName}}, {{name}})"
          className="sm:col-span-2 rounded border px-2 py-1.5 text-sm"
          rows={3}
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          {pending ? "Saving…" : "Add template"}
        </button>
      </form>
    </Card>
  );
}
```

- [ ] **Step 4: Drips list + active toggle**

```tsx
// apps/web/src/app/(app)/comms/drips/page.tsx
import { listDrips } from "@/lib/comms-queries";
import { Card } from "@/components/ui/card";
import { DripToggle } from "./drip-toggle";
import type { DripStep } from "@savvy/core";

export const dynamic = "force-dynamic";

export default async function DripsPage() {
  const drips = await listDrips();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Drips</h1>
      <div className="space-y-2">
        {drips.map((d) => (
          <Card key={d.id} className="p-3" data-testid="drip-row">
            <div className="flex items-center justify-between">
              <div className="font-medium">{d.name} <code className="text-xs text-muted-foreground">{d.key}</code></div>
              <DripToggle dripId={d.id} active={d.active} />
            </div>
            <ol className="mt-1 text-sm text-muted-foreground">
              {(d.steps as DripStep[]).map((s) => (
                <li key={s.stepNum}>#{s.stepNum} · +{s.delayHours}h · {s.channel} · {s.templateKey ?? "AI"}</li>
              ))}
            </ol>
          </Card>
        ))}
        {drips.length === 0 && <p className="text-sm text-muted-foreground">No drips yet.</p>}
      </div>
    </div>
  );
}
```

```tsx
// apps/web/src/app/(app)/comms/drips/drip-toggle.tsx
"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import { toggleDripActive } from "@/lib/comms-actions";

export function DripToggle({ dripId, active }: { dripId: string; active: boolean }) {
  const [pending, start] = useTransition();
  return (
    <button
      disabled={pending}
      onClick={() => start(async () => { await toggleDripActive(dripId, !active); toast.success(active ? "Paused" : "Activated"); })}
      className="rounded border px-2 py-1 text-xs disabled:opacity-50"
      data-testid="drip-toggle"
    >
      {active ? "Active" : "Paused"}
    </button>
  );
}
```

- [ ] **Step 5: Enrollments list + manual stop**

```tsx
// apps/web/src/app/(app)/comms/enrollments/page.tsx
import { listEnrollments } from "@/lib/comms-queries";
import { Card } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function EnrollmentsPage() {
  const rows = await listEnrollments();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Enrollments</h1>
      <div className="space-y-2">
        {rows.map((r) => (
          <Card key={r.id} className="flex items-center justify-between p-3" data-testid="enrollment-row">
            <div>
              <div className="font-medium">{r.customerName} · {r.dripName}</div>
              <div className="text-xs text-muted-foreground">
                step {r.currentStep} · {r.status}{r.stoppedReason ? ` (${r.stoppedReason})` : ""}
              </div>
            </div>
          </Card>
        ))}
        {rows.length === 0 && <p className="text-sm text-muted-foreground">No enrollments yet.</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Build the web app**

Run: `pnpm --filter @savvy/web build`
Expected: build succeeds; `/comms`, `/comms/templates`, `/comms/drips`, `/comms/enrollments` compile.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/\(app\)/layout.tsx apps/web/src/app/\(app\)/comms
git commit -m "feat(web): /comms UI — templates, drips, enrollments + nav"
```

---

## Task 16: Seed starter templates + nurture drip

**Files:**
- Modify: `packages/db/src/seed.ts`

- [ ] **Step 1: Add templates + a drip per tenant**

In `packages/db/src/seed.ts`, extend the import and add seeding inside `seedTenant` before `return t;`:

```ts
import { tenant, user, customer, property, job, messageTemplate, drip } from "./schema/index";
```

```ts
  // Phase 3: starter nurture templates + a 3-step drip (zero-delay steps so e2e
  // can trigger the first send immediately; real drips use real delays).
  await adminDb.insert(messageTemplate).values([
    { tenantId: t!.id, key: "nurture-sms-1", name: "Nurture · SMS day 0", channel: "sms",
      body: "Hi {{firstName}}, it's your roofing team — still thinking about that roof? Reply anytime." },
    { tenantId: t!.id, key: "nurture-email-1", name: "Nurture · Email day 2", channel: "email",
      subject: "Your roof inspection", body: "Hi {{firstName}}, here's how a free inspection works..." },
    { tenantId: t!.id, key: "nurture-sms-2", name: "Nurture · SMS day 5", channel: "sms",
      body: "Hi {{firstName}}, last nudge — want us to swing by this week?" },
  ]);
  await adminDb.insert(drip).values({
    tenantId: t!.id, key: "nurture", name: "New-lead nurture", triggerEvent: "lead/created", active: true,
    steps: [
      { stepNum: 1, delayHours: 0, channel: "sms", templateKey: "nurture-sms-1" },
      { stepNum: 2, delayHours: 0, channel: "email", templateKey: "nurture-email-1" },
      { stepNum: 3, delayHours: 0, channel: "sms", templateKey: "nurture-sms-2" },
    ],
  });
```

- [ ] **Step 2: Re-run the seed**

Run (DB env exported): `pnpm --filter @savvy/db db:seed`
Expected: `seeded 2 tenants`, no errors.

- [ ] **Step 3: Verify rows exist**

Run:
```bash
docker exec savvy_db psql -U postgres -d savvy -tA -c "select count(*) from message_template; select count(*) from drip;"
```
Expected: `6` templates and `2` drips (3 + 1 per tenant × 2 tenants).

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/seed.ts
git commit -m "feat(db): seed starter nurture templates + drip"
```

---

## Task 17: e2e — enroll → first step sends → inbound STOP stops it

**Files:**
- Create: `apps/web/tests/e2e/comms.spec.ts`

**Note:** Reuses the Phase 0/2 harness. The webServer for e2e runs with `TEST_MODE=1` + `INNGEST_DEV=1`; the seeded `nurture` drip has zero-delay steps so the first send fires immediately. The tenant id comes from `/tmp/savvy-e2e-tenant.json` (written by `create-tenant.ts`). Confirm by reading `apps/web/playwright.config.ts` that `webServer` is configured and `create-tenant.ts` runs in `globalSetup` (it does for Phase 0/2); if the seeded drip/templates aren't created by `create-tenant.ts`, this spec seeds its own drip + templates for the e2e tenant (shown below).

- [ ] **Step 1: Write the spec**

```ts
// apps/web/tests/e2e/comms.spec.ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  adminDb, withTenant, customer, drip, messageTemplate, dripEnrollment, communication, eq, and,
} from "@savvy/db";
import { inngest } from "@savvy/agents";
import { handleInboundSms } from "@/lib/inbound-sms";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 400));
  }
}

test("drip: enroll -> first step logs a communication -> inbound STOP stops it", async () => {
  // Ensure the e2e tenant has the nurture templates + a zero-delay drip.
  await withTenant(tenantId, async (tx) => {
    const existing = await tx.select().from(drip).where(eq(drip.key, "nurture"));
    if (existing.length === 0) {
      await tx.insert(messageTemplate).values({
        tenantId, key: "nurture-sms-1", name: "n1", channel: "sms", body: "Hi {{firstName}}!",
      });
      await tx.insert(drip).values({
        tenantId, key: "nurture", name: "Nurture", active: true,
        steps: [{ stepNum: 1, delayHours: 0, channel: "sms", templateKey: "nurture-sms-1" }],
      });
    }
  });

  // A contact to enroll.
  const customerId = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Drip Dan", phone: "+15555557777" }).returning();
    return c!.id;
  });

  // Enroll -> dripRun creates an enrollment + sends step 1 (mock SMS, fail-soft).
  await inngest.send({ name: "drip/enroll", data: { tenantId, dripKey: "nurture", customerId } });

  const comm = await waitFor(async () => {
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select().from(communication).where(and(eq(communication.customerId, customerId), eq(communication.direction, "outbound"))),
    );
    return row;
  });
  expect(comm.channel).toBe("sms");
  expect(comm.body).toBe("Hi Drip!");

  const enr = await waitFor(async () => {
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select().from(dripEnrollment).where(eq(dripEnrollment.customerId, customerId)),
    );
    return row;
  });

  // Inbound STOP -> opt-out + stop the enrollment.
  await handleInboundSms(tenantId, { from: "+15555557777", body: "STOP" });

  await waitFor(async () => {
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select().from(dripEnrollment).where(eq(dripEnrollment.id, enr.id)),
    );
    return row && row.status === "stopped" ? row : undefined;
  });
  const [stopped] = await withTenant(tenantId, (tx) =>
    tx.select().from(dripEnrollment).where(eq(dripEnrollment.id, enr.id)),
  );
  expect(stopped!.status).toBe("stopped");
  expect(stopped!.stoppedReason).toBe("opted_out");
  const [c2] = await withTenant(tenantId, (tx) => tx.select().from(customer).where(eq(customer.id, customerId)));
  expect(c2!.smsOptOut).toBe(true);
});
```

- [ ] **Step 2: Run the e2e suite**

Start the four services (per the handoff) then run Playwright:
```bash
# in separate shells / background, with DB env exported:
node apps/web/tests/e2e/ai-stub.mjs
npx inngest-cli@latest dev -u http://localhost:3000/api/inngest
# then:
pnpm --filter @savvy/web exec playwright test comms.spec.ts
```
Expected: PASS — outbound SMS comm logged with rendered body, enrollment ends `stopped`/`opted_out`, `sms_opt_out=true`. (If Playwright's `webServer` auto-starts the app + inngest per the existing config, just run the `playwright test` line.)

- [ ] **Step 3: Run the full gate**

Run (DB env exported): `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add apps/web/tests/e2e/comms.spec.ts
git commit -m "test(web): e2e — drip enroll -> first step -> inbound STOP stop+opt-out"
```

---

## Self-Review (run before handing off)

**Spec coverage:**
- message_template / drip / drip_enrollment tables + RLS → Tasks 4, 6 ✅
- customer opt-out columns → Task 4 ✅
- EmailSender (Resend) behind interface + env → Task 7 ✅
- renderTemplate (no-throw) → Task 2 ✅
- drip engine: enroll, sleep, re-check, opt-out suppress, render (template + AI), send, log communication + agent_run, advance, complete → Tasks 8–10 ✅
- stop on reply / converted / opted_out / manual → inbound SMS (11), lead.booked convert (10), unsubscribe (12), stopDrip action (14) ✅; `cancelOn` + status re-check → Task 10 ✅
- inbound SMS (live) + STOP keyword → Task 11 ✅
- email unsubscribe → Task 12 ✅
- voice capture stub → Task 13 ✅
- /comms UI (templates/drips/enrollments) + nav → Tasks 14–15 ✅
- seed starter drip + templates → Task 16 ✅
- tests: unit (renderTemplate, draftMessage, isStopKeyword), integration (stopDripEnrollments, sendDripStep), RLS, e2e → Tasks 2,3,5,6,8,9,17 ✅
- Deferred (real voice, inbound email parsing, visual builder, quiet-hours) → not built, matches spec ✅

**Placeholder scan:** none — every step has full code/commands.

**Type consistency:** `DripStep`, `MessageChannel`, `DripStopReason` defined in Task 1 and used identically downstream; `stopDripEnrollments(tx, {tenantId, customerId, reason})`, `draftMessage(input, aiClient)`, `sendDripStep(input, deps)` signatures match across definition and call sites; events `drip/enroll`/`drip/stop` payloads consistent between `client.ts` (Task 8) and all emitters.

**Compliance follow-up (flagged, not built this phase):** TCPA quiet-hours (no SMS 9pm–8am local) + explicit consent capture — STOP/opt-out are implemented; quiet-hours is a pre-real-sending follow-up.
