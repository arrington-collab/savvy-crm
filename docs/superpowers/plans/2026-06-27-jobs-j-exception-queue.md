# Jobs J — Exception Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tenant-wide `/exceptions` worklist that unifies four "needs a human" signals — at-risk jobs, overdue invoices, missed appointments, overdue tasks — into one severity-sorted list, each item linking to where it's resolved.

**Architecture:** A pure `buildExceptionQueue(input)` in `@savvy/core` normalizes four typed input arrays into a sorted `ExceptionItem[]` plus counts. A web `exception-queries.ts` gathers the four vectors via `withTenant` (reusing `deriveJobHealth` exactly as `getBoard` does), and a server-component `/exceptions` page renders the list. A Sidebar nav entry exposes it.

**Tech Stack:** TypeScript, Next.js App Router (server components), Drizzle/Postgres (RLS), Vitest (core), Playwright (web e2e). Branches off `main`.

## Global Constraints

- **No schema change / no migration** — all four vectors read existing tables.
- **Tenant isolation:** every vector query runs inside `withTenant`; no new raw cross-tenant path.
- **Reuse job health:** mirror `getBoard` in `apps/web/src/lib/pipeline-queries.ts` (same `pastDue` subquery + `parseJobsConfig` + `deriveJobHealth`); do NOT re-implement health rules.
- **Agent-run errors are NOT in this queue** — they stay on the Command Center.
- **Pure logic in `@savvy/core`** (apps/web is NOT in the vitest workspace — the page is verified by Playwright e2e only). The `/exceptions` page is a **server component** (no client boundary; `Date` values render directly).
- **No `.js` extensions** in core/web source imports.
- Severity sort: `high` before `medium`, then `occurredAt` ascending, null `occurredAt` last.
- Definition of done: `pnpm test && pnpm typecheck && pnpm lint` green; PR off `main` via `gh pr create --base main`.

---

## File Structure

**Create:**
- `packages/core/src/exception-queue.ts` — types + `buildExceptionQueue`.
- `packages/core/src/exception-queue.test.ts` — unit tests.
- `apps/web/src/lib/exception-queries.ts` — gather the four vectors + build.
- `apps/web/src/app/(app)/exceptions/page.tsx` — the worklist page.
- `apps/web/tests/e2e/exceptions.spec.ts` — e2e.

**Modify:**
- `packages/core/src/index.ts` — append `export * from "./exception-queue"`.
- `apps/web/src/components/cockpit/Sidebar.tsx` — add the Exceptions nav entry.
- `docs/jobs-pipeline.md` — Exception Queue note.

---

## Task 1: Core — `buildExceptionQueue`

**Files:**
- Create: `packages/core/src/exception-queue.ts`
- Test: `packages/core/src/exception-queue.test.ts`
- Modify: `packages/core/src/index.ts` (append export)

**Interfaces:**
- Produces:
  - `type ExceptionKind = "job_at_risk" | "invoice_overdue" | "appointment_missed" | "task_overdue"`
  - `type ExceptionSeverity = "high" | "medium"`
  - `type ExceptionItem = { kind: ExceptionKind; severity: ExceptionSeverity; title: string; detail: string; href: string; occurredAt: Date | null }`
  - `type ExceptionQueueInput = { atRiskJobs: AtRiskJobInput[]; overdueInvoices: OverdueInvoiceInput[]; missedAppointments: MissedAppointmentInput[]; overdueTasks: OverdueTaskInput[] }` (member shapes below)
  - `type ExceptionQueue = { items: ExceptionItem[]; counts: Record<ExceptionKind, number>; total: number; highCount: number }`
  - `buildExceptionQueue(input: ExceptionQueueInput): ExceptionQueue`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/exception-queue.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildExceptionQueue, type ExceptionQueueInput } from "./exception-queue";

const base: ExceptionQueueInput = { atRiskJobs: [], overdueInvoices: [], missedAppointments: [], overdueTasks: [] };

