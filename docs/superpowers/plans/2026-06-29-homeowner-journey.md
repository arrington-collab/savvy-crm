# Homeowner Journey (F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Homeowners get (1) a public token-link status page showing their job's journey + next appointment, and (2) friendly SMS/email notifications on key stage milestones with a link to it.

**Architecture:** Reuse the public-token pattern for the page; a cron off `job_stage_event` (+ a `homeowner_notified_at` durable marker) for notifications (reliable across human+agent stage changes, which the `job/stage-changed` event misses). Dormant-safe: 2h lookback + marker → no historical spam, no double-sends; respects opt-out; fail-soft.

**Tech Stack:** TypeScript, Drizzle (Postgres + RLS), Inngest (cron), Twilio/email gateways, Vitest, Playwright, Next.js App Router (public route).

## Global Constraints

- **`.js` import rule:** db/agents `.test.ts` USE `.js` on relative imports; core/db/agents/web SOURCE use NO `.js`. In `packages/core` import `z` from `"./schemas"`.
- **apps/web NOT in vitest** — verify web via `pnpm typecheck` + Playwright e2e.
- **Migration discipline:** after `pnpm db:generate`, commit the `.sql` AND meta (`_journal.json` entry + new `NNNN_snapshot.json`) — `git add packages/db/drizzle`. CI fresh-DB silently skips a migration with a missing journal entry. The migration must be only `ALTER TABLE "job_stage_event" ADD COLUMN "homeowner_notified_at" timestamp with time zone;` — NO drops.
- **Dormant-safe notifier:** acts only on events `entered_at >= now - 2h` and stamps `homeowner_notified_at` → no historical spam on first deploy, no double-send. Respect `customer.smsOptOut`/`emailOptOut`. Fail-soft on missing creds (try/catch, like `appointment-reminders`).
- **Public route:** `/status/[token]` must be added to `middleware.ts` PUBLIC; `getHomeownerStatus(token)` uses the token's `tenantId`, NOT `getTenantId()`.
- **Token:** reuse `requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" })` + `signPayloadToken`/`verifyPayloadToken` (`@savvy/core`). Link base = `process.env.APP_BASE_URL ?? "http://localhost:3000"`.
- **Inngest cron:** `concurrency.limit` 1 (≤ free-plan cap 5); register in `packages/agents/src/index.ts` `functions` array.
- **Tenant isolation:** all data via `withTenant`; cron uses `adminDb` only for the tenant-id list.
- Focused tests:
  - core → `pnpm --filter @savvy/core exec vitest run src/homeowner.test.ts`
  - db → `pnpm --filter @savvy/db exec vitest run tests/homeowner.test.ts` (docker `savvy_db`; `pnpm db:up && pnpm --filter @savvy/db db:migrate` if `ECONNREFUSED`)
  - agents → `pnpm --filter @savvy/agents exec vitest run src/functions/homeowner-notify.test.ts`
  - e2e → from `apps/web`: `npx tsx tests/e2e/create-tenant.ts && export TEST_TENANT_ID=$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)") && ./node_modules/.bin/playwright test tests/e2e/homeowner-status.spec.ts`
