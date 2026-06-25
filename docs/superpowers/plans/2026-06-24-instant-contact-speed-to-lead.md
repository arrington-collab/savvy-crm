# Phase C — Instant Contact + Speed-to-Lead + Cadence + Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Acknowledge a new lead in <60s (SMS+email), run a 3-minute rep-contact clock that escalates (and emits a voice-agent hook), and run a compliant multi-touch cadence until the lead is contacted or disqualified — so every lead reaches exactly one terminal state.

**Architecture:** Three Inngest workflows fan out from `lead/created` — the enhanced intake ack, a `lead-speed-to-lead` timer, and a `lead-cadence` drip — all torn down by a `lead/contacted` (or `lead/disqualified`) cancel event. Contact is recorded in a new `lead.first_rep_contact_at` (rep action OR inbound reply). Pure config/gating logic lives in `@savvy/core`; sends honor consent + opt-out + (for proactive touches) tenant-timezone quiet-hours.

**Tech Stack:** TypeScript, Zod v3, Drizzle ORM, Next.js server actions, Inngest (durable timers + `cancelOn`), Vitest, pnpm + Turborepo. Worktree `~/Sites/savvy-phasec`, branch `feat/instant-contact`.

## Global Constraints

- **Deterministic** timers/triggers; the only LLM is an optional copy personalization that **fails open to the rendered template** and never delays/blocks a send.
- **Ack bypasses quiet-hours** (transactional reply to the lead's own submission); **cadence honors quiet-hours** (tenant tz, default 21:00–08:00).
- **Consent + opt-out on every proactive send:** SMS requires `customer.sms_consent_at` set AND `!smsOptOut`; email requires `!emailOptOut`.
- **Consent rule:** a web/API submission with a phone = TCPA prior express consent → set `customer.sms_consent_at` at intake.
- **`lead/contacted` cancels BOTH** the speed-to-lead timer and the cadence; **`lead/disqualified`** cancels the cadence.
- **SLA defaults:** 3-min first-touch, 10-min escalate. **Cadence defaults:** Day 0×2, 1, 3, 5, 7, 14.
- Tenant isolation on every query; config in `tenant.settings.speedToLead` + `tenant.settings.leadCadence` jsonb; tenant tz from `parseFinanceConfig(settings.finance).timezone`; migration ships `.sql` + drizzle meta together; no secrets.

**Local gate commands** (repo root `~/Sites/savvy-phasec`):
- `cd packages/core && npx vitest run` — pure unit tests
- `pnpm typecheck` · `pnpm lint`
- DB/workflow tests are **CI-gated**.

---

### Task 1: Follow-up config + send-gating (`@savvy/core`)

**Files:**
- Create: `packages/core/src/lead-followup.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/lead-followup.test.ts`

**Interfaces:**
- Produces: `type SpeedToLeadConfig`, `type CadenceTouch`, `type LeadCadenceConfig`; `parseSpeedToLeadConfig(raw)`, `parseLeadCadenceConfig(raw)`, `shouldSendChannel(channel, c)`, `DEFAULT_CADENCE`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/lead-followup.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseSpeedToLeadConfig, parseLeadCadenceConfig, shouldSendChannel } from "./lead-followup";

describe("parseSpeedToLeadConfig", () => {
  it("defaults to 3 and 10 minutes", () => {
    expect(parseSpeedToLeadConfig({})).toEqual({ firstTouchSlaMin: 3, escalateMin: 10 });
  });
  it("accepts overrides", () => {
    expect(parseSpeedToLeadConfig({ firstTouchSlaMin: 5 }).firstTouchSlaMin).toBe(5);
  });
});

describe("parseLeadCadenceConfig", () => {
  it("defaults to Day 0×2,1,3,5,7,14 and 21–08 quiet hours", () => {
    const c = parseLeadCadenceConfig({});
    expect(c.steps.map((s) => s.dayOffset)).toEqual([0, 0, 1, 3, 5, 7, 14]);
    expect(c.quietHours).toEqual({ startHour: 21, endHour: 8 });
  });
});