describe("buildExceptionQueue", () => {
  it("normalizes each vector into an item with the right kind/severity/href", () => {
    const q = buildExceptionQueue({
      atRiskJobs: [{ jobId: "j1", customerName: "Ann", stuck: true, late: false, reasons: ["14d in production"], stageEnteredAt: new Date("2026-06-01T00:00:00Z") }],
      overdueInvoices: [{ invoiceId: "i1", jobId: "j2", customerName: "Bob", amountDueCents: 250000, dueAt: new Date("2026-06-10T00:00:00Z") }],
      missedAppointments: [{ appointmentId: "a1", jobId: "j3", apptType: "crew", status: "no_show", startsAt: new Date("2026-06-20T00:00:00Z"), customerName: "Cy" }],
      overdueTasks: [{ taskId: "t1", jobId: "j4", title: "Order materials", customerName: "Di", dueAt: new Date("2026-06-25T00:00:00Z") }],
    });
    expect(q.total).toBe(4);
    expect(q.counts).toEqual({ job_at_risk: 1, invoice_overdue: 1, appointment_missed: 1, task_overdue: 1 });
    const job = q.items.find((i) => i.kind === "job_at_risk")!;
    expect(job).toMatchObject({ severity: "medium", title: "Ann", href: "/jobs/j1" });
    expect(job.detail).toContain("14d in production");
    expect(q.items.find((i) => i.kind === "invoice_overdue")!).toMatchObject({ severity: "high", href: "/invoices" });
    expect(q.items.find((i) => i.kind === "appointment_missed")!).toMatchObject({ severity: "high", href: "/schedule" });
    expect(q.items.find((i) => i.kind === "task_overdue")!).toMatchObject({ severity: "medium", href: "/jobs/j4" });
  });

  it("rates a late job high and a stuck-only job medium", () => {
    const q = buildExceptionQueue({
      ...base,
      atRiskJobs: [
        { jobId: "late", customerName: "L", stuck: false, late: true, reasons: ["past SLA"], stageEnteredAt: new Date("2026-06-01T00:00:00Z") },
        { jobId: "stuck", customerName: "S", stuck: true, late: false, reasons: ["stuck"], stageEnteredAt: new Date("2026-06-01T00:00:00Z") },
      ],
    });
    expect(q.items.find((i) => i.title === "L")!.severity).toBe("high");
    expect(q.items.find((i) => i.title === "S")!.severity).toBe("medium");
    expect(q.highCount).toBe(1);
  });

  it("sorts high before medium, then oldest occurredAt first", () => {
    const q = buildExceptionQueue({
      ...base,
      overdueInvoices: [
        { invoiceId: "new", jobId: "j", customerName: "New", amountDueCents: 100, dueAt: new Date("2026-06-26T00:00:00Z") },
        { invoiceId: "old", jobId: "j", customerName: "Old", amountDueCents: 100, dueAt: new Date("2026-06-01T00:00:00Z") },
      ],
      overdueTasks: [{ taskId: "t", jobId: "j", title: "x", customerName: "Task", dueAt: new Date("2026-06-15T00:00:00Z") }],
    });
    // both invoices are high (older first), task is medium (last)
    expect(q.items.map((i) => i.title)).toEqual(["Old", "New", "Task"]);
  });

  it("rates an overdue (not no_show) appointment medium", () => {
    const q = buildExceptionQueue({
      ...base,
      missedAppointments: [{ appointmentId: "a", jobId: "j", apptType: "inspection", status: "scheduled", startsAt: new Date("2026-06-20T00:00:00Z"), customerName: "Ov" }],
    });
    expect(q.items[0]!.severity).toBe("medium");
  });

  it("is empty for no input", () => {
    expect(buildExceptionQueue(base)).toEqual({
      items: [], counts: { job_at_risk: 0, invoice_overdue: 0, appointment_missed: 0, task_overdue: 0 }, total: 0, highCount: 0,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core exec vitest run src/exception-queue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/core/src/exception-queue.ts`:

```typescript
export type ExceptionKind = "job_at_risk" | "invoice_overdue" | "appointment_missed" | "task_overdue";
export type ExceptionSeverity = "high" | "medium";

export type ExceptionItem = {
  kind: ExceptionKind;
  severity: ExceptionSeverity;
  title: string;
  detail: string;
  href: string;
  occurredAt: Date | null;
};

export type AtRiskJobInput = { jobId: string; customerName: string | null; stuck: boolean; late: boolean; reasons: string[]; stageEnteredAt: Date };
export type OverdueInvoiceInput = { invoiceId: string; jobId: string | null; customerName: string | null; amountDueCents: number | null; dueAt: Date | null };
export type MissedAppointmentInput = { appointmentId: string; jobId: string; apptType: string; status: string; startsAt: Date; customerName: string | null };
export type OverdueTaskInput = { taskId: string; jobId: string; title: string; customerName: string | null; dueAt: Date | null };

export type ExceptionQueueInput = {
  atRiskJobs: AtRiskJobInput[];
  overdueInvoices: OverdueInvoiceInput[];
  missedAppointments: MissedAppointmentInput[];
  overdueTasks: OverdueTaskInput[];
};

export type ExceptionQueue = {
  items: ExceptionItem[];
  counts: Record<ExceptionKind, number>;
  total: number;
  highCount: number;
};

const KINDS: ExceptionKind[] = ["job_at_risk", "invoice_overdue", "appointment_missed", "task_overdue"];

function dollars(cents: number | null): string {
  return cents == null ? "" : `$${Math.round(cents / 100).toLocaleString()}`;
}

/** Normalize the four exception vectors into one severity-sorted worklist. Pure. */
export function buildExceptionQueue(input: ExceptionQueueInput): ExceptionQueue {
  const items: ExceptionItem[] = [];

  for (const j of input.atRiskJobs) {
    items.push({
      kind: "job_at_risk",
      severity: j.late ? "high" : "medium",
      title: j.customerName ?? "—",
      detail: j.reasons.length ? j.reasons.join("; ") : j.late ? "Late" : "Stuck",
      href: `/jobs/${j.jobId}`,
      occurredAt: j.stageEnteredAt,
    });
  }
  for (const inv of input.overdueInvoices) {
    const amt = dollars(inv.amountDueCents);
    items.push({
      kind: "invoice_overdue",
      severity: "high",
      title: inv.customerName ?? "—",
      detail: amt ? `Invoice overdue · ${amt}` : "Invoice overdue",
      href: "/invoices",
      occurredAt: inv.dueAt,
    });
  }
  for (const a of input.missedAppointments) {
    const missed = a.status === "no_show";
    items.push({
      kind: "appointment_missed",
      severity: missed ? "high" : "medium",
      title: a.customerName ?? "—",
      detail: `${a.apptType} ${missed ? "no-show" : "overdue"}`,
      href: "/schedule",
      occurredAt: a.startsAt,
    });
  }
  for (const t of input.overdueTasks) {
    items.push({
      kind: "task_overdue",
      severity: "medium",
      title: t.customerName ?? "—",
      detail: `Task overdue: ${t.title}`,
      href: `/jobs/${t.jobId}`,
      occurredAt: t.dueAt,
    });
  }

  const sevRank = (s: ExceptionSeverity) => (s === "high" ? 0 : 1);
  items.sort((a, b) => {
    const s = sevRank(a.severity) - sevRank(b.severity);
    if (s !== 0) return s;
    const at = a.occurredAt ? a.occurredAt.getTime() : Infinity;
    const bt = b.occurredAt ? b.occurredAt.getTime() : Infinity;
    return at - bt;
  });

  const counts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<ExceptionKind, number>;
  for (const i of items) counts[i.kind] += 1;

  return { items, counts, total: items.length, highCount: items.filter((i) => i.severity === "high").length };
}
```

- [ ] **Step 4: Append the export**

In `packages/core/src/index.ts`, add at the end: `export * from "./exception-queue";`

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @savvy/core exec vitest run src/exception-queue.test.ts` → PASS.
Run: `pnpm --filter @savvy/core typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/exception-queue.ts packages/core/src/exception-queue.test.ts packages/core/src/index.ts
git commit -m "feat(core): buildExceptionQueue (unified needs-you worklist)"
```

---

## Task 2: Web — exception query, `/exceptions` page, nav, e2e

**Files:**
- Create: `apps/web/src/lib/exception-queries.ts`, `apps/web/src/app/(app)/exceptions/page.tsx`, `apps/web/tests/e2e/exceptions.spec.ts`
- Modify: `apps/web/src/components/cockpit/Sidebar.tsx`

**Interfaces:**
- Consumes: `buildExceptionQueue`, `parseJobsConfig`, `deriveJobHealth`, types from `@savvy/core`; `@savvy/db` (`withTenant`, `job`, `invoice`, `appointment`, `jobTask`, `customer`, `tenant`, `eq`, `and`, `or`, `sql`, `inArray`); `getTenantId`.
- Produces: `getExceptionQueue()` server query; the page; the nav entry.

- [ ] **Step 1: Build the query module**

Create `apps/web/src/lib/exception-queries.ts`. Mirror the health computation in `apps/web/src/lib/pipeline-queries.ts` (`getBoard`) for the jobs vector, and use plain `withTenant` selects for the other three:

```typescript
import "server-only";
import { withTenant, job, invoice, appointment, jobTask, customer, property, tenant, eq, and, or, sql } from "@savvy/db";
import { parseJobsConfig, deriveJobHealth, buildExceptionQueue, type JobStage, type JobType, type ExceptionQueue } from "@savvy/core";
import { getTenantId } from "./tenant";

export async function getExceptionQueue(): Promise<ExceptionQueue> {
  const tenantId = await getTenantId();
  return withTenant(tenantId, async (tx) => {
    // --- jobs (mirror getBoard's health inputs) ---
    const jobRows = await tx
      .select({
        id: job.id, stage: job.stage, type: job.type, stageEnteredAt: job.stageEnteredAt,
        customerName: customer.name,
        approvedAt: sql<string | null>`(select entered_at from job_stage_event where job_id = ${job.id} and to_stage = 'approved' order by entered_at asc limit 1)`,
        pastDue: sql<boolean>`exists (select 1 from invoice where job_id = ${job.id} and status in ('sent','overdue') and due_at is not null and due_at < now() and coalesce(amount_paid,0) < coalesce(amount_due,0))`,
      })
      .from(job)
      .leftJoin(customer, eq(customer.id, job.customerId));

    const [t] = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
    const config = parseJobsConfig((t?.settings as { jobs?: unknown } | undefined)?.jobs);
    const now = new Date();

    const atRiskJobs = jobRows
      .map((r) => {
        const health = deriveJobHealth(
          { stage: r.stage as JobStage, stageEnteredAt: new Date(r.stageEnteredAt as unknown as string), type: r.type as JobType, approvedAt: r.approvedAt ? new Date(r.approvedAt) : null, hasPastDueInvoice: !!r.pastDue },
          config, now,
        );
        return { jobId: r.id, customerName: r.customerName, stuck: health.stuck, late: health.late, reasons: health.reasons, stageEnteredAt: new Date(r.stageEnteredAt as unknown as string), health };
      })
      .filter((r) => r.health.stuck || r.health.late)
      .map(({ health: _h, ...rest }) => rest);

    // --- overdue invoices ---
    const invRows = await tx
      .select({ id: invoice.id, jobId: invoice.jobId, amountDue: invoice.amountDue, dueAt: invoice.dueAt, customerName: customer.name })
      .from(invoice)
      .leftJoin(customer, eq(customer.id, invoice.customerId))
      .where(or(
        eq(invoice.status, "overdue"),
        sql`${invoice.status} = 'sent' and ${invoice.dueAt} is not null and ${invoice.dueAt} < now() and coalesce(${invoice.amountPaid},0) < coalesce(${invoice.amountDue},0)`,
      ));
    const overdueInvoices = invRows.map((r) => ({ invoiceId: r.id, jobId: r.jobId, customerName: r.customerName, amountDueCents: r.amountDue, dueAt: r.dueAt }));

    // --- missed / overdue appointments ---
    const apptRows = await tx
      .select({ id: appointment.id, jobId: appointment.jobId, type: appointment.type, status: appointment.status, startsAt: appointment.startsAt, customerName: customer.name })
      .from(appointment)
      .leftJoin(customer, eq(customer.id, appointment.customerId))
      .where(or(
        eq(appointment.status, "no_show"),
        sql`${appointment.status} = 'scheduled' and ${appointment.startsAt} < now()`,
      ));
    const missedAppointments = apptRows.map((r) => ({ appointmentId: r.id, jobId: r.jobId, apptType: r.type, status: r.status, startsAt: r.startsAt, customerName: r.customerName }));

    // --- overdue tasks ---
    const taskRows = await tx
      .select({ id: jobTask.id, jobId: jobTask.jobId, title: jobTask.title, dueAt: jobTask.dueAt, customerName: customer.name })
      .from(jobTask)
      .leftJoin(job, eq(job.id, jobTask.jobId))
      .leftJoin(customer, eq(customer.id, job.customerId))
      .where(sql`${jobTask.dueAt} is not null and ${jobTask.dueAt} < now() and ${jobTask.status} not in ('done','skipped')`);
    const overdueTasks = taskRows.map((r) => ({ taskId: r.id, jobId: r.jobId, title: r.title, customerName: r.customerName, dueAt: r.dueAt }));

    return buildExceptionQueue({ atRiskJobs, overdueInvoices, missedAppointments, overdueTasks });
  });
}
```

Note: if `or`/`property` is unused, drop it from the import to keep lint clean. Verify `property` is not needed (it isn't here) and remove it.

- [ ] **Step 2: Build the page**

Create `apps/web/src/app/(app)/exceptions/page.tsx` as a server component (mirror the structure of `apps/web/src/app/(app)/command-center/page.tsx` for the page shell, Card usage, and dark-mode tokens):

```tsx
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import Link from "next/link";
import { getExceptionQueue } from "@/lib/exception-queries";

const KIND_LABEL: Record<string, string> = {
  job_at_risk: "Job at risk",
  invoice_overdue: "Invoice overdue",
  appointment_missed: "Appointment",
  task_overdue: "Task overdue",
};

export default async function ExceptionsPage() {
  const queue = await getExceptionQueue();
  return (
    <div className="space-y-6" data-testid="exceptions-page">
      <div className="flex items-end justify-between">
        <h1 className="text-2xl font-semibold">Exceptions</h1>
        <div className="text-right">
          <div className="mono text-2xl font-semibold text-accent-gold" data-testid="exceptions-total">{queue.total}</div>
          <div className="text-xs" style={{ color: "var(--text-faint)" }}>
            {queue.highCount} high priority
          </div>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle>Needs you</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {queue.items.length === 0 && (
            <p className="text-sm" style={{ color: "var(--text-faint)" }} data-testid="exceptions-empty">
              Nothing needs you right now. The agents have it.
            </p>
          )}
          {queue.items.map((item, i) => (
            <Link
              key={`${item.kind}-${i}`}
              href={item.href}
              className="block rounded-md border border-border px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
              data-testid="exception-row"
              data-severity={item.severity}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: item.severity === "high" ? "var(--color-destructive, #dc2626)" : "var(--accent-gold)" }}
                  />
                  <span style={{ color: "var(--text-muted)" }}>{KIND_LABEL[item.kind] ?? item.kind}</span>
                  <span className="font-medium">{item.title}</span>
                </span>
                <span className="mono text-xs" style={{ color: "var(--text-faint)" }}>{item.detail}</span>
              </div>
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Add the nav entry**

In `apps/web/src/components/cockpit/Sidebar.tsx`, add to the `NAV` array immediately after the `command-center` entry:

```typescript
  { href: "/exceptions", label: "Exceptions" },
```

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm --filter web typecheck && pnpm --filter web lint`
Expected: clean / no new errors (remove any unused import, e.g. `property`/`and`/`inArray` if not used).

- [ ] **Step 5: Write the e2e**

Create `apps/web/tests/e2e/exceptions.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, job, invoice, appointment, jobTask } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("exceptions queue lists at-risk job, overdue invoice, missed appt, overdue task", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [cust] = await adminDb.insert(customer).values({ tenantId, name: `Exc ${stamp}`, email: `exc-${stamp}@e2e.test` }).returning();
  const [prop] = await adminDb.insert(property).values({ tenantId, customerId: cust!.id, address: `${stamp} Exc Way` }).returning();
  // Stuck job: in production well past the 14d threshold.
  const longAgo = new Date(Date.now() - 30 * 86_400_000);
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "production", stageEnteredAt: longAgo }).returning();
  const jobId = j!.id;
  const past = new Date(Date.now() - 5 * 86_400_000);
  await adminDb.insert(invoice).values({ tenantId, jobId, customerId: cust!.id, status: "overdue", amountDue: 250000, dueAt: past });
  await adminDb.insert(appointment).values({ tenantId, jobId, customerId: cust!.id, type: "crew", status: "no_show", startsAt: past, endsAt: new Date(past.getTime() + 3_600_000) });
  await adminDb.insert(jobTask).values({ tenantId, jobId, key: "x", title: "Order materials", status: "pending", dueAt: past });

  await page.goto(`/exceptions`);
  await expect(page.getByTestId("exceptions-page")).toBeVisible();
  // At least our four seeded exceptions are present (other tenants' rows may add more — assert >= 4 of ours by detail text).
  await expect(page.getByTestId("exception-row").filter({ hasText: `Exc ${stamp}` })).toHaveCount(4);
  await expect(page.getByTestId("exception-row").filter({ hasText: "Invoice overdue" }).first()).toBeVisible();
});
```

- [ ] **Step 6: Run the e2e**

Setup: `pnpm db:up && pnpm --filter @savvy/db db:migrate`, then from `apps/web`:
```bash
npx tsx tests/e2e/create-tenant.ts
export TEST_TENANT_ID=$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)")
./node_modules/.bin/playwright test tests/e2e/exceptions.spec.ts
```
Expected: PASS (4 rows for this customer). If a browser needs installing: `npx playwright install chromium`. Make it pass for REAL — don't weaken; if blocked, report with the failure.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/exception-queries.ts "apps/web/src/app/(app)/exceptions/page.tsx" apps/web/src/components/cockpit/Sidebar.tsx apps/web/tests/e2e/exceptions.spec.ts
git commit -m "feat(web): /exceptions queue (at-risk jobs, overdue invoices/appts/tasks) + nav"
```

---

## Task 3: Docs + full verification

**Files:**
- Modify: `docs/jobs-pipeline.md`

- [ ] **Step 1: Document the queue**

Append to `docs/jobs-pipeline.md`:

```markdown
## Exception Queue (Jobs J)

`/exceptions` is the tenant-wide "needs you" worklist. It unifies four signals
that need a human, sorted by severity (high → medium) then oldest first:

- **Job at risk** — `deriveJobHealth` reports `stuck` (past the stage threshold)
  or `late` (past the build SLA or a past-due invoice). `late` is high.
- **Invoice overdue** — `status='overdue'`, or `sent` with a past `due_at` and a
  remaining balance. High.
- **Appointment missed** — `no_show` (high) or a `scheduled` appointment whose
  `starts_at` has passed (medium).
- **Task overdue** — a `job_task` past its `due_at` that isn't `done`/`skipped`.
  Medium.

Agent-run errors are intentionally NOT here — those are automation health and
live on the Command Center. Logic: `buildExceptionQueue` in `@savvy/core`;
the page reuses `deriveJobHealth` exactly as the Jobs board does.
```

- [ ] **Step 2: Full suite**

Run: `pnpm test` → all green (core cases added).

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint` → typecheck clean; lint 0 errors.

- [ ] **Step 4: Commit + PR**

```bash
git add docs/jobs-pipeline.md
git commit -m "docs(jobs): document the Exception Queue (J)"
git push -u origin jobs-j
gh pr create --base main --title "feat(jobs): J — Exception Queue (tenant-wide needs-you worklist)" --body "<summary>"
```

---

## Self-Review notes

- **Spec coverage:** four vectors → Task 1 (`buildExceptionQueue` maps all four) + Task 2 (query gathers all four). Severity + sort → Task 1. Page + nav → Task 2. Agent errors excluded → honored (not queried). No schema change → confirmed (no db task).
- **Reuse:** job health reuses `deriveJobHealth` + the exact `pastDue`/`approvedAt` subqueries from `getBoard`; no re-implementation. Core function is the only new logic and it's pure + tested.
- **Type consistency:** `ExceptionQueueInput` member shapes defined in Task 1 are produced verbatim by the Task 2 query mappers (`atRiskJobs`/`overdueInvoices`/`missedAppointments`/`overdueTasks`).
- **Server-component page:** no client boundary, so `Date occurredAt` renders directly; no serialization needed.
- **Test tier:** pure logic in core (vitest); page verified by e2e only.