- Final gate: `pnpm test && pnpm typecheck && pnpm lint` green.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/core/src/homeowner.ts` | config + stage copy + journey | Create |
| `packages/core/src/homeowner.test.ts` | unit tests | Create |
| `packages/core/src/index.ts` | export it | Modify (append) |
| `packages/db/src/schema/jobs.ts` | `homeowner_notified_at` on `job_stage_event` | Modify |
| `packages/db/drizzle/*` | migration + meta | Create |
| `packages/db/src/lifecycle/homeowner.ts` | `getHomeownerStatus`, `listStageEventsToNotify`, `markStageEventNotified` | Create |
| `packages/db/src/index.ts` | export them | Modify |
| `packages/db/tests/homeowner.test.ts` | db tests | Create |
| `packages/agents/src/functions/homeowner-notify.ts` | cron + `evaluateTenantHomeownerNotifs` | Create |
| `packages/agents/src/index.ts` | register cron | Modify |
| `packages/agents/src/functions/homeowner-notify.test.ts` | cron helper tests | Create |
| `apps/web/src/middleware.ts` | add `/status/` PUBLIC | Modify |
| `apps/web/src/lib/homeowner-actions.ts` | `getHomeownerStatus(token)` | Create |
| `apps/web/src/app/status/[token]/page.tsx` | public status page | Create |
| `apps/web/tests/e2e/homeowner-status.spec.ts` | e2e | Create |
| `docs/jobs-pipeline.md` | docs | Modify |

---

## Task 1: Core — homeowner config, copy, journey (haiku)

**Files:** Create `packages/core/src/homeowner.ts` + `.test.ts`; Modify `packages/core/src/index.ts`.

- [ ] **Step 1: Failing tests** — `packages/core/src/homeowner.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseHomeownerConfig, homeownerStageCopy, buildHomeownerJourney } from "./homeowner";

describe("parseHomeownerConfig", () => {
  it("defaults", () => {
    expect(parseHomeownerConfig(undefined)).toEqual({ enabled: true, notifyStages: ["approved", "production", "complete"] });
  });
  it("filters invalid stages + merges", () => {
    expect(parseHomeownerConfig({ notifyStages: ["production", "nonsense", "complete"], enabled: false }))
      .toEqual({ enabled: false, notifyStages: ["production", "complete"] });
  });
});

describe("homeownerStageCopy", () => {
  it("has headline+body for every stage", () => {
    for (const s of ["lead","inspected","estimate","approved","production","closeout","billing","complete","lost"] as const) {
      const c = homeownerStageCopy(s);
      expect(c.headline.length).toBeGreaterThan(0);
      expect(c.body.length).toBeGreaterThan(0);
    }
    expect(homeownerStageCopy("approved").headline).toContain("approved");
  });
});

describe("buildHomeownerJourney", () => {
  it("marks done/current/upcoming by stage position", () => {
    const j = buildHomeownerJourney("approved");
    const by = Object.fromEntries(j.map((m) => [m.key, m.status]));
    expect(by.inspected).toBe("done");
    expect(by.estimate).toBe("done");
    expect(by.approved).toBe("current");
    expect(by.production).toBe("upcoming");
    expect(by.complete).toBe("upcoming");
    expect(j.map((m) => m.key)).toEqual(["inspected","estimate","approved","production","closeout","complete"]);
  });
});
```

- [ ] **Step 2: Run → fail.** `pnpm --filter @savvy/core exec vitest run src/homeowner.test.ts`

- [ ] **Step 3: Implement** — `packages/core/src/homeowner.ts`:
```ts
import { z } from "./schemas";
import { JOB_STAGE, type JobStage } from "./enums";

const NOTIFY_DEFAULT: JobStage[] = ["approved", "production", "complete"];

const homeownerSchema = z.object({
  enabled: z.boolean().default(true),
  notifyStages: z.array(z.string()).default(NOTIFY_DEFAULT)
    .transform((a) => a.filter((s): s is JobStage => (JOB_STAGE as readonly string[]).includes(s))),
});
export type HomeownerConfig = { enabled: boolean; notifyStages: JobStage[] };
export function parseHomeownerConfig(raw: unknown): HomeownerConfig {
  return homeownerSchema.parse(raw ?? {}) as HomeownerConfig;
}

/** Customer-friendly milestone copy for notifications + the status page. */
export function homeownerStageCopy(stage: JobStage): { headline: string; body: string } {
  const map: Record<JobStage, { headline: string; body: string }> = {
    lead: { headline: "We've got your info", body: "Thanks for reaching out! We'll be in touch to schedule your inspection." },
    inspected: { headline: "Inspection complete", body: "Your roof inspection is done — we're preparing your estimate." },
    estimate: { headline: "Your estimate is ready", body: "We've put together your estimate and will walk you through it." },
    approved: { headline: "You're approved! 🎉", body: "Your project is approved — we're getting it on the schedule." },
    production: { headline: "Installation underway", body: "Good news — work on your new roof is underway." },
    closeout: { headline: "Finishing up", body: "We're wrapping up the final details on your roof." },
    billing: { headline: "Almost done", body: "Your project is complete — final paperwork is on the way." },
    complete: { headline: "All done! 🏠", body: "Your project is complete. Thank you for trusting us with your home!" },
    lost: { headline: "Project on hold", body: "This project isn't moving forward right now. Reach out anytime if that changes." },
  };
  return map[stage];
}