describe("shouldSendChannel", () => {
  const base = { smsOptOut: false, emailOptOut: false, smsConsentAt: new Date() };
  it("sends SMS only with consent and no opt-out", () => {
    expect(shouldSendChannel("sms", base)).toBe(true);
    expect(shouldSendChannel("sms", { ...base, smsOptOut: true })).toBe(false);
    expect(shouldSendChannel("sms", { ...base, smsConsentAt: null })).toBe(false);
  });
  it("sends email unless opted out", () => {
    expect(shouldSendChannel("email", base)).toBe(true);
    expect(shouldSendChannel("email", { ...base, emailOptOut: true })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run src/lead-followup.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/core/src/lead-followup.ts`:

```ts
import { z } from "./schemas";

export type SpeedToLeadConfig = { firstTouchSlaMin: number; escalateMin: number };
export type CadenceTouch = { dayOffset: number; hourOffset: number; channel: "sms" | "email" };
export type LeadCadenceConfig = { steps: CadenceTouch[]; quietHours: { startHour: number; endHour: number } };

export const DEFAULT_CADENCE: CadenceTouch[] = [
  { dayOffset: 0, hourOffset: 0, channel: "sms" },
  { dayOffset: 0, hourOffset: 4, channel: "email" },
  { dayOffset: 1, hourOffset: 0, channel: "sms" },
  { dayOffset: 3, hourOffset: 0, channel: "email" },
  { dayOffset: 5, hourOffset: 0, channel: "sms" },
  { dayOffset: 7, hourOffset: 0, channel: "email" },
  { dayOffset: 14, hourOffset: 0, channel: "sms" },
];

const speedSchema = z.object({
  firstTouchSlaMin: z.number().positive().default(3),
  escalateMin: z.number().positive().default(10),
});
export function parseSpeedToLeadConfig(raw: unknown): SpeedToLeadConfig {
  return speedSchema.parse(raw ?? {});
}

const touchSchema = z.object({
  dayOffset: z.number().int().min(0),
  hourOffset: z.number().int().min(0).default(0),
  channel: z.enum(["sms", "email"]),
});
const cadenceSchema = z.object({
  steps: z.array(touchSchema).default([...DEFAULT_CADENCE]),
  quietHours: z.object({ startHour: z.number().int(), endHour: z.number().int() }).default({ startHour: 21, endHour: 8 }),
});
export function parseLeadCadenceConfig(raw: unknown): LeadCadenceConfig {
  const p = cadenceSchema.parse(raw ?? {});
  return { steps: p.steps.length ? p.steps : [...DEFAULT_CADENCE], quietHours: p.quietHours };
}

// Consent + opt-out gate for a proactive send. SMS needs recorded consent; email needs only no-opt-out.
export function shouldSendChannel(
  channel: "sms" | "email",
  c: { smsOptOut: boolean; emailOptOut: boolean; smsConsentAt: Date | null },
): boolean {
  if (channel === "sms") return !c.smsOptOut && c.smsConsentAt != null;
  return !c.emailOptOut;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && npx vitest run src/lead-followup.test.ts`
Expected: PASS.

- [ ] **Step 5: Export + commit**

Add `export * from "./lead-followup";` to `packages/core/src/index.ts`.
```bash
git add packages/core/src/lead-followup.ts packages/core/src/lead-followup.test.ts packages/core/src/index.ts
git commit -m "feat(core): speed-to-lead + cadence config + send-channel gating"
```

---

### Task 2: Reassignee picker (`@savvy/core`)

**Files:**
- Modify: `packages/core/src/pick-assignee.ts`
- Test: `packages/core/src/pick-assignee.test.ts` (append)

**Interfaces:**
- Consumes: `AssignmentCandidate` (existing).
- Produces: `pickReassignee(candidates, currentOwnerId): string | null`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/pick-assignee.test.ts`:

```ts
import { pickReassignee } from "./pick-assignee";

describe("pickReassignee", () => {
  const c = (userId: string, lastAssignedAt: string | null = null) => ({ userId, openLeadCount: 0, lastAssignedAt });
  it("excludes the current owner and picks the least-recently-assigned other", () => {
    const cands = [c("owner", "2026-01-01"), c("a", "2026-02-01"), c("b", null)];
    expect(pickReassignee(cands, "owner")).toBe("b"); // null = never assigned = oldest
  });
  it("returns null when no other candidate exists", () => {
    expect(pickReassignee([c("owner")], "owner")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run src/pick-assignee.test.ts`
Expected: FAIL — `pickReassignee` not exported.

- [ ] **Step 3: Implement**

In `packages/core/src/pick-assignee.ts`, append (reuses the file-private `roundRobin`/`ts`):

```ts
// Pick a DIFFERENT owner for SLA escalation: least-recently-assigned among the others.
export function pickReassignee(candidates: AssignmentCandidate[], currentOwnerId: string | null): string | null {
  const others = candidates.filter((c) => c.userId !== currentOwnerId);
  return roundRobin(others);
}
```

- [ ] **Step 4: Run to verify it passes + commit**

Run: `cd packages/core && npx vitest run src/pick-assignee.test.ts`
Expected: PASS.
```bash
git add packages/core/src/pick-assignee.ts packages/core/src/pick-assignee.test.ts
git commit -m "feat(core): pickReassignee for SLA escalation"
```

---

### Task 3: Migration — `lead.first_rep_contact_at` + `customer.sms_consent_at`

**Files:**
- Modify: `packages/db/src/schema/crm.ts`
- Generate: `packages/db/drizzle/NNNN_*.sql` + meta

**Interfaces:**
- Produces: `lead.firstRepContactAt: Date | null`, `customer.smsConsentAt: Date | null`.

- [ ] **Step 1: Add columns**

In `packages/db/src/schema/crm.ts`: add to `customer` (after `emailOptOut`): `smsConsentAt: timestamp("sms_consent_at", { withTimezone: true }),` and to `lead` (after `lane`): `firstRepContactAt: timestamp("first_rep_contact_at", { withTimezone: true }),`. (`timestamp` is already imported.)

- [ ] **Step 2: Generate + verify + typecheck**

Run: `pnpm db:generate` then `ls packages/db/drizzle/*.sql | tail -1` — confirm it adds both columns. Run `pnpm typecheck` (expect PASS — additive columns).

- [ ] **Step 3: Commit (SQL + meta together)**

```bash
git add packages/db/src/schema/crm.ts packages/db/drizzle
git commit -m "feat(db): lead.first_rep_contact_at + customer.sms_consent_at"
```

---

### Task 4: Events (`@savvy/agents`)

**Files:**
- Modify: `packages/agents/src/client.ts`

- [ ] **Step 1: Add the three events**

In `packages/agents/src/client.ts`, add to the `Events` record:

```ts
  "lead/contacted": { data: { leadId: string; tenantId: string } };
  "lead/contact-overdue": { data: { leadId: string; tenantId: string } };
  "lead/disqualified": { data: { leadId: string; tenantId: string } };
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm typecheck` (PASS).
```bash
git add packages/agents/src/client.ts
git commit -m "feat(agents): lead/contacted, lead/contact-overdue, lead/disqualified events"
```

---

### Task 5: Contact signal — `markLeadContacted`, `logLeadContact`, inbound + lost hooks

**Files:**
- Create: `packages/db/src/lifecycle/contact.ts`
- Modify: `packages/db/src/index.ts`, `apps/web/src/lib/lead-actions.ts`, `apps/web/src/lib/inbound-sms.ts`, `packages/db/src/lifecycle/leads.ts`
- Test: `packages/db/src/lifecycle/contact.test.ts` (CI-gated)

**Interfaces:**
- Produces: `markLeadContacted(tx, {tenantId, leadId}): Promise<boolean>` (true if it set the timestamp now); `markCustomerLeadsContacted(tx, {tenantId, customerId}): Promise<string[]>` (open lead ids it just marked); server action `logLeadContact(leadId)`.

- [ ] **Step 1: DB lifecycle — `markLeadContacted` + `markCustomerLeadsContacted`**

Create `packages/db/src/lifecycle/contact.ts`:

```ts
import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import { lead } from "../schema/index";

type Tx = Parameters<Parameters<typeof import("../client").db.transaction>[0]>[0];
const OPEN = ["new", "contacted", "qualified", "booked"] as const;

// Sets first_rep_contact_at = now() if currently null. Returns true iff it set it this call.
export async function markLeadContacted(tx: Tx, opts: { tenantId: string; leadId: string }): Promise<boolean> {
  const res = await tx.update(lead).set({ firstRepContactAt: sql`now()` })
    .where(and(eq(lead.id, opts.leadId), eq(lead.tenantId, opts.tenantId), isNull(lead.firstRepContactAt)))
    .returning({ id: lead.id });
  return res.length > 0;
}

// Marks all of a customer's OPEN, not-yet-contacted leads. Returns the ids it set.
export async function markCustomerLeadsContacted(tx: Tx, opts: { tenantId: string; customerId: string }): Promise<string[]> {
  const res = await tx.update(lead).set({ firstRepContactAt: sql`now()` })
    .where(and(eq(lead.tenantId, opts.tenantId), eq(lead.customerId, opts.customerId), isNull(lead.firstRepContactAt), inArray(lead.status, [...OPEN])))
    .returning({ id: lead.id });
  return res.map((r) => r.id);
}
```
Export both from `packages/db/src/index.ts` (or confirm the lifecycle barrel re-exports the new file).

- [ ] **Step 2: Server action `logLeadContact`**

In `apps/web/src/lib/lead-actions.ts`, add (import `withTenant`, `markLeadContacted`, `inngest`):

```ts
export async function logLeadContact(leadId: string): Promise<{ ok: true } | { error: string }> {
  try {
    const tenantId = await getTenantId();
    const set = await withTenant(tenantId, (tx) => markLeadContacted(tx, { tenantId, leadId }));
    if (set) {
      try { await inngest.send({ name: "lead/contacted", data: { leadId, tenantId } }); } catch (e) { console.error(e); }
    }
    revalidatePath(`/leads/${leadId}`);
    return { ok: true };
  } catch {
    return { error: "could not log contact" };
  }
}
```

- [ ] **Step 3: Inbound reply hook**

In `apps/web/src/lib/inbound-sms.ts`, in the reply branch (after `stopDripEnrollments`, when `reason === "reply"`), mark the customer's open leads contacted and emit `lead/contacted` per lead:

```ts
  // A customer reply counts as first contact — record it + cancel SLA/cadence.
  if (reason === "reply") {
    const leadIds = await withTenant(tenantId, (tx) => markCustomerLeadsContacted(tx, { tenantId, customerId: c.id }));
    for (const leadId of leadIds) {
      try { await inngest.send({ name: "lead/contacted", data: { leadId, tenantId } }); } catch (e) { console.error(e); }
    }
  }
```
Add `markCustomerLeadsContacted` to the `@savvy/db` import.

- [ ] **Step 4: Emit `lead/disqualified` from the lost path**

In `apps/web/src/lib/lead-actions.ts`, find the action that calls `setLeadLost` (e.g. `setLeadLostAction`/`markLeadLost`). After it succeeds, emit:

```ts
    try { await inngest.send({ name: "lead/disqualified", data: { leadId, tenantId } }); } catch (e) { console.error(e); }
```
(If no such action exists yet, add a `markLeadLost(leadId)` server action that calls `setLeadLost` in a `withTenant` tx, emits `lead/disqualified`, and revalidates — mirror `logLeadContact`.)

- [ ] **Step 5: CI-gated test + typecheck**

Create `packages/db/src/lifecycle/contact.test.ts`: seed a tenant + customer + an open lead; `markLeadContacted` returns true then false on the second call; `firstRepContactAt` is set; `markCustomerLeadsContacted` marks open leads and returns ids. Mirror sibling lifecycle test harness. Run `pnpm typecheck` (PASS).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/contact.ts packages/db/src/index.ts apps/web/src/lib/lead-actions.ts apps/web/src/lib/inbound-sms.ts packages/db/src/lifecycle/leads.ts packages/db/src/lifecycle/contact.test.ts
git commit -m "feat(leads): first_rep_contact_at via rep action + inbound reply; lead/contacted + lead/disqualified"
```

---

### Task 6: Consent capture at intake (`apps/web`)

**Files:**
- Modify: `apps/web/src/lib/intake.ts`
- Test: `apps/web/src/lib/intake.test.ts` (extend; CI-gated)

- [ ] **Step 1: Set `sms_consent_at` when a phone is present**

In `createLeadForTenant` (`intake.ts`): when inserting a NEW customer with a phone, set `smsConsentAt: sql\`now()\``. When REUSING an existing customer (dedupe path) whose `smsConsentAt` is null and the incoming input has a phone, update it to now. Add `sql` to the `@savvy/db` import.

New-customer insert:
```ts
    const c = existing ?? (await tx.insert(customer)
      .values({ tenantId, name: input.name, phone: input.phone ?? null, email: input.email ?? null,
                smsConsentAt: input.phone ? sql`now()` : null })
      .returning())[0]!;
    if (existing && input.phone && existing.smsConsentAt == null) {
      await tx.update(customer).set({ smsConsentAt: sql`now()` }).where(eq(customer.id, c.id));
    }
```

- [ ] **Step 2: CI-gated test + typecheck**

Extend `intake.test.ts`: a lead created with a phone has `customer.sms_consent_at` set; email-only lead leaves it null. Run `pnpm typecheck` (PASS).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/intake.ts apps/web/src/lib/intake.test.ts
git commit -m "feat(intake): capture sms_consent_at when a phone is provided"
```

---

### Task 7: Instant ack rework — SMS + email, template-first (`@savvy/agents`)

**Files:**
- Modify: `packages/agents/src/functions/lead-intake.ts`
- Test: `packages/agents/src/functions/lead-intake.test.ts` (extend)

**Interfaces:**
- Consumes: `getEmailSender` (`@savvy/integrations`), `shouldSendChannel` (`@savvy/core`), `renderTemplate` (`@savvy/core`).
- Produces: `buildAckSms(vars)`, `buildAckEmail(vars)` (exported, pure).

- [ ] **Step 1: Add pure ack builders (template-first)**

In `lead-intake.ts`, replace `buildBookingSms` usage with ack builders. Add:

```ts
export function buildAckSms(v: { name: string; bookingUrl: string }): string {
  return renderTemplate("Hi {{name}}, thanks for reaching out! Book your free roof inspection here: {{bookingUrl}}", v);
}
export function buildAckEmail(v: { name: string; bookingUrl: string }): { subject: string; html: string } {
  return {
    subject: "Your free roof inspection",
    html: renderTemplate("<p>Hi {{name}},</p><p>Thanks for reaching out. Book your free roof inspection any time:</p><p><a href=\"{{bookingUrl}}\">{{bookingUrl}}</a></p>", v),
  };
}
```
Add `renderTemplate` to the `@savvy/core` import. (Optional personalization is explicitly out of this task's minimal slice — the template is the send; a later enhancement can wrap `draftMessage`. Keep the ack template-only here to guarantee <60s.)

- [ ] **Step 2: Send ack SMS + email in the step, consent/opt-out gated**

Replace the `send-sms` `step.run` body with an `send-ack` step that loads the customer's consent/opt-out, sends both channels it's allowed to, and logs each. Full body:

```ts
    await step.run("send-ack", async () => {
      const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
      const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
      const token = signPayloadToken({ leadId, tenantId, type: "inspection" }, secret);
      const bookingUrl = `${base}/book/${token}`;
      const vars = { name: ctx.name, bookingUrl };

      const cust = await withTenant(tenantId, async (tx) => {
        const [row] = await tx.select({
          email: customer.email, smsOptOut: customer.smsOptOut, emailOptOut: customer.emailOptOut, smsConsentAt: customer.smsConsentAt,
          gmail: tenantTbl.settings,
        }).from(customer).leftJoin(tenantTbl, eq(tenantTbl.id, customer.tenantId)).where(eq(customer.id, ctx.customerId));
        return row ?? null;
      });
      if (!cust) return { skipped: "no-customer" };

      // SMS ack (transactional — quiet-hours EXEMPT), gated by consent + opt-out.
      if (ctx.phone && shouldSendChannel("sms", { smsOptOut: cust.smsOptOut, emailOptOut: cust.emailOptOut, smsConsentAt: cust.smsConsentAt })) {
        let sid = "mock";
        try { ({ sid } = await (sms as SmsSender).sendSms({ to: ctx.phone, from: smsFrom(), body: buildAckSms(vars) })); } catch { /* dev: no creds */ }
        await withTenant(tenantId, (tx) => tx.insert(communication).values({
          tenantId, customerId: ctx.customerId, channel: "sms", direction: "outbound", to: ctx.phone, body: buildAckSms(vars), twilioSid: sid, aiHandled: false,
        }));
      }
      // Email ack, gated by opt-out.
      if (cust.email && shouldSendChannel("email", { smsOptOut: cust.smsOptOut, emailOptOut: cust.emailOptOut, smsConsentAt: cust.smsConsentAt })) {
        const sender = getEmailSender({ gmailConnectionId: null });
        const { subject, html } = buildAckEmail(vars);
        try { await sender.sendEmail({ to: cust.email, from: process.env.RESEND_FROM ?? "noreply@savvy.app", subject, html }); } catch { /* dev: no creds */ }
        await withTenant(tenantId, (tx) => tx.insert(communication).values({
          tenantId, customerId: ctx.customerId, channel: "email", direction: "outbound", to: cust.email, body: subject, aiHandled: false,
        }));
      }
      return { ok: true };
    });
```

Requirements for this to compile:
- `ctx` must carry `customerId` — add `customerId` to the `load-lead` step's returned `ctx` (it loads the lead which has `customerId`).
- Add imports: `getEmailSender` (`@savvy/integrations`), `shouldSendChannel` (`@savvy/core`), and `tenant as tenantTbl` + `customer` (already imported) from `@savvy/db`. Remove now-unused `buildBookingSms`/`isAfterHours` if nothing else references them (grep first).

- [ ] **Step 2b: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. Fix any missing import/`ctx.customerId` wiring.

- [ ] **Step 3: Test (extend; the builders are unit-testable)**

In `lead-intake.test.ts`, add unit assertions: `buildAckSms({name:"Jane",bookingUrl:"u"})` contains "Jane" and "u"; `buildAckEmail(...)` subject + html contain the URL. The DB send path stays CI-gated.

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/functions/lead-intake.ts packages/agents/src/functions/lead-intake.test.ts
git commit -m "feat(agents): ack SMS+email at intake (template-first, consent/opt-out gated)"
```

---

### Task 8: Speed-to-lead workflow (`@savvy/agents`)

**Files:**
- Create: `packages/agents/src/functions/lead-speed-to-lead.ts`
- Modify: `packages/agents/src/index.ts`
- Test: `packages/agents/src/functions/lead-speed-to-lead.test.ts` (CI-gated)

**Interfaces:**
- Consumes: `parseSpeedToLeadConfig`, `pickReassignee` (`@savvy/core`); `getAssignmentCandidates`, `setLeadOwner`, `recordAgentRun` (`@savvy/db`).

- [ ] **Step 1: Implement the function**

Create `packages/agents/src/functions/lead-speed-to-lead.ts`:

```ts
import { adminDb, withTenant, lead, tenant, eq, getAssignmentCandidates, setLeadOwner, recordAgentRun } from "@savvy/db";
import { parseSpeedToLeadConfig, pickReassignee } from "@savvy/core";
import { inngest } from "../client";

async function loadSla(tenantId: string): Promise<{ firstTouchSlaMin: number; escalateMin: number }> {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  return parseSpeedToLeadConfig((t?.settings as { speedToLead?: unknown } | null)?.speedToLead);
}

export const leadSpeedToLead = inngest.createFunction(
  { id: "lead-speed-to-lead", concurrency: { limit: 10 }, cancelOn: [{ event: "lead/contacted", match: "data.leadId" }] },
  { event: "lead/created" },
  async ({ event, step }) => {
    const { leadId, tenantId } = event.data;
    const cfg = await step.run("load-sla", () => loadSla(tenantId));

    await step.sleep("first-touch-sla", `${cfg.firstTouchSlaMin}m`);
    const overdue = await step.run("check-overdue", async () =>
      withTenant(tenantId, async (tx) => {
        const [l] = await tx.select({ contacted: lead.firstRepContactAt, owner: lead.assignedUserId }).from(lead).where(eq(lead.id, leadId));
        return l && l.contacted == null && l.owner != null ? { owner: l.owner } : null;
      }),
    );
    if (!overdue) return { status: "contacted-or-unassigned" };

    try { await inngest.send({ name: "lead/contact-overdue", data: { leadId, tenantId } }); } catch (e) { console.error(e); }
    await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "lead.sla.overdue", status: "ok" });

    await step.sleep("escalate-window", `${Math.max(1, cfg.escalateMin - cfg.firstTouchSlaMin)}m`);
    const stillOpen = await step.run("check-escalate", async () =>
      withTenant(tenantId, async (tx) => {
        const [l] = await tx.select({ contacted: lead.firstRepContactAt, owner: lead.assignedUserId }).from(lead).where(eq(lead.id, leadId));
        return l && l.contacted == null ? { owner: l.owner } : null;
      }),
    );
    if (!stillOpen) return { status: "contacted-after-overdue" };

    const reassigned = await step.run("reassign", async () =>
      withTenant(tenantId, async (tx) => {
        const candidates = await getAssignmentCandidates(tx, tenantId);
        const next = pickReassignee(candidates, stillOpen.owner);
        if (!next) return null;
        await setLeadOwner(tx, { tenantId, leadId, userId: next });
        return next;
      }),
    );
    await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "lead.sla.escalated", status: reassigned ? "ok" : "skipped", error: reassigned ? null : "no-candidate" });
    return { status: "escalated", reassigned };
  },
);
```

- [ ] **Step 2: Register + typecheck**

Import `leadSpeedToLead` in `packages/agents/src/index.ts` and add to the `functions` array. Run `pnpm typecheck` (PASS).

- [ ] **Step 3: CI-gated test**

Create `lead-speed-to-lead.test.ts`: assert (via Inngest's test tooling, or by extracting the check logic) that an uncontacted assigned lead yields an overdue emit + reassign, and a contacted lead short-circuits. If full workflow stepping isn't ergonomic, test the pure decision (`pickReassignee` is already covered; assert `check-overdue`/`check-escalate` predicates against seeded rows). CI-gated.

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/functions/lead-speed-to-lead.ts packages/agents/src/index.ts packages/agents/src/functions/lead-speed-to-lead.test.ts
git commit -m "feat(agents): speed-to-lead 3-min guardrail (overdue event + reassign escalation)"
```

---

### Task 9: Lead cadence workflow (`@savvy/agents`)

**Files:**
- Create: `packages/agents/src/functions/lead-cadence.ts`
- Modify: `packages/agents/src/index.ts`
- Test: `packages/agents/src/functions/lead-cadence.test.ts` (CI-gated)

**Interfaces:**
- Consumes: `parseLeadCadenceConfig`, `shouldSendChannel`, `parseFinanceConfig`, `renderTemplate` (`@savvy/core`); `nextAllowedSendTime` (`@savvy/core`); senders; `buildAckSms`/`buildAckEmail` (Task 7) for booking copy.

- [ ] **Step 1: Implement the function**

Create `packages/agents/src/functions/lead-cadence.ts`:

```ts
import { adminDb, withTenant, lead, customer, tenant, communication, eq, and } from "@savvy/db";
import { parseLeadCadenceConfig, parseFinanceConfig, shouldSendChannel, nextAllowedSendTime, signPayloadToken, requireSecret } from "@savvy/core";
import { sms, smsFrom, getEmailSender, type SmsSender } from "@savvy/integrations";
import { buildAckSms, buildAckEmail } from "./lead-intake";
import { inngest } from "../client";

const OPEN = ["new", "contacted", "qualified", "booked"];

export const leadCadence = inngest.createFunction(
  {
    id: "lead-cadence", concurrency: { limit: 10 },
    cancelOn: [
      { event: "lead/contacted", match: "data.leadId" },
      { event: "lead/disqualified", match: "data.leadId" },
    ],
  },
  { event: "lead/created" },
  async ({ event, step }) => {
    const { leadId, tenantId } = event.data;
    const setup = await step.run("load-cadence", async () => {
      const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
      const cfg = parseLeadCadenceConfig((t?.settings as { leadCadence?: unknown } | null)?.leadCadence);
      const tz = parseFinanceConfig((t?.settings as { finance?: unknown } | null)?.finance).timezone;
      return { cfg, tz };
    });

    const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
    const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
    const bookingUrl = `${base}/book/${signPayloadToken({ leadId, tenantId, type: "inspection" }, secret)}`;

    for (let i = 0; i < setup.cfg.steps.length; i++) {
      const touch = setup.cfg.steps[i]!;
      await step.sleep(`wait-${i}`, `${touch.dayOffset * 24 + touch.hourOffset}h`);

      const ctx = await step.run(`load-${i}`, async () =>
        withTenant(tenantId, async (tx) => {
          const [row] = await tx.select({
            status: lead.status, contacted: lead.firstRepContactAt, customerId: lead.customerId,
            name: customer.name, phone: customer.phone, email: customer.email,
            smsOptOut: customer.smsOptOut, emailOptOut: customer.emailOptOut, smsConsentAt: customer.smsConsentAt,
          }).from(lead).leftJoin(customer, eq(lead.customerId, customer.id)).where(eq(lead.id, leadId));
          return row ?? null;
        }),
      );
      if (!ctx || ctx.contacted != null || !OPEN.includes(ctx.status)) return { stopped: "contacted-or-closed", atStep: i };

      const gate = { smsOptOut: ctx.smsOptOut ?? false, emailOptOut: ctx.emailOptOut ?? false, smsConsentAt: ctx.smsConsentAt };
      if (!shouldSendChannel(touch.channel, gate)) continue; // opted out / no consent for this channel
      if (touch.channel === "sms" && !ctx.phone) continue;
      if (touch.channel === "email" && !ctx.email) continue;

      await step.run(`send-${i}`, async () => {
        const vars = { name: ctx.name ?? "there", bookingUrl };
        if (touch.channel === "sms") {
          let sid = "mock";
          try { ({ sid } = await (sms as SmsSender).sendSms({ to: ctx.phone!, from: smsFrom(), body: buildAckSms(vars) })); } catch { /* dev */ }
          await withTenant(tenantId, (tx) => tx.insert(communication).values({
            tenantId, customerId: ctx.customerId, channel: "sms", direction: "outbound", to: ctx.phone, body: buildAckSms(vars), twilioSid: sid, aiHandled: false,
          }));
        } else {
          const { subject, html } = buildAckEmail(vars);
          try { await getEmailSender({ gmailConnectionId: null }).sendEmail({ to: ctx.email!, from: process.env.RESEND_FROM ?? "noreply@savvy.app", subject, html }); } catch { /* dev */ }
          await withTenant(tenantId, (tx) => tx.insert(communication).values({
            tenantId, customerId: ctx.customerId, channel: "email", direction: "outbound", to: ctx.email, body: subject, aiHandled: false,
          }));
        }
        return { sent: touch.channel };
      });
    }
    return { status: "exhausted-in-nurture" };
  },
);
```

> Quiet-hours note: `step.sleep` advances by the touch offset; for an SMS touch landing inside quiet hours, gate the send time with `nextAllowedSendTime` — wrap the SMS branch's send in a check that, if `nextAllowedSendTime(now, tz, cfg.quietHours)` is later than now, does an extra `step.sleepUntil` to that time before sending. (Implement with a `step.sleepUntil(\`quiet-${i}\`, nextAllowed)` computed in the `load-${i}` step and returned alongside `ctx`.) Keep the email channel exempt.

- [ ] **Step 2: Register + typecheck**

Import `leadCadence` in `packages/agents/src/index.ts`, add to `functions`. Run `pnpm typecheck` (PASS).

- [ ] **Step 3: CI-gated test**

Create `lead-cadence.test.ts`: assert an opted-out customer is skipped on SMS touches (the `shouldSendChannel`/`continue` path), a contacted lead stops the cadence, and a consenting customer's first touch logs a communication. CI-gated.

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/functions/lead-cadence.ts packages/agents/src/index.ts packages/agents/src/functions/lead-cadence.test.ts
git commit -m "feat(agents): lead cadence workflow (quiet-hours + consent + opt-out gated)"
```

---

### Task 10: "Log contact" button on lead detail (`apps/web`)

**Files:**
- Modify: `apps/web/src/app/(app)/leads/[id]/page.tsx` (+ a small client component if the page is a server component)

- [ ] **Step 1: Add the button wired to `logLeadContact`**

Add a "Log contact" button to the lead detail near the contact card. If `detail.firstRepContactAt` is set, show "Contacted ✓ <relative time>" instead. The button calls the `logLeadContact(leadId)` server action (via a client component with `useTransition`, mirroring `NewLeadForm`'s action pattern, OR a server action form). Add `firstRepContactAt` to `getLeadDetail` (`leads-queries.ts`) select + `LeadDetail` type. Use design-system classes (no hardcoded colors), `data-testid="log-contact"`.

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint` (PASS).

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/leads/[id]/page.tsx" apps/web/src/lib/leads-queries.ts
git commit -m "feat(leads): Log contact button records first rep contact"
```

---

### Task 11: Doc — speed-to-lead + cadence + compliance

**Files:**
- Create: `docs/lead-pipeline-speed-to-lead.md`

- [ ] **Step 1: Write the doc**

Create `docs/lead-pipeline-speed-to-lead.md`: the ack (SMS+email, template-first, quiet-hours-exempt), the 3-min/10-min SLA + the `lead/contact-overdue` Phase-D hook + reassign escalation, the cadence schedule + how to tune (`tenant.settings.speedToLead`, `tenant.settings.leadCadence` with real keys + defaults), the consent model (phone-at-intake = consent), quiet-hours (tenant tz from finance config), opt-out, and the `lead/contacted`/`lead/disqualified` cancel events. Note DNC is out of scope. ~1 page.

- [ ] **Step 2: Commit**

```bash
git add docs/lead-pipeline-speed-to-lead.md
git commit -m "docs: speed-to-lead + cadence + compliance — how it works and how to tune"
```

---

### Task 12: Full gate, push, PR, CI

- [ ] **Step 1: Full local gate**

```bash
cd ~/Sites/savvy-phasec
( cd packages/core && npx vitest run )
pnpm typecheck
pnpm lint
```
Expected: all PASS.

- [ ] **Step 2: Push + PR**

```bash
git push -u origin feat/instant-contact
gh pr create --base main --title "Phase C: instant contact + speed-to-lead + cadence + compliance" --body "$(cat <<'EOF'
## Summary
- **Instant ack**: intake sends SMS **+ email** in <60s, template-first, consent/opt-out gated, quiet-hours exempt (transactional).
- **Contact signal**: `lead.first_rep_contact_at` set by a rep "Log contact" action AND by an inbound customer reply → emits `lead/contacted`.
- **3-min guardrail** (`lead-speed-to-lead`): no contact in 3 min → emits `lead/contact-overdue` (**Phase D voice hook**) + audit; 10 min → reassign + audit. `cancelOn lead/contacted`.
- **Cadence** (`lead-cadence`): Day 0×2/1/3/5/7/14, quiet-hours (tenant tz) + consent + opt-out gated. `cancelOn lead/contacted | lead/disqualified`.
- **Compliance**: `customer.sms_consent_at` captured at intake (phone = consent); opt-out honored; DNC deferred.

## Notes
The ack is template-only to guarantee <60s (optional LLM personalization is a future wrap). "Manager alert" = reassign + agentRun audit (no rep push channel yet). DNC registry out of scope.

## Tests
- Core unit: config/cadence defaults, `shouldSendChannel` gating, `pickReassignee`, ack builders.
- CI-gated DB/workflow: contact signal (action + inbound), consent capture, SLA overdue/escalate predicates, cadence opt-out skip + cancel.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr checks --watch
```
Expected: green. Fix-forward if red. **Do not merge until Brett says so.**

---

## Self-Review

**Spec coverage:**
- Ack SMS+email template-first, quiet-hours exempt → Task 7. ✅
- Contact signal (`first_rep_contact_at`, rep action + inbound reply) → Tasks 3, 5, 10. ✅
- 3-min guardrail + `lead/contact-overdue` + reassign escalation → Tasks 4, 8. ✅
- Cadence Day 0×2/1/3/5/7/14, quiet-hours + consent + opt-out → Tasks 1, 9. ✅
- Compliance: consent capture, opt-out, quiet-hours, `lead/disqualified` → Tasks 4, 5, 6, 9. ✅
- Config (`speedToLead`/`leadCadence`) → Tasks 1, 8, 9. ✅
- Events → Task 4. ✅
- Migration → Task 3. ✅
- Doc → Task 11. ✅
- Out of scope (voice, DNC, exception dashboard) → not built; `lead/contact-overdue` left as the Phase-D hook. ✅ (The optional Stage-7 exception cron is intentionally dropped to bound the phase — first-touch guardrail is covered by the SLA workflow.)

**Placeholder scan:** No TBD/TODO; pure tasks carry full code; DB/workflow tasks show full implementation code, with CI-gated test bodies described against existing harnesses.

**Type consistency:** `shouldSendChannel` (Task 1) consumed by Tasks 7+9. `pickReassignee` (Task 2) by Task 8. `markLeadContacted`/`markCustomerLeadsContacted` (Task 5) by the action + inbound hook. `buildAckSms`/`buildAckEmail` (Task 7) reused by Task 9. `firstRepContactAt`/`smsConsentAt` columns (Task 3) read/written by Tasks 5,6,7,8,9,10. Events (Task 4) emitted/consumed consistently (`lead/contacted` cancels Tasks 8+9).
