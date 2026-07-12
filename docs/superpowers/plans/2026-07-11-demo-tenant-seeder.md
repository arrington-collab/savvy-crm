# Demo Tenant + Full-Pipeline Seeder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a demo tenant "Demo Roofing (Savvy)" with one realistic job at every pipeline stage, seeded through the real lifecycle functions, and hard-mute all outbound comms for demo tenants so zero real provider calls occur.

**Architecture:** Three sequenced parts in one PR. Part 1 (product code, TDD): add a `tenant.demo` flag and a comms kill switch that returns mock senders (writing mock `communication` rows) for demo tenants — built and proven FIRST. Part 2: an idempotent `seed-demo-tenant` script that provisions via the real runbook and drives leads/jobs up the funnel through `recordStageChange`'s evidence gates. Part 3: a post-seed health sweep, a Playwright board test, and a supervised prod run.

**Tech Stack:** TypeScript, Drizzle ORM, Postgres (Supabase prod / local docker), Vitest, Playwright, pnpm + Turborepo. Lifecycle in `packages/db/src/lifecycle`, comms resolvers in `packages/agents/src`, provider primitives in `packages/integrations/src`.

## Global Constraints

- Tenant isolation on every query; tenant-scoped writes go through `withTenant(tenantId, tx => …)` (RLS `savvy_app` role). `adminDb` (superuser, bypasses RLS) only for tenant/user/license rows and post-hoc aging, mirroring the existing runbook.
- Never insert `job.stage` directly — only `recordStageChange` writes stage + `job_stage_event`, and only after evidence exists.
- All AI/provider calls go through the gateway/primitives; no hard-coded provider strings in feature code.
- Every feature ships with tests; `pnpm typecheck` + `pnpm lint` clean before commit.
- Demo tenant timezone: `America/Phoenix`. Tenant name: exactly `Demo Roofing (Savvy)`. AZ ROC license.
- Provider primitives that must NEVER be called for `demo=true`: Twilio `client.messages.create` (`twilio.ts:35`), RingCentral POST (`ringcentral.ts:43`), Resend `fetch → api.resend.com` (`email.ts:12`), Vapi `fetch → api.vapi.ai` (`vapi.ts:21`/`:53`).
- Sender interfaces (exact): `SmsSender.sendSms({to,from,body,statusCallback?}): Promise<{sid:string}>`; `EmailSender.sendEmail({to,from,subject,html}): Promise<{id:string}>`; `VoiceGateway.placeOutboundCall({toPhone,assistantOverrides,metadata}): Promise<{callId:string}>`.
- `communication` columns used by mocks: `tenantId, jobId?, customerId?, channel('call'|'sms'|'email'), direction('outbound'), to, from, body, twilioSid, deliveryStatus, dedupeKey`.

---

## File Structure

**Part 1 — kill switch (product code):**
- `packages/db/src/schema/tenancy.ts` — add `demo` column to `tenant`.
- `packages/db/migrations/NNNN_tenant_demo.sql` — generated migration.
- `packages/db/src/lifecycle/demo-tenant.ts` (new) — `isDemoTenant(tenantId)` (admin read, cached).
- `packages/agents/src/mock-comms.ts` (new) — `makeMockSms/Email/Voice(tenantId)` writing mock `communication` rows.
- `packages/agents/src/telephony.ts` — demo branch in `getTenantSms` / `getTenantVoice`.
- `packages/agents/src/email.ts` (new) — `getTenantEmail(tenantId, {gmailConnectionId})`.
- ~15 send sites in `packages/agents/src/functions/*` + `break-glass.ts` + `ops-digest.ts` — migrate `getEmailSender(...)` → `getTenantEmail(tenantId, …)`.
- `packages/agents/src/mock-comms.test.ts`, `packages/agents/src/demo-mute.invariant.test.ts` (new).

**Part 2 — seeder:**
- `packages/db/src/scripts/seed-demo-tenant.ts` (new) — CLI entry (create/refresh + `--reset` + `--sweep`).
- `packages/db/src/lifecycle/demo-seed/` (new dir):
  - `config.ts` — the demo dataset (tenant, staff, leads, jobs) as data.
  - `funnel.ts` — reusable helpers that drive a lead up the funnel through the gates.
  - `leads.ts`, `jobs.ts`, `flavor.ts` — per-group seeders.
  - `reset.ts` — FK-safe teardown.
- `packages/db/src/lifecycle/demo-seed/*.test.ts`.

**Part 3:**
- `apps/web/tests/e2e/demo-tenant.spec.ts` (new) — a card in every pipeline column.
- Prod run: documented steps (no code).

---

# PART 1 — `tenant.demo` flag + comms demo-mute (BUILD FIRST)

### Task 1: Add `tenant.demo` column + migration

**Files:**
- Modify: `packages/db/src/schema/tenancy.ts:9-31`
- Create: `packages/db/migrations/NNNN_tenant_demo.sql` (generated)
- Test: `packages/db/tests/tenant-demo-column.test.ts`

**Interfaces:**
- Produces: `tenant.demo` boolean column (default false, not null).

- [ ] **Step 1: Write the failing test**

Create `packages/db/tests/tenant-demo-column.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { tenant } from "../src/schema/tenancy";
import { ensureTenantForOrg } from "../src/lifecycle/provisioning";

describe("tenant.demo column", () => {
  it("defaults to false and round-trips true", async () => {
    const t = await ensureTenantForOrg({ clerkOrgId: `org_demo_col_${Date.now()}`, name: "Col Test" });
    const [before] = await adminDb.select({ demo: tenant.demo }).from(tenant).where(eq(tenant.id, t.id));
    expect(before?.demo).toBe(false);
    await adminDb.update(tenant).set({ demo: true }).where(eq(tenant.id, t.id));
    const [after] = await adminDb.select({ demo: tenant.demo }).from(tenant).where(eq(tenant.id, t.id));
    expect(after?.demo).toBe(true);
    await adminDb.delete(tenant).where(eq(tenant.id, t.id));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db test tenant-demo-column`
Expected: FAIL — `tenant.demo` does not exist (TS error / column missing).

- [ ] **Step 3: Add the column to the schema**

In `packages/db/src/schema/tenancy.ts`, add to the `tenant` table (after `telephonyMode`, before `timezone`):

```ts
  // Demo tenants: comms are hard-muted (see agents/mock-comms). Never a real customer.
  demo: boolean("demo").notNull().default(false),
```

Add `boolean` to the imports on line 1: `import { pgTable, uuid, text, jsonb, index, timestamp, uniqueIndex, doublePrecision, boolean } from "drizzle-orm/pg-core";`

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter @savvy/db db:generate`
Expected: a new `packages/db/migrations/NNNN_*.sql` adding `ALTER TABLE "tenant" ADD COLUMN "demo" boolean DEFAULT false NOT NULL;`. Rename the file's suffix to `_tenant_demo.sql` if the generator used a random name (keep the numeric prefix).

- [ ] **Step 5: Apply migration locally + run test**

Run: `pnpm --filter @savvy/db db:migrate && pnpm --filter @savvy/db test tenant-demo-column`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/tenancy.ts packages/db/migrations packages/db/tests/tenant-demo-column.test.ts
git commit -m "feat(db): add tenant.demo flag for comms kill switch"
```

---

### Task 2: `isDemoTenant` helper