const MILESTONES: { key: JobStage; label: string }[] = [
  { key: "inspected", label: "Inspection" },
  { key: "estimate", label: "Estimate" },
  { key: "approved", label: "Approved" },
  { key: "production", label: "Installation" },
  { key: "closeout", label: "Finishing up" },
  { key: "complete", label: "Complete" },
];

/** The homeowner-facing journey: each milestone marked done/current/upcoming vs the current stage. */
export function buildHomeownerJourney(currentStage: JobStage): Array<{ key: JobStage; label: string; status: "done" | "current" | "upcoming" }> {
  const cur = JOB_STAGE.indexOf(currentStage);
  return MILESTONES.map((m) => {
    const mi = JOB_STAGE.indexOf(m.key);
    const status = mi < cur ? "done" : mi === cur ? "current" : "upcoming";
    return { key: m.key, label: m.label, status };
  });
}
```
Append to `packages/core/src/index.ts` (END): `export * from "./homeowner";`

- [ ] **Step 4: Run → pass.** Same command.
- [ ] **Step 5: Commit** — `git add packages/core/src/homeowner.ts packages/core/src/homeowner.test.ts packages/core/src/index.ts && git commit -m "feat(core): homeowner config + stage copy + journey"`

---

## Task 2: DB — marker + reads (sonnet)

**Files:** Modify `packages/db/src/schema/jobs.ts`, `packages/db/src/index.ts`; Create migration + `packages/db/src/lifecycle/homeowner.ts` + `packages/db/tests/homeowner.test.ts`.

- [ ] **Step 1: Add the column** — in `packages/db/src/schema/jobs.ts`, add to `jobStageEvent` (after `enteredAt`):
```ts
  homeownerNotifiedAt: timestamp("homeowner_notified_at", { withTimezone: true }),
```

- [ ] **Step 2: Generate + inspect + apply** — `pnpm db:generate`; inspect the new `packages/db/drizzle/0029_*.sql` (only the one `ALTER TABLE "job_stage_event" ADD COLUMN "homeowner_notified_at" timestamp with time zone;`, no drops); confirm meta committed; `pnpm db:up && pnpm --filter @savvy/db db:migrate`.

- [ ] **Step 3: Failing tests** — `packages/db/tests/homeowner.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { getHomeownerStatus, listStageEventsToNotify, markStageEventNotified } from "../src/lifecycle/homeowner.js";
import { jobStageEvent, appointment } from "../src/schema/index.js";
import { adminDb } from "../src/admin-client.js";
import { eq } from "drizzle-orm";
import { makeTenant, makeJobWithProperty } from "./helpers.js";

async function seed(): Promise<{ tenantId: string; jobId: string; customerId: string }> {
  const { tenantId } = await makeTenant();
  const { jobId, customerId } = await makeJobWithProperty(tenantId);
  return { tenantId, jobId, customerId };
}

describe("getHomeownerStatus", () => {
  it("returns job journey + next appointment", async () => {
    const { tenantId, jobId } = await seed();
    const future = new Date(Date.now() + 3 * 86_400_000);
    await adminDb.insert(jobStageEvent).values({ tenantId, jobId, toStage: "approved", enteredAt: new Date() });
    await adminDb.insert(appointment).values({ tenantId, jobId, type: "crew", status: "scheduled", startsAt: future, endsAt: new Date(future.getTime() + 3_600_000) });
    const s = await getHomeownerStatus(tenantId, jobId);
    expect(s).not.toBeNull();
    expect(s!.events.some((e) => e.toStage === "approved")).toBe(true);
    expect(s!.nextAppointment?.type).toBe("crew");
    expect(s!.companyName.length).toBeGreaterThan(0);
  });
});

describe("listStageEventsToNotify + markStageEventNotified", () => {
  it("returns recent un-notified events for the given stages, then dedupes after marking", async () => {
    const { tenantId, jobId } = await seed();
    const [ev] = await adminDb.insert(jobStageEvent).values({ tenantId, jobId, toStage: "production", enteredAt: new Date() }).returning();
    // an OLD event must be excluded by the recency window
    await adminDb.insert(jobStageEvent).values({ tenantId, jobId, toStage: "production", enteredAt: new Date(Date.now() - 5 * 86_400_000) });
    const now = new Date();
    let rows = await listStageEventsToNotify(tenantId, { stages: ["production"], sinceMs: 2 * 3_600_000, now });
    expect(rows.map((r) => r.eventId)).toContain(ev!.id);
    expect(rows.length).toBe(1); // old one excluded
    await markStageEventNotified(tenantId, ev!.id);
    rows = await listStageEventsToNotify(tenantId, { stages: ["production"], sinceMs: 2 * 3_600_000, now });
    expect(rows.find((r) => r.eventId === ev!.id)).toBeUndefined();
    const [after] = await withTenant(tenantId, (tx) => tx.select({ n: jobStageEvent.homeownerNotifiedAt }).from(jobStageEvent).where(eq(jobStageEvent.id, ev!.id)));
    expect(after!.n).not.toBeNull();
  });
});
```

- [ ] **Step 4: Run → fail.** `pnpm --filter @savvy/db exec vitest run tests/homeowner.test.ts`

- [ ] **Step 5: Implement** — `packages/db/src/lifecycle/homeowner.ts`:
```ts
import { and, eq, gte, isNull, inArray, asc, sql } from "drizzle-orm";
import { jobStageEvent, job, customer, property, appointment, tenant } from "../schema/index";
import { withTenant } from "../tenant";
import type { JobStage } from "@savvy/core";

export type HomeownerStatus = {
  companyName: string;
  customerName: string | null;
  address: string | null;
  currentStage: JobStage;
  events: { toStage: JobStage; enteredAt: Date }[];
  nextAppointment: { type: string; startsAt: Date } | null;
};

export async function getHomeownerStatus(tenantId: string, jobId: string): Promise<HomeownerStatus | null> {
  return withTenant(tenantId, async (tx) => {
    const [j] = await tx.select({ stage: job.stage, customerName: customer.name, address: property.address })
      .from(job)
      .leftJoin(customer, eq(customer.id, job.customerId))
      .leftJoin(property, eq(property.id, job.propertyId))
      .where(eq(job.id, jobId));
    if (!j) return null;
    const [t] = await tx.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, tenantId));
    const events = await tx.select({ toStage: jobStageEvent.toStage, enteredAt: jobStageEvent.enteredAt })
      .from(jobStageEvent).where(eq(jobStageEvent.jobId, jobId)).orderBy(asc(jobStageEvent.enteredAt));
    const [next] = await tx.select({ type: appointment.type, startsAt: appointment.startsAt })
      .from(appointment)
      .where(and(eq(appointment.jobId, jobId), eq(appointment.status, "scheduled"), gte(appointment.startsAt, new Date())))
      .orderBy(asc(appointment.startsAt)).limit(1);
    return {
      companyName: t?.name ?? "Your contractor",
      customerName: j.customerName,
      address: j.address,
      currentStage: j.stage as JobStage,
      events: events.map((e) => ({ toStage: e.toStage as JobStage, enteredAt: e.enteredAt })),
      nextAppointment: next ? { type: next.type, startsAt: next.startsAt } : null,
    };
  });
}

export type NotifiableEvent = { eventId: string; jobId: string; toStage: JobStage; customerId: string | null; phone: string | null; email: string | null; smsOptOut: boolean; emailOptOut: boolean };

export async function listStageEventsToNotify(
  tenantId: string, opts: { stages: JobStage[]; sinceMs: number; now: Date },
): Promise<NotifiableEvent[]> {
  if (opts.stages.length === 0) return [];
  const cutoff = new Date(opts.now.getTime() - opts.sinceMs);
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.select({
      eventId: jobStageEvent.id, jobId: jobStageEvent.jobId, toStage: jobStageEvent.toStage,
      customerId: customer.id, phone: customer.phone, email: customer.email,
      smsOptOut: customer.smsOptOut, emailOptOut: customer.emailOptOut,
    })
      .from(jobStageEvent)
      .leftJoin(job, eq(job.id, jobStageEvent.jobId))
      .leftJoin(customer, eq(customer.id, job.customerId))
      .where(and(
        inArray(jobStageEvent.toStage, opts.stages),
        isNull(jobStageEvent.homeownerNotifiedAt),
        gte(jobStageEvent.enteredAt, cutoff),
      ));
    return rows.map((r) => ({
      eventId: r.eventId, jobId: r.jobId, toStage: r.toStage as JobStage,
      customerId: r.customerId, phone: r.phone, email: r.email,
      smsOptOut: r.smsOptOut ?? false, emailOptOut: r.emailOptOut ?? false,
    }));
  });
}