**Files:**
- Create: `packages/db/src/lifecycle/demo-tenant.ts`
- Modify: `packages/db/src/index.ts` (export it)
- Test: `packages/db/tests/is-demo-tenant.test.ts`

**Interfaces:**
- Produces: `isDemoTenant(tenantId: string): Promise<boolean>` — reads `tenant.demo` via `adminDb`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/tests/is-demo-tenant.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { tenant } from "../src/schema/tenancy";
import { ensureTenantForOrg } from "../src/lifecycle/provisioning";
import { isDemoTenant } from "../src/lifecycle/demo-tenant";

describe("isDemoTenant", () => {
  it("is false for a normal tenant, true after flagging", async () => {
    const t = await ensureTenantForOrg({ clerkOrgId: `org_isdemo_${Date.now()}`, name: "Is Demo" });
    expect(await isDemoTenant(t.id)).toBe(false);
    await adminDb.update(tenant).set({ demo: true }).where(eq(tenant.id, t.id));
    expect(await isDemoTenant(t.id)).toBe(true);
    await adminDb.delete(tenant).where(eq(tenant.id, t.id));
  });

  it("is false for an unknown tenant id", async () => {
    expect(await isDemoTenant("00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db test is-demo-tenant`
Expected: FAIL — module `demo-tenant` not found.

- [ ] **Step 3: Implement**

Create `packages/db/src/lifecycle/demo-tenant.ts`:

```ts
import { eq } from "drizzle-orm";
import { adminDb } from "../admin-client";
import { tenant } from "../schema/tenancy";

// Short-lived cache: comms resolvers call this on every send; a demo flag never
// changes mid-process. Cleared implicitly by process restart (seeder is a script).
const cache = new Map<string, boolean>();

/** True when the tenant is flagged demo=true (comms hard-muted). Fail-safe: on any
 *  error returns false so a DB hiccup never silently mutes a real tenant's comms. */
export async function isDemoTenant(tenantId: string): Promise<boolean> {
  const hit = cache.get(tenantId);
  if (hit !== undefined) return hit;
  try {
    const [row] = await adminDb.select({ demo: tenant.demo }).from(tenant).where(eq(tenant.id, tenantId));
    const val = row?.demo ?? false;
    cache.set(tenantId, val);
    return val;
  } catch {
    return false;
  }
}

/** Test hook: clear the memoized flags. */
export function __clearDemoTenantCache(): void {
  cache.clear();
}
```

Add to `packages/db/src/index.ts`:

```ts
export { isDemoTenant, __clearDemoTenantCache } from "./lifecycle/demo-tenant";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db test is-demo-tenant`
Expected: PASS. (If the second sub-test flakes because of the cache from the first, call `__clearDemoTenantCache()` in a `beforeEach`.)

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/demo-tenant.ts packages/db/src/index.ts packages/db/tests/is-demo-tenant.test.ts
git commit -m "feat(db): isDemoTenant helper (cached admin read)"
```

---

### Task 3: Mock senders that log mock `communication` rows

**Files:**
- Create: `packages/agents/src/mock-comms.ts`
- Test: `packages/agents/src/mock-comms.test.ts`

**Interfaces:**
- Consumes: `SmsSender`, `EmailSender`, `VoiceGateway` (from `@savvy/integrations`); `withTenant`, `communication` (from `@savvy/db`).
- Produces:
  - `makeMockSms(tenantId: string): SmsSender`
  - `makeMockEmail(tenantId: string): EmailSender`
  - `makeMockVoice(tenantId: string): VoiceGateway`
  - Each writes a `communication` row `{channel, direction:'outbound', to, from, body, deliveryStatus:'mock', twilioSid:'mock:<uuid>'}` and returns a `mock:<uuid>` id.

- [ ] **Step 1: Write the failing test**

Create `packages/agents/src/mock-comms.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb, withTenant } from "@savvy/db";
import { tenant } from "@savvy/db/schema"; // if not exported, import from "@savvy/db" barrel used elsewhere
import { communication } from "@savvy/db/schema";
import { ensureTenantForOrg } from "@savvy/db";
import { makeMockSms, makeMockEmail, makeMockVoice } from "./mock-comms";

let tenantId: string;
beforeEach(async () => {
  const t = await ensureTenantForOrg({ clerkOrgId: `org_mock_${Date.now()}_${Math.floor(performance.now())}`, name: "Mock Co" });
  tenantId = t.id;
});

describe("mock senders", () => {
  it("mock SMS writes a mock communication row and returns a mock sid", async () => {
    const res = await makeMockSms(tenantId).sendSms({ to: "+16025550100", from: "+16025550111", body: "hi" });
    expect(res.sid).toMatch(/^mock:/);
    const rows = await adminDb.select().from(communication)
      .where(and(eq(communication.tenantId, tenantId), eq(communication.channel, "sms")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveryStatus).toBe("mock");
    expect(rows[0]!.direction).toBe("outbound");
    expect(rows[0]!.body).toBe("hi");
  });

  it("mock email writes a mock communication row (channel=email)", async () => {
    const res = await makeMockEmail(tenantId).sendEmail({ to: "a@b.com", from: "me@x.com", subject: "S", html: "<p>x</p>" });
    expect(res.id).toMatch(/^mock:/);
    const rows = await adminDb.select().from(communication)
      .where(and(eq(communication.tenantId, tenantId), eq(communication.channel, "email")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveryStatus).toBe("mock");
    expect(rows[0]!.body).toContain("S");
  });

  it("mock voice writes a call row and returns a mock callId", async () => {
    const res = await makeMockVoice(tenantId).placeOutboundCall({ toPhone: "+16025550100", assistantOverrides: {} as never, metadata: {} });
    expect(res.callId).toMatch(/^mock:/);
    const rows = await adminDb.select().from(communication)
      .where(and(eq(communication.tenantId, tenantId), eq(communication.channel, "call")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveryStatus).toBe("mock");
  });
});
```

> NOTE for the implementer: confirm the correct import path for `communication`/`tenant`/`withTenant`/`ensureTenantForOrg`. Grep an existing agents test (e.g. `packages/agents/src/functions/*.test.ts`) for how it imports `communication` and `withTenant` and mirror it exactly. Adjust the two import lines above to match.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/agents test mock-comms`
Expected: FAIL — `mock-comms` module not found.

- [ ] **Step 3: Implement**

Create `packages/agents/src/mock-comms.ts`:

```ts
import { randomUUID } from "node:crypto";
import { withTenant } from "@savvy/db";
import { communication } from "@savvy/db/schema"; // match the path your test resolved
import type { SmsSender, EmailSender, VoiceGateway } from "@savvy/integrations";

async function logMock(
  tenantId: string,
  row: { channel: "sms" | "email" | "call"; to: string | null; from: string | null; body: string | null },
): Promise<string> {
  const id = `mock:${randomUUID()}`;
  await withTenant(tenantId, (tx) =>
    tx.insert(communication).values({
      tenantId,
      channel: row.channel,
      direction: "outbound",
      to: row.to,
      from: row.from,
      body: row.body,
      twilioSid: id,
      deliveryStatus: "mock",
    }),
  );
  return id;
}

/** SMS sender for demo tenants: logs a mock communication row, never hits a provider. */
export function makeMockSms(tenantId: string): SmsSender {
  return {
    async sendSms({ to, from, body }) {
      const sid = await logMock(tenantId, { channel: "sms", to, from, body });
      return { sid };
    },
  };
}

/** Email sender for demo tenants: logs a mock row (subject+html collapsed into body). */
export function makeMockEmail(tenantId: string): EmailSender {
  return {
    async sendEmail({ to, from, subject, html }) {
      const id = await logMock(tenantId, { channel: "email", to, from, body: `${subject}\n${html}` });
      return { id };
    },
  };
}

/** Voice gateway for demo tenants: logs a mock call row, never dials. */
export function makeMockVoice(tenantId: string): VoiceGateway {
  return {
    async placeOutboundCall({ toPhone }) {
      const callId = await logMock(tenantId, { channel: "call", to: toPhone, from: null, body: null });
      return { callId };
    },
  };
}
```

> If `VoiceGateway.placeOutboundCall`'s return type isn't `{callId}`, read `packages/integrations/src/vapi.ts:3-13` and return the exact shape it declares.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/agents test mock-comms`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/mock-comms.ts packages/agents/src/mock-comms.test.ts
git commit -m "feat(agents): mock comms senders that log mock-delivery rows"
```

---

### Task 4: Demo branch in `getTenantSms` / `getTenantVoice`

**Files:**
- Modify: `packages/agents/src/telephony.ts:37-49` (`getTenantSms`), `:102-111` (`getTenantVoice`)
- Test: `packages/agents/src/telephony-demo.test.ts`

**Interfaces:**
- Consumes: `isDemoTenant` (Task 2), `makeMockSms`/`makeMockVoice` (Task 3).
- Produces: `getTenantSms(demoTenantId)` returns `{ sender: mock, from: 'mock' }`; `getTenantVoice(demoTenantId)` returns the mock gateway — WITHOUT calling `resolve` (so no telephony creds are needed for a demo tenant).

- [ ] **Step 1: Write the failing test**

Create `packages/agents/src/telephony-demo.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, ensureTenantForOrg } from "@savvy/db";
import { tenant } from "@savvy/db/schema";
import { getTenantSms, getTenantVoice } from "./telephony";

describe("demo tenants bypass provider resolution", () => {
  it("getTenantSms returns a mock sender for demo tenants without resolving creds", async () => {
    const t = await ensureTenantForOrg({ clerkOrgId: `org_tsms_${Date.now()}`, name: "TSMS" });
    await adminDb.update(tenant).set({ demo: true }).where(eq(tenant.id, t.id));
    // Pass a resolve that throws — proving it is never called for demo tenants.
    const deps = { resolve: async () => { throw new Error("must not resolve for demo"); }, platformSms: { sendSms: async () => ({ sid: "x" }) }, platformFrom: () => "+1" } as never;
    const { sender } = await getTenantSms(t.id, deps);
    const res = await sender.sendSms({ to: "+16025550100", from: "+1", body: "hi" });
    expect(res.sid).toMatch(/^mock:/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/agents test telephony-demo`
Expected: FAIL — resolve throws (demo branch not yet added).

- [ ] **Step 3: Implement**

In `packages/agents/src/telephony.ts`, add imports at top:

```ts
import { isDemoTenant } from "@savvy/db";
import { makeMockSms, makeMockVoice } from "./mock-comms";
```

At the very start of `getTenantSms` (before `const r = await deps.resolve(...)`):

```ts
  if (await isDemoTenant(tenantId)) {
    return { sender: makeMockSms(tenantId), from: "mock" };
  }
```

At the very start of `getTenantVoice` (before `const r = await deps.resolve(...)`):

```ts
  if (await isDemoTenant(tenantId)) {
    return makeMockVoice(tenantId);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/agents test telephony-demo`
Expected: PASS.

- [ ] **Step 5: Run the existing telephony suite (no regressions)**

Run: `pnpm --filter @savvy/agents test telephony`
Expected: PASS (existing non-demo tests still resolve normally).

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/telephony.ts packages/agents/src/telephony-demo.test.ts
git commit -m "feat(agents): demo-mute SMS + voice resolvers"
```

---

### Task 5: `getTenantEmail` + migrate all email send sites

**Files:**
- Create: `packages/agents/src/email.ts`
- Modify (migrate `getEmailSender(...)` → `getTenantEmail(tenantId, …)`): `packages/agents/src/functions/lead-intake.ts`, `lead-cadence.ts`, `appointment-reminders.ts`, `homeowner-notify.ts`, `homeowner-crew-notify.ts`, `homeowner-delivery-notify.ts`, `weather-reschedule.ts`, `retail-cadence.ts`, `dunning.ts`, `supplier-invoice-guard.ts`, `canvass-contract.ts`, `drip.ts` (its production wiring at `:205-208`), `packages/agents/src/break-glass.ts`, `packages/agents/src/ops-digest.ts`.
- Test: `packages/agents/src/email-demo.test.ts`

**Interfaces:**
- Consumes: `isDemoTenant` (Task 2), `makeMockEmail` (Task 3), `getEmailSender` (from `@savvy/integrations`).
- Produces: `getTenantEmail(tenantId: string, opts: { gmailConnectionId?: string | null }): Promise<EmailSender>` — mock for demo tenants, else `getEmailSender(opts)`.

- [ ] **Step 1: Write the failing test**

Create `packages/agents/src/email-demo.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, ensureTenantForOrg } from "@savvy/db";
import { tenant } from "@savvy/db/schema";
import { getTenantEmail } from "./email";

describe("getTenantEmail", () => {
  it("returns a mock email sender for demo tenants", async () => {
    const t = await ensureTenantForOrg({ clerkOrgId: `org_tmail_${Date.now()}`, name: "TMail" });
    await adminDb.update(tenant).set({ demo: true }).where(eq(tenant.id, t.id));
    const sender = await getTenantEmail(t.id, { gmailConnectionId: null });
    const res = await sender.sendEmail({ to: "a@b.com", from: "me@x.com", subject: "S", html: "<p>x</p>" });
    expect(res.id).toMatch(/^mock:/);
  });

  it("returns the real resend sender for non-demo tenants", async () => {
    const t = await ensureTenantForOrg({ clerkOrgId: `org_tmail2_${Date.now()}`, name: "TMail2" });
    const sender = await getTenantEmail(t.id, { gmailConnectionId: null });
    // Real resend sender's id is NOT prefixed mock:. We don't send (no key); just assert identity by shape.
    expect(typeof sender.sendEmail).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/agents test email-demo`
Expected: FAIL — `./email` not found.

- [ ] **Step 3: Implement `getTenantEmail`**

Create `packages/agents/src/email.ts`:

```ts
import { isDemoTenant } from "@savvy/db";
import { getEmailSender, type EmailSender } from "@savvy/integrations";
import { makeMockEmail } from "./mock-comms";

/** Tenant-aware email resolver mirroring getTenantSms. Demo tenants get a mock
 *  sender (logs a mock communication row, never hits Resend/Gmail). */
export async function getTenantEmail(
  tenantId: string,
  opts: { gmailConnectionId?: string | null },
): Promise<EmailSender> {
  if (await isDemoTenant(tenantId)) return makeMockEmail(tenantId);
  return getEmailSender(opts);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/agents test email-demo`
Expected: PASS.

- [ ] **Step 5: Migrate each email send site**

For EACH file listed under **Files → Modify**, replace the direct `getEmailSender({ gmailConnectionId: … })` construction with `await getTenantEmail(tenantId, { gmailConnectionId: … })`, threading the `tenantId` already in scope (every Inngest fn has it; `break-glass`/`ops-digest` resolve it before the send). Example — `dunning.ts:127`:

Before:
```ts
await getEmailSender({ gmailConnectionId: setup.gmailConnectionId }).sendEmail({ … });
```
After:
```ts
const emailSender = await getTenantEmail(tenantId, { gmailConnectionId: setup.gmailConnectionId });
await emailSender.sendEmail({ … });
```

And `drip.ts:205-208` production wiring — change `email: getEmailSender({ gmailConnectionId: setup.gmailConnectionId })` to `email: await getTenantEmail(tenantId, { gmailConnectionId: setup.gmailConnectionId })`.

For `canvass-contract.ts:234` and `supplier-invoice-guard.ts` where the sender is passed via `deps.email`, resolve it with `getTenantEmail(tenantId, …)` at the production call site that builds `deps`. Remove now-unused `getEmailSender` imports where fully replaced. Add `import { getTenantEmail } from "../email";` (adjust relative depth: `../email` from `functions/`, `./email` from `break-glass.ts`/`ops-digest.ts`).

- [ ] **Step 6: Typecheck + run the full agents suite**

Run: `pnpm --filter @savvy/agents typecheck && pnpm --filter @savvy/agents test`
Expected: PASS. Fix any site where `tenantId` isn't in scope by resolving it from the event/setup already loaded there.

- [ ] **Step 7: Commit**

```bash
git add packages/agents/src/email.ts packages/agents/src/email-demo.test.ts packages/agents/src/functions packages/agents/src/break-glass.ts packages/agents/src/ops-digest.ts
git commit -m "feat(agents): getTenantEmail + migrate all email sites to demo-mute chokepoint"
```

---

### Task 6: Red-path invariant — zero provider calls for demo tenants

**Files:**
- Create: `packages/agents/src/demo-mute.invariant.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: the guardrail test — the invariant `comms.demo_mute`.

- [ ] **Step 1: Write the invariant test**

Create `packages/agents/src/demo-mute.invariant.test.ts`. It provisions a demo tenant, spies on the three provider primitives at their HTTP boundary, drives each channel through the real resolvers, and asserts zero provider calls + mock rows. Plus a negative control for SMS.

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb, ensureTenantForOrg, __clearDemoTenantCache } from "@savvy/db";
import { tenant, communication } from "@savvy/db/schema";
import { getTenantSms, getTenantVoice } from "./telephony";
import { getTenantEmail } from "./email";

let demoId: string;
let realId: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  __clearDemoTenantCache();
  const d = await ensureTenantForOrg({ clerkOrgId: `org_inv_demo_${Date.now()}`, name: "Inv Demo" });
  demoId = d.id;
  await adminDb.update(tenant).set({ demo: true }).where(eq(tenant.id, demoId));
  const r = await ensureTenantForOrg({ clerkOrgId: `org_inv_real_${Date.now()}`, name: "Inv Real" });
  realId = r.id;
  // Spy on global fetch — Resend + Vapi + RingCentral all go through it.
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => { fetchSpy.mockRestore(); __clearDemoTenantCache(); });

describe("comms.demo_mute invariant", () => {
  it("SMS/email/voice for a demo tenant hit NO provider and log mock rows", async () => {
    const { sender } = await getTenantSms(demoId);
    await sender.sendSms({ to: "+16025550100", from: "mock", body: "sms" });
    const email = await getTenantEmail(demoId, { gmailConnectionId: null });
    await email.sendEmail({ to: "a@b.com", from: "me@x.com", subject: "e", html: "<p>e</p>" });
    const voice = await getTenantVoice(demoId);
    await voice.placeOutboundCall({ toPhone: "+16025550100", assistantOverrides: {} as never, metadata: {} });

    // Zero provider HTTP calls to any known provider host.
    const providerCalls = fetchSpy.mock.calls.filter(([url]) => {
      const u = String(url);
      return u.includes("api.resend.com") || u.includes("api.vapi.ai") || u.includes("platform.ringcentral") || u.includes("twilio.com");
    });
    expect(providerCalls).toHaveLength(0);

    // Three mock rows logged.
    const rows = await adminDb.select().from(communication)
      .where(and(eq(communication.tenantId, demoId), eq(communication.deliveryStatus, "mock")));
    expect(rows.map((r) => r.channel).sort()).toEqual(["call", "email", "sms"]);
  });

  it("negative control: a non-demo tenant resolves a real (platform) sender", async () => {
    const { sender, from } = await getTenantSms(realId);
    // Real path returns the platform sender + a real 'from' (not the literal 'mock').
    expect(from).not.toBe("mock");
    expect(typeof sender.sendSms).toBe("function");
  });
});
```

> Twilio's SDK may not route through `globalThis.fetch`. Since a demo tenant has NO twilio creds, `getTenantSms` returns the mock before any Twilio client is constructed — so the SMS assertion holds structurally. If you want a Twilio-specific spy, additionally `vi.mock("twilio")` and assert the constructor/`messages.create` is never called; optional but stronger.

- [ ] **Step 2: Run the invariant test**

Run: `pnpm --filter @savvy/agents test demo-mute.invariant`
Expected: PASS (2 tests).

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/demo-mute.invariant.test.ts
git commit -m "test(agents): comms.demo_mute red-path invariant — zero provider calls"
```

---

# PART 2 — The seeder

### Task 7: Seeder scaffold — provision demo tenant + staff + pnpm script

**Files:**
- Create: `packages/db/src/lifecycle/demo-seed/config.ts`, `packages/db/src/scripts/seed-demo-tenant.ts`
- Modify: `packages/db/package.json` (add `db:seed:demo` script)
- Test: `packages/db/tests/demo-seed-provision.test.ts`

**Interfaces:**
- Consumes: `provisionTenant`, `ensureUser`, `adminDb`, `tenant`.
- Produces:
  - `DEMO = { clerkOrgId, name, timezone, owner, staff[], … }` (the dataset) in `config.ts`.
  - `provisionDemoTenant(): Promise<{ tenantId: string }>` — provisions + sets `demo:true` + `stripeAccountId:'acct_demo'` + ensures staff. Idempotent.

- [ ] **Step 1: Write the failing test**

Create `packages/db/tests/demo-seed-provision.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { tenant, user } from "../src/schema/tenancy";
import { provisionDemoTenant } from "../src/lifecycle/demo-seed/config";

describe("provisionDemoTenant", () => {
  it("creates a demo tenant with acct_demo stripe + 5 users, idempotently", async () => {
    const { tenantId } = await provisionDemoTenant();
    const again = await provisionDemoTenant();
    expect(again.tenantId).toBe(tenantId); // idempotent

    const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
    expect(t?.demo).toBe(true);
    expect(t?.stripeAccountId).toBe("acct_demo");
    expect(t?.timezone).toBe("America/Phoenix");
    expect(t?.name).toBe("Demo Roofing (Savvy)");

    const users = await adminDb.select().from(user).where(eq(user.tenantId, tenantId));
    // owner + office + 2 reps + crew = 5
    expect(users.length).toBeGreaterThanOrEqual(5);
    expect(users.filter((u) => u.role === "rep")).toHaveLength(2);
    expect(users.some((u) => u.role === "office")).toBe(true);
    expect(users.some((u) => u.role === "crew")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db test demo-seed-provision`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `config.ts`**

Create `packages/db/src/lifecycle/demo-seed/config.ts`:

```ts
import { eq } from "drizzle-orm";
import { adminDb } from "../../admin-client";
import { tenant } from "../../schema/tenancy";
import { provisionTenant } from "../provision-runbook";
import { ensureUser } from "../provisioning";

// Deterministic synthetic Clerk ids so re-runs reconcile. The OWNER's clerkOrgId /
// clerkUserId are overridable via env for the real prod org (so the owner can switch
// to it). Defaults are demo sentinels usable locally.
export const DEMO_CLERK_ORG_ID = process.env.DEMO_CLERK_ORG_ID ?? "org_demo_savvy";
export const DEMO_OWNER_CLERK_ID = process.env.DEMO_OWNER_CLERK_ID ?? "usr_demo_owner";
export const DEMO_OWNER_EMAIL = process.env.DEMO_OWNER_EMAIL ?? "owner@demo-roofing.test";

export const DEMO_TENANT_NAME = "Demo Roofing (Savvy)";

export const DEMO_STAFF = [
  { clerkUserId: "usr_demo_office", name: "Olivia Office", email: "olivia@demo-roofing.test", role: "office" as const },
  { clerkUserId: "usr_demo_repA", name: "Rick RepA", email: "rick@demo-roofing.test", role: "rep" as const },
  { clerkUserId: "usr_demo_repB", name: "Rita RepB", email: "rita@demo-roofing.test", role: "rep" as const },
  { clerkUserId: "usr_demo_crew", name: "Carlos Crew", email: "carlos@demo-roofing.test", role: "crew" as const },
];

export async function provisionDemoTenant(): Promise<{ tenantId: string }> {
  const res = await provisionTenant(
    {
      name: DEMO_TENANT_NAME,
      clerkOrgId: DEMO_CLERK_ORG_ID,
      timezone: "America/Phoenix",
      owner: { clerkUserId: DEMO_OWNER_CLERK_ID, name: "Demo Owner", email: DEMO_OWNER_EMAIL },
      licenses: [{ state: "AZ", authority: "ROC", licenseNumber: "ROC-DEMO-0001" }],
    },
    {},
    { dryRun: false },
  );
  const tenantId = res.tenantId;
  // Flag demo + sentinel stripe account (lets the invoice lifecycle run with NO live Stripe call).
  await adminDb.update(tenant).set({ demo: true, stripeAccountId: "acct_demo" }).where(eq(tenant.id, tenantId));
  for (const s of DEMO_STAFF) {
    await ensureUser({ tenantId, clerkUserId: s.clerkUserId, name: s.name, email: s.email, role: s.role });
  }
  return { tenantId };
}
```

- [ ] **Step 4: Add pnpm script + minimal CLI**

Create `packages/db/src/scripts/seed-demo-tenant.ts`:

```ts
import { adminPool } from "../admin-client";
import { provisionDemoTenant } from "../lifecycle/demo-seed/config";

async function main() {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");
  console.log(reset ? "RESET demo tenant" : "SEED demo tenant");
  const { tenantId } = await provisionDemoTenant();
  console.log(`demo tenant ${tenantId} provisioned (${process.env.DATABASE_URL?.split("@")[1] ?? "local"})`);
  // Reset + full dataset + sweep are wired in later tasks (8–13).
}

main().then(async () => { await adminPool.end(); process.exit(0); })
  .catch(async (e) => { console.error(e); await adminPool.end().catch(() => {}); process.exit(1); });
```

Add to `packages/db/package.json` scripts:
```json
"db:seed:demo": "tsx src/scripts/seed-demo-tenant.ts"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @savvy/db test demo-seed-provision`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/demo-seed/config.ts packages/db/src/scripts/seed-demo-tenant.ts packages/db/package.json packages/db/tests/demo-seed-provision.test.ts
git commit -m "feat(db): demo tenant provisioning + seed-demo-tenant CLI scaffold"
```

---

### Task 8: Funnel helpers — drive a lead up through the evidence gates

This is the reusable core the per-stage seeders build on. It creates a lead, books+completes an inspection, saves a DIY sketch measurement, drafts+sends+accepts an estimate, and returns the resulting job id — each step landing the real evidence `recordStageChange` requires.

**Files:**
- Create: `packages/db/src/lifecycle/demo-seed/funnel.ts`
- Test: `packages/db/tests/demo-seed-funnel.test.ts`

**Interfaces:**
- Consumes: `createLeadForTenant`, `bookLeadSlot`/`bookAppointment`, `setAppointmentStatus`, `saveSketchMeasurement`, `draftLeadEstimateIfReady`, `setEstimateStatus`, `advanceJobForAcceptedEstimate`, `recordStageChange`, `gatherStageEvidence`.
- Produces:
  - `seedLeadToInspected(tenantId, input): Promise<{ leadId, jobId? }>` — through `inspected` evidence (no job yet; job appears at approval).
  - `seedLeadToEstimateSent(tenantId, input): Promise<{ leadId, estimateId }>`.
  - `seedApprovedJob(tenantId, input): Promise<{ jobId }>` — accepts the estimate → job at `approved`.
  - `DemoLeadInput = { name; phone; email; address; assigneeUserId; sketch?: RoofSketch }`.

> IMPLEMENTER: before writing, open each consumed function and copy its EXACT signature (params object shape). The map in the design spec (§ "Lifecycle") lists file:line for each. Build the helpers to match. Below is the intended shape; adjust param names to the real ones.

- [ ] **Step 1: Write the failing test** (`packages/db/tests/demo-seed-funnel.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { job } from "../src/schema/jobs";
import { provisionDemoTenant } from "../src/lifecycle/demo-seed/config";
import { seedApprovedJob } from "../src/lifecycle/demo-seed/funnel";
import { demoStaff } from "../src/lifecycle/demo-seed/funnel"; // helper to fetch a rep id

describe("funnel: lead → approved job through the gates", () => {
  it("produces a job whose stage is at least 'approved' with real evidence", async () => {
    const { tenantId } = await provisionDemoTenant();
    const repId = await demoStaff(tenantId, "usr_demo_repA");
    const { jobId } = await seedApprovedJob(tenantId, {
      name: "Approved Homeowner", phone: "+16025550201", email: "approved@demo.test",
      address: "101 W Camelback Rd, Phoenix, AZ 85013", assigneeUserId: repId,
    });
    const [j] = await adminDb.select().from(job).where(eq(job.id, jobId));
    // 'approved' is index >= its ordinal; assert not stuck at lead/estimate.
    expect(["approved", "production", "closeout", "billing", "complete"]).toContain(j!.stage);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db test demo-seed-funnel`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `funnel.ts`**

Implement the helpers to call the real lifecycle functions in order. Skeleton (fill param shapes from the real signatures):

```ts
import { and, eq } from "drizzle-orm";
import { adminDb } from "../../admin-client";
import { user } from "../../schema/tenancy";
import { createLeadForTenant } from "../../../.."; // ← import from the app/lib path or a db re-export; see NOTE
import { bookLeadSlot } from "../booking";
import { setAppointmentStatus } from "../appointments";
import { saveSketchMeasurement } from "../measurement";
import { draftLeadEstimateIfReady, setEstimateStatus } from "../estimate";
import { advanceJobForAcceptedEstimate } from "@savvy/agents"; // if exported; else replicate its accept+convert calls
import { squareSketch } from "./sketch-fixture";

export interface DemoLeadInput {
  name: string; phone: string; email: string; address: string; assigneeUserId: string;
}

/** Resolve a demo staff user id by its deterministic clerk id. */
export async function demoStaff(tenantId: string, clerkUserId: string): Promise<string> {
  const [u] = await adminDb.select({ id: user.id }).from(user)
    .where(and(eq(user.tenantId, tenantId), eq(user.clerkUserId, clerkUserId)));
  if (!u) throw new Error(`demo staff ${clerkUserId} not found — run provisionDemoTenant first`);
  return u.id;
}

export async function seedLeadToEstimateSent(tenantId: string, input: DemoLeadInput) {
  const leadId = await createLeadForTenant(tenantId, {/* map name/phone/email/address/source:'web' */});
  const appt = await bookLeadSlot({ leadId, startsAt: /* Thu */, endsAt: /* +2h */ });
  await setAppointmentStatus({ tenantId, appointmentId: appt.id, status: "done" });
  await saveSketchMeasurement({ tenantId, scope: { kind: "lead", id: leadId }, sketch: squareSketch() });
  await draftLeadEstimateIfReady({ tenantId, leadId });
  // find the draft estimate id for this lead, then:
  const estimateId = /* select estimate where leadId */;
  await setEstimateStatus({ tenantId, estimateId, status: "sent" });
  return { leadId, estimateId };
}

export async function seedApprovedJob(tenantId: string, input: DemoLeadInput) {
  const { estimateId } = await seedLeadToEstimateSent(tenantId, input);
  await advanceJobForAcceptedEstimate(tenantId, estimateId); // accepts → convertLeadToJob → approved
  const jobId = /* select job.id where the accepted estimate's jobId */;
  return { jobId };
}
```

Also create `packages/db/src/lifecycle/demo-seed/sketch-fixture.ts` with a minimal valid `RoofSketch` (`squareSketch()`) that passes `roofSketchSchema` — copy the shape from an existing sketch test fixture (grep `roofSketchSchema` in tests).

> NOTE on `createLeadForTenant`: it lives in `apps/web/src/lib/intake.ts` (the web app), not `packages/db`. Two options: (a) move the pure intake logic into a `packages/db` lifecycle fn and have the web lib call it (cleaner, but larger); (b) replicate its exact insert sequence (`customer`/`property` dedupe + `lead` insert + `instantiateLeadTasks`) inside a new `packages/db/src/lifecycle/lead-intake.ts` used by both. Prefer (a) if the intake body is small; otherwise (b). Decide during Step 3 and keep the web route calling the shared fn so there is ONE intake path.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db test demo-seed-funnel`
Expected: PASS. If `recordStageChange`/conversion throws a gate error, print the thrown `missingEvidenceFor` message and add the missing evidence step — do NOT force the stage.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/demo-seed/funnel.ts packages/db/src/lifecycle/demo-seed/sketch-fixture.ts packages/db/tests/demo-seed-funnel.test.ts
git commit -m "feat(db): demo-seed funnel helpers (lead → approved through gates)"
```

---

### Task 9: The 5 leads

**Files:**
- Create: `packages/db/src/lifecycle/demo-seed/leads.ts`
- Test: `packages/db/tests/demo-seed-leads.test.ts`

**Interfaces:**
- Consumes: `createLeadForTenant`, `markLeadContacted`, `bookLeadSlot`, `setLeadLost`, `addLeadNote`, `adminDb`.
- Produces: `seedDemoLeads(tenantId): Promise<{ new, contacted, qualified, booked, lost: string }>` (lead ids by state).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { lead } from "../src/schema/crm";
import { provisionDemoTenant } from "../src/lifecycle/demo-seed/config";
import { seedDemoLeads } from "../src/lifecycle/demo-seed/leads";

describe("seedDemoLeads", () => {
  it("creates one lead in each of new/contacted/qualified/booked/lost", async () => {
    const { tenantId } = await provisionDemoTenant();
    const ids = await seedDemoLeads(tenantId);
    const rows = await adminDb.select().from(lead).where(eq(lead.tenantId, tenantId));
    const byStatus = new Map(rows.map((r) => [r.id, r.status]));
    expect(byStatus.get(ids.new)).toBe("new");
    expect(byStatus.get(ids.contacted)).toBe("contacted");
    expect(byStatus.get(ids.qualified)).toBe("qualified");
    expect(byStatus.get(ids.booked)).toBe("booked");
    expect(byStatus.get(ids.lost)).toBe("lost");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db test demo-seed-leads`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `leads.ts`**

Each lead via `createLeadForTenant`. Then:
- `new`: leave as-is (`status:'new'`, no enrichment).
- `contacted`: `markLeadContacted(tx, {tenantId, leadId})` + `adminDb.update(lead).set({status:'contacted'})` (the marker sets `firstRepContactAt` only) + start a drip enrollment row so "drip active" shows (grep how drip enrollments are created; if via an Inngest event only, insert the `drip`/enrollment row directly via adminDb with `status:'active'`).
- `qualified`: `adminDb.update(lead).set({status:'qualified', score: 82})` (no gate fn; set directly).
- `booked`: `bookLeadSlot({leadId, startsAt: nextThursday9am(), endsAt: +2h})` + `adminDb.update(lead).set({status:'booked'})`.
- `lost`: `setLeadLost(tx, {tenantId, leadId})` + `addLeadNote(tx, {tenantId, leadId, body:'Lost — went with another contractor (price).'})`.

Use deterministic phones/emails/addresses (Phoenix) so re-runs dedupe on the natural key. Return the ids.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db test demo-seed-leads`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/demo-seed/leads.ts packages/db/tests/demo-seed-leads.test.ts
git commit -m "feat(db): seed 5 demo leads (new/contacted/qualified/booked/lost)"
```

---

### Task 10: Jobs per stage (inspected → complete) + evidence

**Files:**
- Create: `packages/db/src/lifecycle/demo-seed/jobs.ts`
- Test: `packages/db/tests/demo-seed-jobs.test.ts`

**Interfaces:**
- Consumes: Task 8 funnel helpers + `createInvoice`/`createInvoiceFromEstimate`, `sendInvoice`, `recordStripePayment`, `draftDepreciationInvoice`, `bookAppointment(type:'crew')`, material-order + document + photo inserts, `recordStageChange`, `recomputeJobActualCost`, homeowner status token signer.
- Produces: `seedStageJobs(tenantId): Promise<Record<'inspected'|'estimate'|'approved'|'production'|'billing'|'complete', string>>` (job/lead id per stage).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { job } from "../src/schema/jobs";
import { provisionDemoTenant } from "../src/lifecycle/demo-seed/config";
import { seedStageJobs } from "../src/lifecycle/demo-seed/jobs";

describe("seedStageJobs", () => {
  it("lands one job at each of approved/production/billing/complete", async () => {
    const { tenantId } = await provisionDemoTenant();
    const ids = await seedStageJobs(tenantId);
    const jobIds = [ids.approved, ids.production, ids.billing, ids.complete];
    const rows = await adminDb.select().from(job).where(inArray(job.id, jobIds));
    const stage = new Map(rows.map((r) => [r.id, r.stage]));
    expect(stage.get(ids.approved)).toBe("approved");
    expect(stage.get(ids.production)).toBe("production");
    expect(stage.get(ids.billing)).toBe("billing");
    expect(stage.get(ids.complete)).toBe("complete");
  });
});
```

(`inspected`/`estimate` are lead-stage — assert those in Task 8's lead/estimate helpers or add rows-count checks; the job table starts at `approved`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db test demo-seed-jobs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `jobs.ts`** — one function per stage, each building on `seedApprovedJob` then adding evidence and advancing:

- `inspected`: `seedLeadToInspected` (from Task 8) — lead-stage, no job.
- `estimate`: `seedLeadToEstimateSent` — lead-stage estimate sent.
- `approved`: `seedApprovedJob` + deposit invoice (`createInvoice` → `sendInvoice`) + a `material_order` (`status:'ordered'`) + supplier quotes + `recomputeJobActualCost` (landed cost).
- `production`: `seedApprovedJob`, then `bookAppointment({type:'crew', jobId, assigneeUserId:crew, crewId?, startsAt, endsAt})`, a material-delivered event (`material_order.status:'delivered'`), 2–3 photo `document` rows, ONE open punch `job_task` left `pending`, a homeowner status token; then `recordStageChange(tx,{tenantId,jobId,toStage:'production'})`. Assert it doesn't throw.
- `billing`: `seedApprovedJob`, add crew appt + photos (production evidence), then `createInvoiceFromEstimate` → `sendInvoice` (final), `recordStripePayment` PARTIAL (e.g. half), then `recordStageChange(toStage:'billing')`.
- `complete`: `seedApprovedJob` + production photos + final invoice + `recordStripePayment` FULL (→ paid) + warranty/review task rows (insert the two `job_task`/catalog rows), then `recordStageChange(toStage:'complete')` (needs production photos — supplied).

For the SEPARATE 50-day receivable, add to `billing`: a second invoice with `createdAt`/`dueAt` backdated 50 days (via adminDb) left `status:'overdue'`.

Every `recordStageChange` runs inside `withTenant(tenantId, tx => …)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db test demo-seed-jobs`
Expected: PASS. Any gate throw → read `missingEvidenceFor` and add the missing evidence, never force the stage.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/demo-seed/jobs.ts packages/db/tests/demo-seed-jobs.test.ts
git commit -m "feat(db): seed one job per pipeline stage with real evidence"
```

---

### Task 11: Flavor jobs — insurance, canvass, stuck, manual-hatch

**Files:**
- Create: `packages/db/src/lifecycle/demo-seed/flavor.ts`
- Test: `packages/db/tests/demo-seed-flavor.test.ts`

**Interfaces:**
- Consumes: `attachClaim`/`upsertClaim`, `draftDepreciationInvoice`, `convertCanvassContractToJob`, `convertLeadToJob({manualJob:true})`, funnel helpers, document inserts, adminDb backdating.
- Produces: `seedFlavorJobs(tenantId): Promise<{ insurance, canvass, stuck, manual: string }>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { job } from "../src/schema/jobs";
import { claim } from "../src/schema/insurance";
import { provisionDemoTenant } from "../src/lifecycle/demo-seed/config";
import { seedFlavorJobs } from "../src/lifecycle/demo-seed/flavor";

describe("seedFlavorJobs", () => {
  it("insurance job has a claim ledger with acv/rcv/deductible", async () => {
    const { tenantId } = await provisionDemoTenant();
    const ids = await seedFlavorJobs(tenantId);
    const [c] = await adminDb.select().from(claim).where(eq(claim.jobId, ids.insurance));
    expect(c?.acvCents).toBeGreaterThan(0);
    expect(c?.rcvCents).toBeGreaterThan(c!.acvCents!);
    expect(c?.deductibleCents).toBeGreaterThan(0);
  });

  it("canvass job carries a rescission hold in the future", async () => {
    const { tenantId } = await provisionDemoTenant();
    const ids = await seedFlavorJobs(tenantId);
    const [j] = await adminDb.select().from(job).where(eq(job.id, ids.canvass));
    expect(j?.rescissionHoldUntil).toBeTruthy();
  });
});
```

> Confirm the claim table's `jobId` column name and that `claim` is exported from `../src/schema/insurance`. Adjust if needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db test demo-seed-flavor`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `flavor.ts`:**

- `insurance`: `seedApprovedJob` (type insurance), then `attachClaim`/`upsertClaim({tenantId, jobId, carrierName:'Demo Mutual', claimNumber:'CLM-DEMO-1', acvCents: 1_450_000, rcvCents: 1_820_000, deductibleCents: 250_000, status:'approved'})`, `draftDepreciationInvoice({tenantId, jobId})` (pending), + an insurance-estimate `document` row (kind `insurance_estimate`, fake `r2Key`). No supplement content.
- `canvass`: build a signed-canvass-contract fixture and call `convertCanvassContractToJob(input)` so `rescissionHoldUntil` + `canvassRepName` are stamped and a contract `document` is stored. Ensure the hold is in the future (recent signature date).
- `stuck`: `seedLeadToEstimateSent`, then backdate the estimate's `sentAt`/`createdAt` to 12 days ago (adminDb). Owned by Rep B (`assigneeUserId` = repB). It stays a lead-stage sent estimate with no response → surfaces in the exception/Today queue.
- `manual`: create a lead, then `convertLeadToJob({tenantId, leadId, manualJob:true, reason:'Owner hatch — walk-in cash job', resolutions:{…}})` + a contract `document` on the job.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db test demo-seed-flavor`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/demo-seed/flavor.ts packages/db/tests/demo-seed-flavor.test.ts
git commit -m "feat(db): seed flavor jobs (insurance/canvass/stuck/manual-hatch)"
```

---

### Task 12: `--reset` teardown + full-run wiring + `--sweep`

**Files:**
- Create: `packages/db/src/lifecycle/demo-seed/reset.ts`
- Modify: `packages/db/src/scripts/seed-demo-tenant.ts` (wire leads+jobs+flavor+reset+sweep)
- Test: `packages/db/tests/demo-seed-reset.test.ts`

**Interfaces:**
- Consumes: all Part-2 seeders; `recomputeTaskHealth`/`taskHealthSweep`.
- Produces:
  - `resetDemoTenant(tenantId, opts?: { hard?: boolean }): Promise<void>` — deletes all tenant-scoped rows FK-safe (children→parents); `hard` also deletes staff + tenant.
  - `seedDemoTenant(): Promise<{ tenantId; summary }>` — provision → leads → jobs → flavor → sweep; idempotent.

- [ ] **Step 1: Write the failing test** (idempotency + reset)

```ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { job } from "../src/schema/jobs";
import { lead } from "../src/schema/crm";
import { seedDemoTenant, resetDemoTenant } from "../src/lifecycle/demo-seed/reset";

describe("seedDemoTenant idempotency + reset", () => {
  it("running twice yields the same job/lead counts (no dupes)", async () => {
    const first = await seedDemoTenant();
    const jobs1 = await adminDb.select().from(job).where(eq(job.tenantId, first.tenantId));
    const second = await seedDemoTenant();
    expect(second.tenantId).toBe(first.tenantId);
    const jobs2 = await adminDb.select().from(job).where(eq(job.tenantId, first.tenantId));
    expect(jobs2.length).toBe(jobs1.length);
  });

  it("reset removes pipeline data but keeps the tenant", async () => {
    const { tenantId } = await seedDemoTenant();
    await resetDemoTenant(tenantId);
    const leads = await adminDb.select().from(lead).where(eq(lead.tenantId, tenantId));
    expect(leads).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db test demo-seed-reset`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `reset.ts`** — `seedDemoTenant()` composes `provisionDemoTenant` → `seedDemoLeads` → `seedStageJobs` → `seedFlavorJobs` → `recomputeTaskHealth(tenantId)`. `resetDemoTenant()` deletes tenant-scoped rows in FK order (payment → invoice → job_task → job_checklist_item → job_stage_event → communication → appointment → measurement → estimate → document → claim → material_order → drip → lead_task → lead → job → property → customer). Discover the full child-table set by grepping `tenantId` columns; a missed table just leaves orphans that the next reset cleans — but aim complete. Guard: `resetDemoTenant` refuses unless `tenant.demo === true`.

Wire the CLI: `--reset` → `resetDemoTenant`; default → `seedDemoTenant`; both print a per-stage summary. Add a guard that refuses to seed if the resolved tenant exists and is NOT demo.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db test demo-seed-reset`
Expected: PASS.

- [ ] **Step 5: Full local smoke**

Run: `pnpm --filter @savvy/db db:seed:demo`
Expected: prints provisioned tenant id + a per-stage summary, exits 0. Then `pnpm --filter @savvy/db db:seed:demo -- --reset` clears it.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/demo-seed/reset.ts packages/db/src/scripts/seed-demo-tenant.ts packages/db/tests/demo-seed-reset.test.ts
git commit -m "feat(db): seedDemoTenant orchestration + --reset teardown + health sweep"
```

---

# PART 3 — e2e + verification

### Task 13: Playwright — a card in every pipeline column

**Files:**
- Create: `apps/web/tests/e2e/demo-tenant.spec.ts`

**Interfaces:**
- Consumes: `seedDemoTenant` (seed in a global-setup or test hook against the e2e DB); the repo's existing Clerk e2e stub.

- [ ] **Step 1: Write the test** — seed the demo tenant, load the pipeline board scoped to it, assert each column (lead/inspected/estimate/approved/production/closeout/billing/complete) has ≥1 card. Mirror an existing board e2e (grep `tests/e2e` for the pipeline/board spec) for auth + navigation + the column selectors. Example skeleton:

```ts
import { test, expect } from "@playwright/test";
import { seedDemoTenant } from "@savvy/db"; // export seedDemoTenant from the db barrel for the e2e harness

test.beforeAll(async () => { await seedDemoTenant(); });

test("demo tenant renders a card in every pipeline column", async ({ page }) => {
  await page.goto("/pipeline"); // adjust to the real board route
  for (const col of ["Inspected", "Estimate", "Approved", "Production", "Billing", "Complete"]) {
    const column = page.getByTestId(`pipeline-column-${col.toLowerCase()}`); // adjust selector to reality
    await expect(column.getByTestId("job-card").first()).toBeVisible();
  }
});
```

> Adjust route + selectors to the actual board component (grep `apps/web/src/app` for the pipeline page and its `data-testid`s). If the board is org-scoped via Clerk, ensure the e2e stub's active org maps to the demo tenant (set `DEMO_CLERK_ORG_ID` to the stub's org id in the e2e env).

- [ ] **Step 2: Run it**

Run: `pnpm --filter web test:e2e demo-tenant` (use the repo's real e2e command — check `apps/web/package.json`).
Expected: PASS. Per memory, ensure no stale dev server on :3000 (kill it first).

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/e2e/demo-tenant.spec.ts
git commit -m "test(web): demo tenant renders a card in every pipeline column"
```

---

### Task 14: Full verification + PR

- [ ] **Step 1: Whole-repo gates**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green. Fix anything the email-site migration disturbed.

- [ ] **Step 2: Local end-to-end walk**

`pnpm --filter @savvy/db db:seed:demo`, then run the app locally (`pnpm dev`), switch to "Demo Roofing (Savvy)", and walk LEAD → PAID. Confirm every column occupied and each card's ledger/timeline/docs populated; confirm Today shows the stuck exception + the 50-day receivable; confirm the demo tenant's comms timeline shows mock rows (deliveryStatus mock).

- [ ] **Step 3: Open the PR**

```bash
git push -u origin demo-seeder
gh pr create --title "feat(demo): demo tenant + full-pipeline seeder + comms kill switch" --body "<see below>"
```

PR body MUST include: the per-stage inventory of what was created, the org name to switch to (**Demo Roofing (Savvy)**), the demo-mute invariant summary, and a "Prod verification" section (filled in Step 5).

- [ ] **Step 4: CI green** — `gh pr checks demo-seeder --watch` before merge (per repo convention).

- [ ] **Step 5: Supervised prod run** (with the owner)

1. Owner creates a Clerk Organization "Demo Roofing (Savvy)" and adds themselves as owner; note its `org_…` id and the owner `user_…` id.
2. Confirm correct Supabase `DATABASE_URL`/`DATABASE_ADMIN_URL` (memory: `.env.prod.secrets.local` currently points at the wrong Neon DB — do NOT trust it blindly).
3. Apply the `tenant.demo` migration to prod Supabase via MCP `apply_migration` (reconcile the migration number to prod's sequence — local drizzle numbering is one behind).
4. From this worktree, with prod creds + `DEMO_CLERK_ORG_ID`/`DEMO_OWNER_CLERK_ID`/`DEMO_OWNER_EMAIL` set to the real org/owner: `pnpm --filter @savvy/db db:seed:demo`.
5. Switch to the demo org on prod, walk LEAD → PAID, confirm every column + ledgers/timeline/docs.
6. Record the prod state (screenshots / row counts, org name) in the PR "Prod verification" section.

---

## Self-Review

**Spec coverage:**
- Demo tenant via real runbook + `demo=true` → Tasks 1, 7. ✅
- Comms hard-mute + red-path invariant, built FIRST → Tasks 1–6. ✅
- Idempotent seeder + `--reset` → Tasks 7, 12. ✅
- 5 leads (new/contacted/qualified/booked/lost + reason) → Task 9. ✅
- Jobs per stage with real evidence → Tasks 8, 10. ✅
- Insurance / canvass / stuck / manual-hatch → Task 11. ✅
- Health sweep after seed → Task 12. ✅
- Playwright board + demo-mute red-path → Tasks 13 (board), 6 (invariant, vitest per approved design). ✅
- Prod-runnable + supervised prod walk → Task 14. ✅
- Demo staff (office, 2 reps incl. stuck owner, crew; no `language`) → Tasks 7, 11. ✅

**Deviations (approved in the design):** insurance via claim lifecycle not live AI parse; single real estimate (no good/better/best tiers); Spanish crew skipped; warranty/review as task rows; lost reason as `lead_note`; sentinel `stripeAccountId`.

**Placeholder scan:** The funnel/jobs/flavor tasks intentionally reference real lifecycle signatures the implementer must copy verbatim from the file:line map in the design spec (§ Lifecycle) — each such spot names the exact function and its source location. No `TODO`/`TBD`.

**Type consistency:** `isDemoTenant`, `makeMockSms/Email/Voice`, `getTenantEmail`, `seedDemoTenant`, `resetDemoTenant`, `provisionDemoTenant`, `seedApprovedJob` names are used consistently across tasks.