export async function markStageEventNotified(tenantId: string, eventId: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.update(jobStageEvent).set({ homeownerNotifiedAt: sql`now()` }).where(eq(jobStageEvent.id, eventId)));
}
```
Export from `packages/db/src/index.ts`: `export { getHomeownerStatus, listStageEventsToNotify, markStageEventNotified } from "./lifecycle/homeowner";`

- [ ] **Step 6: Run → pass.** Same command.
- [ ] **Step 7: Commit** — `git add packages/db/src/schema/jobs.ts packages/db/drizzle packages/db/src/lifecycle/homeowner.ts packages/db/src/index.ts packages/db/tests/homeowner.test.ts && git commit -m "feat(db): homeowner_notified_at marker + getHomeownerStatus/listStageEventsToNotify"`

---

## Task 3: Agents — homeowner notification cron (sonnet)

**Files:** Create `packages/agents/src/functions/homeowner-notify.ts` + `.test.ts`; register in `packages/agents/src/index.ts`.

- [ ] **Step 1: Failing test** — `packages/agents/src/functions/homeowner-notify.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, job, customer, property, jobStageEvent, communication, eq } from "@savvy/db";
import { evaluateTenantHomeownerNotifs } from "./homeowner-notify";

async function seedTenantWithEvent(toStage: string, optOut = false): Promise<{ tenantId: string; eventId: string; customerId: string }> {
  const [t] = await adminDb.insert(tenant).values({ name: "HO Co", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`, settings: { homeowner: { enabled: true } } }).returning();
  const tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Homer", phone: "+15555551234", email: "homer@e2e.test", smsOptOut: optOut, emailOptOut: optOut }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Roof Ln" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: toStage as never }).returning();
  const [ev] = await adminDb.insert(jobStageEvent).values({ tenantId, jobId: j!.id, toStage: toStage as never, enteredAt: new Date() }).returning();
  return { tenantId, eventId: ev!.id, customerId: c!.id };
}

describe("evaluateTenantHomeownerNotifs", () => {
  it("sends + marks notified for a configured milestone, logs a communication", async () => {
    const { tenantId, eventId, customerId } = await seedTenantWithEvent("production");
    const r = await evaluateTenantHomeownerNotifs(tenantId, new Date());
    expect(r.sent).toBe(1);
    const [ev] = await withTenant(tenantId, (tx) => tx.select({ n: jobStageEvent.homeownerNotifiedAt }).from(jobStageEvent).where(eq(jobStageEvent.id, eventId)));
    expect(ev!.n).not.toBeNull();
    const comms = await withTenant(tenantId, (tx) => tx.select().from(communication).where(eq(communication.customerId, customerId)));
    expect(comms.length).toBeGreaterThanOrEqual(1);
  });
  it("no-ops for a non-configured stage (e.g. estimate not in default notifyStages)", async () => {
    const { tenantId } = await seedTenantWithEvent("estimate");
    expect((await evaluateTenantHomeownerNotifs(tenantId, new Date())).sent).toBe(0);
  });
  it("does not double-send on a second run", async () => {
    const { tenantId } = await seedTenantWithEvent("complete");
    await evaluateTenantHomeownerNotifs(tenantId, new Date());
    expect((await evaluateTenantHomeownerNotifs(tenantId, new Date())).sent).toBe(0);
  });
});
```

- [ ] **Step 2: Run → fail.** `pnpm --filter @savvy/agents exec vitest run src/functions/homeowner-notify.test.ts`

- [ ] **Step 3: Implement** — `packages/agents/src/functions/homeowner-notify.ts` (mirror `appointment-reminders.ts` send + `cold-archive.ts` cron loop):
```ts
import { adminDb, withTenant, tenant, communication, listStageEventsToNotify, markStageEventNotified, eq } from "@savvy/db";
import { parseHomeownerConfig, parseEmailConfig, homeownerStageCopy, signPayloadToken, requireSecret } from "@savvy/core";
import { sms, smsFrom, getEmailSender } from "@savvy/integrations";
import { inngest } from "../client";

const LOOKBACK_MS = 2 * 3_600_000;

export async function evaluateTenantHomeownerNotifs(tenantId: string, now: Date): Promise<{ sent: number }> {
  const [t] = await withTenant(tenantId, (tx) => tx.select({ settings: tenant.settings, name: tenant.name }).from(tenant).where(eq(tenant.id, tenantId)));
  const settings = (t?.settings ?? {}) as { homeowner?: unknown; email?: unknown };
  const cfg = parseHomeownerConfig(settings.homeowner);
  if (!cfg.enabled) return { sent: 0 };
  const gmailConnectionId = parseEmailConfig(settings.email).gmailConnectionId ?? null;
  const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";

  const events = await listStageEventsToNotify(tenantId, { stages: cfg.notifyStages, sinceMs: LOOKBACK_MS, now });
  let sent = 0;
  for (const ev of events) {
    const copy = homeownerStageCopy(ev.toStage);
    const link = `${base}/status/${signPayloadToken({ tenantId, jobId: ev.jobId }, secret)}`;
    const body = `${copy.headline} ${copy.body} Track your project: ${link}`;
    // SMS
    if (ev.phone && !ev.smsOptOut) {
      try { await sms.sendSms({ to: ev.phone, from: smsFrom(), body }); } catch { /* fail-soft */ }
      await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, customerId: ev.customerId, channel: "sms", direction: "outbound", to: ev.phone, body, aiHandled: false }));
    }
    // Email
    if (ev.email && !ev.emailOptOut) {
      try { await getEmailSender({ gmailConnectionId }).sendEmail({ to: ev.email, from: process.env.EMAIL_FROM ?? "noreply@example.com", subject: copy.headline, html: `<p>${copy.body}</p><p><a href="${link}">Track your project</a></p>` }); } catch { /* fail-soft */ }
      await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, customerId: ev.customerId, channel: "email", direction: "outbound", to: ev.email, body, aiHandled: false }));
    }
    await markStageEventNotified(tenantId, ev.eventId);
    sent++;
  }
  return { sent };
}

export const homeownerNotify = inngest.createFunction(
  { id: "homeowner-notify", concurrency: { limit: 1 } },
  { cron: "TZ=America/Phoenix */15 * * * *" }, // every 15 min
  async ({ step }) => {
    const tenants = await step.run("list-tenants", async () => adminDb.select({ id: tenant.id }).from(tenant));
    let sent = 0;
    for (const t of tenants) {
      const r = await step.run(`notify-${t.id}`, () => evaluateTenantHomeownerNotifs(t.id, new Date()));
      sent += r.sent;
    }
    return { sent };
  },
);
```
**Register:** in `packages/agents/src/index.ts`, import `homeownerNotify` and add it to the `functions` array (and the re-export, matching the existing style, e.g. how `weatherReschedule` is wired).

- [ ] **Step 4: Run → pass.** Same command. Then `pnpm typecheck`.
- [ ] **Step 5: Commit** — `git add packages/agents/src && git commit -m "feat(agents): homeowner-notify cron sends milestone updates"`

---

## Task 4: Web — public status page (sonnet)

**Files:** Modify `apps/web/src/middleware.ts`; Create `apps/web/src/lib/homeowner-actions.ts` + `apps/web/src/app/status/[token]/page.tsx`.

- [ ] **Step 1: Allow the route** — in `apps/web/src/middleware.ts`, add `/^\/status\//` to the `PUBLIC` array (next to `/^\/book\//`).

- [ ] **Step 2: Server action** — `apps/web/src/lib/homeowner-actions.ts`:
```ts
"use server";
import { getHomeownerStatus, type HomeownerStatus } from "@savvy/db";
import { verifyPayloadToken, requireSecret } from "@savvy/core";

export async function getHomeownerStatusByToken(token: string): Promise<HomeownerStatus | { error: "invalid" }> {
  const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
  const payload = verifyPayloadToken<{ tenantId: string; jobId: string }>(token, secret);
  if (!payload?.tenantId || !payload?.jobId) return { error: "invalid" };
  const status = await getHomeownerStatus(payload.tenantId, payload.jobId);
  return status ?? { error: "invalid" };
}
```
(Confirm `HomeownerStatus` is exported from `@savvy/db` — add `type HomeownerStatus` to the homeowner lifecycle re-export in `packages/db/src/index.ts` if Task 2 didn't.)

- [ ] **Step 3: Page** — `apps/web/src/app/status/[token]/page.tsx` (mirror `book/[token]/page.tsx` structure):
```tsx
import { getHomeownerStatusByToken } from "@/lib/homeowner-actions";
import { buildHomeownerJourney, homeownerStageCopy } from "@savvy/core";

export const dynamic = "force-dynamic";

export default async function StatusPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const res = await getHomeownerStatusByToken(token);
  if ("error" in res) {
    return (
      <main className="mx-auto max-w-md p-8 text-center" data-testid="status-invalid">
        <h1 className="text-xl font-semibold">Link unavailable</h1>
        <p className="mt-2 text-muted-foreground">This status link is invalid or expired. Please contact us.</p>
      </main>
    );
  }
  const copy = homeownerStageCopy(res.currentStage);
  const journey = buildHomeownerJourney(res.currentStage);
  return (
    <main className="mx-auto max-w-md p-6" data-testid="status-page">
      <p className="text-sm text-muted-foreground">{res.companyName}</p>
      <h1 className="text-2xl font-semibold" data-testid="status-headline">{copy.headline}</h1>
      <p className="text-muted-foreground mb-1">{copy.body}</p>
      {res.address && <p className="text-sm text-muted-foreground mb-4">{res.address}</p>}

      {res.nextAppointment && (
        <div className="rounded-md border p-3 mb-4" data-testid="status-next-appt">
          <div className="text-xs uppercase text-muted-foreground">Next appointment</div>
          <div className="font-medium">{res.nextAppointment.type} — {new Date(res.nextAppointment.startsAt).toLocaleString()}</div>
        </div>
      )}

      <ol className="space-y-2" data-testid="status-journey">
        {journey.map((m) => (
          <li key={m.key} data-testid={`milestone-${m.key}`} data-status={m.status} className="flex items-center gap-2">
            <span>{m.status === "done" ? "✓" : m.status === "current" ? "→" : "○"}</span>
            <span className={m.status === "upcoming" ? "text-muted-foreground" : "font-medium"}>{m.label}</span>
          </li>
        ))}
      </ol>
    </main>
  );
}
```

- [ ] **Step 4: Typecheck.** `pnpm typecheck` (clean).
- [ ] **Step 5: Commit** — `git add apps/web/src/middleware.ts apps/web/src/lib/homeowner-actions.ts "apps/web/src/app/status/[token]/page.tsx" && git commit -m "feat(web): public homeowner status page at /status/[token]"`

---

## Task 5: e2e + docs + verification (sonnet)

**Files:** Create `apps/web/tests/e2e/homeowner-status.spec.ts`; Modify `docs/jobs-pipeline.md`.

- [ ] **Step 1: e2e** — `apps/web/tests/e2e/homeowner-status.spec.ts`. Seed a job + stage events + a future appt, build a token (same secret), GET `/status/<token>`, assert journey + appt render; and an invalid token shows the error.
```ts
/**
 * e2e: public homeowner status page (F). Seeds a job + stage events + a future
 * crew appt, signs a status token (UNSUBSCRIBE_SECRET, dev fallback in TEST_MODE),
 * and asserts /status/<token> renders the journey + next appointment. An invalid
 * token shows the friendly error.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, job, jobStageEvent, appointment } from "@savvy/db";
import { signPayloadToken } from "@savvy/core";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };
const SECRET = process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret";

test("homeowner status page renders the journey + next appointment", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [c] = await adminDb.insert(customer).values({ tenantId, name: `Homer ${stamp}`, email: `homer-${stamp}@e2e.test` }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Roof Ln` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  await adminDb.insert(jobStageEvent).values({ tenantId, jobId: j!.id, toStage: "approved", enteredAt: new Date(Date.now() - 86_400_000) });
  await adminDb.insert(jobStageEvent).values({ tenantId, jobId: j!.id, toStage: "production", enteredAt: new Date() });
  const future = new Date(Date.now() + 2 * 86_400_000);
  await adminDb.insert(appointment).values({ tenantId, jobId: j!.id, customerId: c!.id, type: "crew", status: "scheduled", startsAt: future, endsAt: new Date(future.getTime() + 3_600_000) });

  const token = signPayloadToken({ tenantId, jobId: j!.id }, SECRET);
  await page.goto(`/status/${token}`);
  await expect(page.getByTestId("status-page")).toBeVisible();
  await expect(page.getByTestId("status-headline")).toContainText("Installation underway");
  await expect(page.getByTestId("status-next-appt")).toContainText("crew");
  await expect(page.getByTestId("milestone-production")).toHaveAttribute("data-status", "current");
  await expect(page.getByTestId("milestone-approved")).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("milestone-complete")).toHaveAttribute("data-status", "upcoming");

  await page.goto("/status/garbage.token");
  await expect(page.getByTestId("status-invalid")).toBeVisible();
});
```

- [ ] **Step 2: Run the e2e** — from `apps/web`: `npx tsx tests/e2e/create-tenant.ts && export TEST_TENANT_ID=$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)") && ./node_modules/.bin/playwright test tests/e2e/homeowner-status.spec.ts` → PASS. (If Postgres down: `pnpm db:up && pnpm --filter @savvy/db db:migrate` first.)

- [ ] **Step 3: Docs** — add a "Homeowner journey (F)" section to `docs/jobs-pipeline.md`:
```markdown
### Homeowner journey (F)

Homeowners get a public, login-free **status page** at `/status/<token>` (token signed with
`UNSUBSCRIBE_SECRET`, payload `{tenantId, jobId}`) showing their job's journey timeline
(`buildHomeownerJourney`), next scheduled appointment, and a friendly current-status. They're driven
there by **milestone notifications**: a `homeowner-notify` cron (every 15 min) reads recent
(`entered_at >= now-2h`) un-notified `job_stage_event` rows whose `toStage` is in
`tenant.settings.homeowner.notifyStages` (default `approved`/`production`/`complete`), texts/emails the
homeowner via the comms gateways (respecting `smsOptOut`/`emailOptOut`, fail-soft), and stamps
`homeowner_notified_at` so it never double-sends. The cron off the event table (not the
`job/stage-changed` event, which misses user drags) catches every transition; the 2h window means no
historical spam on first deploy.
```

- [ ] **Step 4: Commit** — `git add "apps/web/tests/e2e/homeowner-status.spec.ts" docs/jobs-pipeline.md && git commit -m "test(e2e): homeowner status page + docs"`

- [ ] **Step 5: Full verification** — from the worktree root: `pnpm test && pnpm typecheck && pnpm lint` → all green (≥678 tests: 670 prior + new core/db/agents tests). (If db `ECONNREFUSED`: `pnpm db:up && pnpm --filter @savvy/db db:migrate`, re-run.)

---

## Self-Review notes
- **Coverage:** core (T1) · db marker+reads (T2) · cron (T3) · public page (T4) · e2e+docs (T5).
- **Type consistency:** `parseHomeownerConfig`/`homeownerStageCopy`/`buildHomeownerJourney` / `homeownerNotifiedAt`/`homeowner_notified_at` / `getHomeownerStatus`/`HomeownerStatus` / `listStageEventsToNotify`/`markStageEventNotified` / `evaluateTenantHomeownerNotifs` used identically.
- **Reliable trigger:** cron off `job_stage_event` (catches human+agent paths) + `homeowner_notified_at` marker (no double-send) + 2h window (no historical spam).
- **Public route:** `/status/` added to middleware; the action uses the token's tenantId, not getTenantId().
- **Opt-out + fail-soft** respected; migration is a 1-column add on the already-RLS'd `job_stage_event` (meta committed); cron registered, concurrency 1.
