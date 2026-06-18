# Leads Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the styled-stub `/leads` page with a real, data-backed funnel — sortable lead list, lead creation, per-lead detail, and status-gated actions (convert to job, assign owner, mark lost).

**Architecture:** Server-first. List and detail are `force-dynamic` server components reading through thin tenant-scoped lib queries; filtering/sorting are URL search params. Mutations are `"use server"` actions that wrap `@savvy/db` lifecycle helpers inside `withTenant` and `revalidatePath`. Only the lead form and the action bar are client components. Mirrors `jobs/page.tsx`, `job-actions.ts`, and `invoices/new/NewInvoiceForm.tsx`.

**Tech Stack:** Next.js 16 (App Router, Turbopack), TypeScript, Tailwind v4 + shadcn, Drizzle/Postgres (RLS via `withTenant`), Inngest, vitest (packages), Playwright (apps/web e2e).

**Spec:** `docs/superpowers/specs/2026-06-17-leads-page-design.md`

---

## Conventions (read before starting)

- **Branch:** work on `feat/leads-page` (already created off `origin/main`, spec already committed there).
- **Import extensions:** `packages/db` **source** files import WITHOUT `.js` (e.g. `../schema/index`); `packages/db` **test** files import WITH `.js` (e.g. `./leads.js`). `apps/web` source uses NO `.js` on relative imports (Turbopack).
- **DB env for tests/dev:**
  ```bash
  export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
  export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
  ```
- **`@savvy/db` re-exports** all schema tables (`lead`, `customer`, `property`, `user`, `communication`, …) and operators (`eq, and, or, sql, count, desc, asc, isNull, …`). Import them from `@savvy/db`, never `drizzle-orm` directly.
- **apps/web is Playwright-only** (vitest workspace = `["packages/*"]` excludes it). Keep lib query/action helpers thin and untested by unit tests — they're covered by `leads.spec.ts`. Put unit-tested logic in `@savvy/db`.
- **`noUncheckedIndexedAccess` is ON** — index access yields `T | undefined`; use `!` only where provably present (matches existing code).
- **React-compiler lint:** no synchronous `setState` inside `useEffect`. We use event handlers + `useTransition`, so this won't bite.

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/db/src/lifecycle/leads.ts` | `setLeadOwner` / `setLeadLost` tx-helpers (caller wraps `withTenant`). |
| `packages/db/src/lifecycle/leads.test.ts` | Integration tests for the two helpers. |
| `packages/db/src/index.ts` | Barrel — add the two helper exports. |
| `apps/web/src/components/cockpit/StatusBadge.tsx` | Add lead-status color tones. |
| `apps/web/src/lib/agents.ts` | Add `leadStatusPersona(status)`. |
| `apps/web/src/lib/leads-queries.ts` | `getLeads` / `getLeadFunnelCounts` / `getLeadDetail`. |
| `apps/web/src/lib/lead-actions.ts` | `createLead` / `convertLead` / `assignLeadOwner` / `markLeadLost`. |
| `apps/web/src/lib/intake.ts` | Make the post-insert `inngest.send` resilient. |
| `apps/web/src/app/(app)/leads/page.tsx` | List: funnel strip + sortable list. |
| `apps/web/src/app/(app)/leads/new/page.tsx` | Hosts the form. |
| `apps/web/src/app/(app)/leads/new/NewLeadForm.tsx` | Client lead-creation form. |
| `apps/web/src/app/(app)/leads/[id]/page.tsx` | Lead detail. |
| `apps/web/src/components/leads/LeadActions.tsx` | Client action bar (status-gated). |
| `apps/web/tests/e2e/leads.spec.ts` | Playwright coverage. |

---

## Task 1: DB lifecycle helpers (`setLeadOwner`, `setLeadLost`)

**Files:**
- Create: `packages/db/src/lifecycle/leads.ts`
- Create: `packages/db/src/lifecycle/leads.test.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/lifecycle/leads.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "../admin-client.js";
import { withTenant } from "../tenant.js";
import { lead, customer, property, user, tenant } from "../schema/index.js";
import { setLeadOwner, setLeadLost } from "./leads.js";

async function seedTenantWithLead() {
  const [t] = await adminDb.insert(tenant).values({
    name: "Leads",
    publicKey: `pk-${crypto.randomUUID()}`,
    clerkOrgId: `org-${crypto.randomUUID()}`,
  }).returning();
  const out = await withTenant(t!.id, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId: t!.id, name: "Lead Lou" }).returning();
    const [p] = await tx.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "1 Lead Ln" }).returning();
    const [l] = await tx.insert(lead).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, status: "new" }).returning();
    const [u] = await tx.insert(user).values({ tenantId: t!.id, name: "Rep Rae", email: `rae-${crypto.randomUUID()}@x.com` }).returning();
    return { leadId: l!.id, userId: u!.id };
  });
  return { tenantId: t!.id, ...out };
}

describe("setLeadOwner / setLeadLost", () => {
  it("assigns then clears an owner", async () => {
    const { tenantId, leadId, userId } = await seedTenantWithLead();
    await withTenant(tenantId, (tx) => setLeadOwner(tx, { tenantId, leadId, userId }));
    let [row] = await withTenant(tenantId, (tx) => tx.select().from(lead).where(eq(lead.id, leadId)));
    expect(row!.assignedUserId).toBe(userId);
    await withTenant(tenantId, (tx) => setLeadOwner(tx, { tenantId, leadId, userId: null }));
    [row] = await withTenant(tenantId, (tx) => tx.select().from(lead).where(eq(lead.id, leadId)));
    expect(row!.assignedUserId).toBeNull();
  });

  it("rejects a cross-tenant user", async () => {
    const a = await seedTenantWithLead();
    const b = await seedTenantWithLead();
    await expect(
      withTenant(a.tenantId, (tx) => setLeadOwner(tx, { tenantId: a.tenantId, leadId: a.leadId, userId: b.userId })),
    ).rejects.toThrow();
  });

  it("marks a lead lost, idempotently", async () => {
    const { tenantId, leadId } = await seedTenantWithLead();
    await withTenant(tenantId, (tx) => setLeadLost(tx, { tenantId, leadId }));
    let [row] = await withTenant(tenantId, (tx) => tx.select().from(lead).where(eq(lead.id, leadId)));
    expect(row!.status).toBe("lost");
    await withTenant(tenantId, (tx) => setLeadLost(tx, { tenantId, leadId }));
    [row] = await withTenant(tenantId, (tx) => tx.select().from(lead).where(eq(lead.id, leadId)));
    expect(row!.status).toBe("lost");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @savvy/db exec vitest run src/lifecycle/leads.test.ts
```
Expected: FAIL — `Cannot find module './leads.js'` (helper file not created yet).

- [ ] **Step 3: Write the helper**

Create `packages/db/src/lifecycle/leads.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { lead, user } from "../schema/index";
import { db } from "../client";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Sets (or clears, when userId is null) the lead's owner. Validates that a
 * non-null user belongs to the tenant; throws otherwise. Idempotent.
 */
export async function setLeadOwner(
  tx: Tx,
  opts: { tenantId: string; leadId: string; userId: string | null },
): Promise<void> {
  if (opts.userId !== null) {
    const [u] = await tx
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.id, opts.userId), eq(user.tenantId, opts.tenantId)));
    if (!u) throw new Error("user not in tenant");
  }
  await tx
    .update(lead)
    .set({ assignedUserId: opts.userId })
    .where(and(eq(lead.id, opts.leadId), eq(lead.tenantId, opts.tenantId)));
}

/** Marks the lead lost (status='lost'). No-op if already lost. */
export async function setLeadLost(
  tx: Tx,
  opts: { tenantId: string; leadId: string },
): Promise<void> {
  await tx
    .update(lead)
    .set({ status: "lost" })
    .where(and(eq(lead.id, opts.leadId), eq(lead.tenantId, opts.tenantId)));
}
```

- [ ] **Step 4: Export from the barrel**

In `packages/db/src/index.ts`, add this line directly after the `export { stopDripEnrollments } from "./lifecycle/stop-drip";` line:

```ts
export { setLeadOwner, setLeadLost } from "./lifecycle/leads";
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @savvy/db exec vitest run src/lifecycle/leads.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/leads.ts packages/db/src/lifecycle/leads.test.ts packages/db/src/index.ts
git commit -m "feat(db): setLeadOwner + setLeadLost lifecycle helpers"
```

---

## Task 2: StatusBadge — lead status tones

**Files:**
- Modify: `apps/web/src/components/cockpit/StatusBadge.tsx`

- [ ] **Step 1: Add lead-status entries to `STATUS_TONE`**

In `STATUS_TONE`, add this block before the closing `};` (all referenced vars are already used in this file):

```ts
  // lead funnel
  new: "var(--text-faint)", contacted: "var(--accent-gold)", qualified: "var(--accent-gold)",
  booked: "var(--status-ok)", won: "var(--status-ok)", lost: "var(--status-error)",
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @savvy/web typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/cockpit/StatusBadge.tsx
git commit -m "feat(web): lead status tones on StatusBadge"
```

---

## Task 3: Lead persona helper

**Files:**
- Modify: `apps/web/src/lib/agents.ts`

- [ ] **Step 1: Add `leadStatusPersona`**

Append to `apps/web/src/lib/agents.ts` (uses the existing `PERSONAS` map and `Persona` type already defined in this file):

```ts
/**
 * Presentation persona for a lead's funnel status (NOT a real agent_run lookup —
 * agent_run has no lead linkage yet). ATLAS hunts the early funnel; SAGE closes.
 */
export function leadStatusPersona(status: string): { persona: Persona; dimmed: boolean } {
  if (status === "won") return { persona: PERSONAS.SAGE, dimmed: false };
  if (status === "lost") return { persona: PERSONAS.ATLAS, dimmed: true };
  return { persona: PERSONAS.ATLAS, dimmed: false }; // new | contacted | qualified | booked
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @savvy/web typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/agents.ts
git commit -m "feat(web): leadStatusPersona helper"
```

---

## Task 4: Lead queries

**Files:**
- Create: `apps/web/src/lib/leads-queries.ts`

- [ ] **Step 1: Write the query module**

Create `apps/web/src/lib/leads-queries.ts`:

```ts
import { withTenant, lead, customer, property, user, communication, eq, desc, sql } from "@savvy/db";
import { LEAD_STATUS, type LeadStatus } from "@savvy/core";
import { getTenantId } from "./tenant";

export type LeadListRow = {
  id: string;
  status: string;
  score: number | null;
  source: string | null;
  customerName: string | null;
  address: string | null;
  createdAt: Date;
};

export async function getLeads(
  opts: { status?: LeadStatus; sort?: "score" | "age" } = {},
): Promise<LeadListRow[]> {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx
      .select({
        id: lead.id,
        status: lead.status,
        score: lead.score,
        source: lead.source,
        customerName: customer.name,
        address: property.address,
        createdAt: lead.createdAt,
      })
      .from(lead)
      .leftJoin(customer, eq(customer.id, lead.customerId))
      .leftJoin(property, eq(property.id, lead.propertyId))
      .where(opts.status ? eq(lead.status, opts.status) : undefined)
      .orderBy(
        ...(opts.sort === "age"
          ? [desc(lead.createdAt)]
          : [sql`${lead.score} desc nulls last`, desc(lead.createdAt)]),
      ),
  );
}

export async function getLeadFunnelCounts(): Promise<Record<LeadStatus, number>> {
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({ status: lead.status, n: sql<number>`count(*)::int` }).from(lead).groupBy(lead.status),
  );
  const out = Object.fromEntries(LEAD_STATUS.map((s) => [s, 0])) as Record<LeadStatus, number>;
  for (const r of rows) out[r.status as LeadStatus] = r.n;
  return out;
}

export type LeadComm = {
  id: string;
  channel: string;
  direction: string;
  body: string | null;
  createdAt: Date;
};

export type LeadDetail = {
  id: string;
  status: string;
  score: number | null;
  scoreReason: string | null;
  source: string | null;
  customerName: string | null;
  address: string | null;
  assignedUserId: string | null;
  ownerName: string | null;
  communications: LeadComm[];
};

export async function getLeadDetail(id: string): Promise<LeadDetail | null> {
  const tenantId = await getTenantId();
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: lead.id,
        status: lead.status,
        score: lead.score,
        scoreReason: lead.scoreReason,
        source: lead.source,
        customerId: lead.customerId,
        customerName: customer.name,
        address: property.address,
        assignedUserId: lead.assignedUserId,
        ownerName: user.name,
      })
      .from(lead)
      .leftJoin(customer, eq(customer.id, lead.customerId))
      .leftJoin(property, eq(property.id, lead.propertyId))
      .leftJoin(user, eq(user.id, lead.assignedUserId))
      .where(eq(lead.id, id))
      .limit(1);
    if (!row) return null;
    const communications: LeadComm[] = row.customerId
      ? await tx
          .select({
            id: communication.id,
            channel: communication.channel,
            direction: communication.direction,
            body: communication.body,
            createdAt: communication.createdAt,
          })
          .from(communication)
          .where(eq(communication.customerId, row.customerId))
          .orderBy(desc(communication.createdAt))
          .limit(20)
      : [];
    return {
      id: row.id,
      status: row.status,
      score: row.score,
      scoreReason: row.scoreReason,
      source: row.source,
      customerName: row.customerName,
      address: row.address,
      assignedUserId: row.assignedUserId,
      ownerName: row.ownerName,
      communications,
    };
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @savvy/web typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/leads-queries.ts
git commit -m "feat(web): lead queries (list, funnel counts, detail)"
```

---

## Task 5: Lead actions + resilient intake send

**Files:**
- Modify: `apps/web/src/lib/intake.ts`
- Create: `apps/web/src/lib/lead-actions.ts`

- [ ] **Step 1: Make `createLeadForTenant`'s send resilient**

In `apps/web/src/lib/intake.ts`, replace the post-insert send line:

```ts
  await inngest.send({ name: "lead/created", data: { leadId, tenantId } });
```

with:

```ts
  try {
    await inngest.send({ name: "lead/created", data: { leadId, tenantId } });
  } catch (err) {
    // Lead is already persisted; a missing Inngest engine must not fail creation.
    console.error("lead/created send failed (lead still created):", err);
  }
```

- [ ] **Step 2: Write the server actions**

Create `apps/web/src/lib/lead-actions.ts`:

```ts
"use server";
import { withTenant, convertLeadToJob, setLeadOwner, setLeadLost } from "@savvy/db";
import { leadIntakeSchema } from "@savvy/core";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";
import { createLeadForTenant } from "./intake";

export async function createLead(
  input: unknown,
): Promise<{ ok: true; leadId: string } | { error: string }> {
  const parsed = leadIntakeSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "invalid input" };
  const tenantId = await getTenantId();
  const leadId = await createLeadForTenant(tenantId, parsed.data);
  revalidatePath("/leads");
  return { ok: true, leadId };
}

export async function convertLead(
  leadId: string,
): Promise<{ ok: true; jobId: string } | { error: string }> {
  const tenantId = await getTenantId();
  try {
    const { jobId } = await convertLeadToJob({ tenantId, leadId });
    revalidatePath("/leads");
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/jobs");
    return { ok: true, jobId };
  } catch {
    return { error: "could not convert lead" };
  }
}

export async function assignLeadOwner(
  leadId: string,
  userId: string | null,
): Promise<{ ok: true } | { error: string }> {
  const tenantId = await getTenantId();
  try {
    await withTenant(tenantId, (tx) => setLeadOwner(tx, { tenantId, leadId, userId }));
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/leads");
    return { ok: true };
  } catch {
    return { error: "could not assign owner" };
  }
}

export async function markLeadLost(
  leadId: string,
): Promise<{ ok: true } | { error: string }> {
  const tenantId = await getTenantId();
  await withTenant(tenantId, (tx) => setLeadLost(tx, { tenantId, leadId }));
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  return { ok: true };
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @savvy/web typecheck
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/intake.ts apps/web/src/lib/lead-actions.ts
git commit -m "feat(web): lead server actions + resilient intake send"
```

---

## Task 6: List page (`/leads`)

**Files:**
- Modify (replace): `apps/web/src/app/(app)/leads/page.tsx`

- [ ] **Step 1: Replace the stub with the real list**

Overwrite `apps/web/src/app/(app)/leads/page.tsx`:

```tsx
import Link from "next/link";
import { getLeads, getLeadFunnelCounts } from "@/lib/leads-queries";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { MetricCard } from "@/components/cockpit/MetricCard";
import { StatusBadge } from "@/components/cockpit/StatusBadge";
import { AgentAvatar } from "@/components/cockpit/AgentAvatar";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ago } from "@/lib/format";
import { leadStatusPersona } from "@/lib/agents";
import { LEAD_STATUS, type LeadStatus } from "@savvy/core";

export const dynamic = "force-dynamic";

const COLS = "grid grid-cols-[56px_1fr_1fr_84px_104px_64px_40px] items-center gap-2";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; sort?: string }>;
}) {
  const sp = await searchParams;
  const status = LEAD_STATUS.includes(sp.status as LeadStatus) ? (sp.status as LeadStatus) : undefined;
  const sort: "score" | "age" = sp.sort === "age" ? "age" : "score";
  const [counts, leads] = await Promise.all([getLeadFunnelCounts(), getLeads({ status, sort })]);
  const total = LEAD_STATUS.reduce((n, s) => n + (counts[s] ?? 0), 0);
  const statusQs = status ? `&status=${status}` : "";

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Funnel"
        title="Leads"
        right={
          <Link href="/leads/new">
            <Button data-testid="new-lead">+ New Lead</Button>
          </Link>
        }
      />

      <div className="grid grid-cols-3 gap-3 sm:grid-cols-7" data-testid="funnel">
        <Link href="/leads">
          <MetricCard label="all" value={total} testId="funnel-all" />
        </Link>
        {LEAD_STATUS.map((s) => (
          <Link key={s} href={`/leads?status=${s}`}>
            <MetricCard label={s} value={counts[s] ?? 0} testId={`funnel-${s}`} />
          </Link>
        ))}
      </div>

      <Card className="overflow-hidden p-0">
        <div className={`${COLS} border-b border-white/10 px-4 py-2`}>
          <Link href={`/leads?sort=score${statusQs}`} className="eyebrow">score</Link>
          <span className="eyebrow">customer</span>
          <span className="eyebrow">address</span>
          <span className="eyebrow">source</span>
          <span className="eyebrow">status</span>
          <Link href={`/leads?sort=age${statusQs}`} className="eyebrow">age</Link>
          <span className="eyebrow">agent</span>
        </div>

        {leads.length === 0 ? (
          <div
            className="px-4 py-12 text-center text-sm"
            style={{ color: "var(--text-faint)" }}
            data-testid="leads-empty"
          >
            No leads yet.{" "}
            <Link href="/leads/new" className="underline">
              Add your first lead.
            </Link>
          </div>
        ) : (
          leads.map((l) => {
            const { persona, dimmed } = leadStatusPersona(l.status);
            return (
              <Link
                key={l.id}
                href={`/leads/${l.id}`}
                data-testid="lead-row"
                data-lead-id={l.id}
                className={`${COLS} border-b border-white/5 px-4 py-3 text-sm hover:bg-white/[0.03]`}
              >
                <span className="mono font-semibold" style={{ color: "var(--text-primary)" }}>
                  {l.score ?? "—"}
                </span>
                <span style={{ color: "var(--text-body)" }}>{l.customerName ?? "—"}</span>
                <span className="truncate" style={{ color: "var(--text-muted)" }}>{l.address ?? "—"}</span>
                <span className="mono text-xs" style={{ color: "var(--text-muted)" }}>{l.source ?? "—"}</span>
                <span><StatusBadge status={l.status} /></span>
                <span className="mono text-xs" style={{ color: "var(--text-muted)" }}>{ago(l.createdAt)}</span>
                <span><AgentAvatar persona={persona} size="sm" dimmed={dimmed} /></span>
              </Link>
            );
          })
        )}
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @savvy/web typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/leads/page.tsx"
git commit -m "feat(web): real leads list with funnel strip"
```

---

## Task 7: New lead page + form

**Files:**
- Create: `apps/web/src/app/(app)/leads/new/page.tsx`
- Create: `apps/web/src/app/(app)/leads/new/NewLeadForm.tsx`

- [ ] **Step 1: Create the client form**

Create `apps/web/src/app/(app)/leads/new/NewLeadForm.tsx`:

```tsx
"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createLead } from "@/lib/lead-actions";

export function NewLeadForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [source, setSource] = useState("manual");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const res = await createLead({ name, phone, address, source });
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success("Lead created");
      router.push(`/leads/${res.leadId}`);
    });
  }

  return (
    <Card className="max-w-lg p-6">
      <form onSubmit={submit} className="space-y-4" data-testid="new-lead-form">
        <div className="space-y-1.5">
          <Label htmlFor="name">Customer name</Label>
          <Input id="name" name="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone (E.164, e.g. +14805551234)</Label>
          <Input id="phone" name="phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1..." required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="address">Property address</Label>
          <Input id="address" name="address" value={address} onChange={(e) => setAddress(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="source">Source</Label>
          <Input id="source" name="source" value={source} onChange={(e) => setSource(e.target.value)} />
        </div>
        <Button type="submit" disabled={pending} data-testid="new-lead-submit">
          {pending ? "Creating…" : "Create lead"}
        </Button>
      </form>
    </Card>
  );
}
```

- [ ] **Step 2: Create the page**

Create `apps/web/src/app/(app)/leads/new/page.tsx`:

```tsx
import { PageHeader } from "@/components/cockpit/PageHeader";
import { NewLeadForm } from "./NewLeadForm";

export const dynamic = "force-dynamic";

export default function NewLeadPage() {
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Funnel" title="New Lead" />
      <NewLeadForm />
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @savvy/web typecheck
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/leads/new"
git commit -m "feat(web): new lead form"
```

---

## Task 8: Lead actions component (client)

**Files:**
- Create: `apps/web/src/components/leads/LeadActions.tsx`

- [ ] **Step 1: Create the action bar**

Create `apps/web/src/components/leads/LeadActions.tsx`:

```tsx
"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { convertLead, assignLeadOwner, markLeadLost } from "@/lib/lead-actions";

type U = { id: string; name: string };

export function LeadActions({
  leadId,
  status,
  users,
  ownerId,
}: {
  leadId: string;
  status: string;
  users: U[];
  ownerId: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [owner, setOwner] = useState(ownerId ?? "");

  const terminal = status === "won" || status === "lost";
  const canConvert = !terminal && status !== "booked";

  function doConvert() {
    start(async () => {
      const r = await convertLead(leadId);
      if ("error" in r) return void toast.error(r.error);
      toast.success("Converted to job");
      router.push(`/jobs/${r.jobId}`);
    });
  }

  function doAssign(userId: string) {
    setOwner(userId);
    start(async () => {
      const r = await assignLeadOwner(leadId, userId === "" ? null : userId);
      if ("error" in r) return void toast.error(r.error);
      toast.success("Owner updated");
      router.refresh();
    });
  }

  function doLost() {
    start(async () => {
      const r = await markLeadLost(leadId);
      if ("error" in r) return void toast.error(r.error);
      toast.success("Marked lost");
      router.refresh();
    });
  }

  if (terminal) {
    return (
      <p className="text-sm" style={{ color: "var(--text-faint)" }} data-testid="lead-actions-readonly">
        No actions — this lead is {status}.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="lead-actions">
      {canConvert && (
        <Button onClick={doConvert} disabled={pending} data-testid="convert-lead">
          Convert to Job
        </Button>
      )}
      <select
        value={owner}
        onChange={(e) => doAssign(e.target.value)}
        disabled={pending}
        data-testid="assign-owner"
        className="mono rounded-md border border-white/10 bg-transparent px-2 py-1.5 text-sm"
        style={{ color: "var(--text-body)" }}
      >
        <option value="">Unassigned</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
      <Button variant="outline" onClick={doLost} disabled={pending} data-testid="mark-lost">
        Mark lost
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @savvy/web typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/leads/LeadActions.tsx
git commit -m "feat(web): LeadActions client bar"
```

---

## Task 9: Detail page (`/leads/[id]`)

**Files:**
- Create: `apps/web/src/app/(app)/leads/[id]/page.tsx`

- [ ] **Step 1: Create the detail page**

Create `apps/web/src/app/(app)/leads/[id]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { getLeadDetail } from "@/lib/leads-queries";
import { listUsers } from "@/lib/scheduling-queries";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { StatusBadge } from "@/components/cockpit/StatusBadge";
import { AgentAvatar } from "@/components/cockpit/AgentAvatar";
import { Card } from "@/components/ui/card";
import { ago } from "@/lib/format";
import { resolveAgent } from "@/lib/agents";
import { LeadActions } from "@/components/leads/LeadActions";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [detail, users] = await Promise.all([getLeadDetail(id), listUsers()]);
  if (!detail) notFound();

  const qualifier = resolveAgent({ agent: "comms", taskKey: "lead.qualify" });

  return (
    <div className="space-y-6" data-testid="lead-detail">
      <PageHeader
        eyebrow="Lead"
        title={detail.customerName ?? "Lead"}
        right={<StatusBadge status={detail.status} />}
      />

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="p-4">
          <div className="eyebrow mb-1">AI score · ATLAS</div>
          <div className="text-3xl font-semibold" style={{ color: "var(--text-primary)" }} data-testid="lead-score">
            {detail.score ?? "—"}
          </div>
          <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
            {detail.scoreReason ?? "Not yet qualified."}
          </p>
        </Card>
        <Card className="p-4">
          <div className="eyebrow mb-1">Contact</div>
          <p className="text-sm" style={{ color: "var(--text-body)" }}>{detail.address ?? "—"}</p>
          <p className="mono mt-1 text-xs" style={{ color: "var(--text-muted)" }}>source: {detail.source ?? "—"}</p>
        </Card>
        <Card className="p-4">
          <div className="eyebrow mb-1">Owner</div>
          <p className="text-sm" style={{ color: "var(--text-body)" }} data-testid="lead-owner">
            {detail.ownerName ?? "Unassigned"}
          </p>
        </Card>
      </div>

      <LeadActions leadId={detail.id} status={detail.status} users={users} ownerId={detail.assignedUserId} />

      <Card className="p-4">
        <div className="eyebrow mb-3">Communications</div>
        {detail.communications.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>No communications yet.</p>
        ) : (
          <ul className="space-y-3">
            {detail.communications.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-sm">
                <AgentAvatar persona={qualifier.persona} size="sm" />
                <div>
                  <div className="mono text-xs" style={{ color: "var(--text-faint)" }}>
                    {c.channel} · {c.direction} · {ago(c.createdAt)}
                  </div>
                  <p style={{ color: "var(--text-body)" }}>{c.body ?? "—"}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @savvy/web typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/leads/[id]"
git commit -m "feat(web): lead detail page"
```

---

## Task 10: Playwright e2e

**Files:**
- Create: `apps/web/tests/e2e/leads.spec.ts`

- [ ] **Step 1: Write the spec**

Create `apps/web/tests/e2e/leads.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, withTenant, customer, property, lead, user, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

// Direct DB seed: does NOT emit lead/created, so seeded leads keep their status
// (a form-created lead would be auto-qualified new -> contacted by the agent).
async function seedLead(name: string, status: "new" | "contacted", score: number) {
  return withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name, phone: "+15555550000" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: `${name} St` }).returning();
    const [l] = await tx
      .insert(lead)
      .values({ tenantId, customerId: c!.id, propertyId: p!.id, status, score, source: "seed" })
      .returning();
    return l!.id;
  });
}

test("leads: list, filter, detail, convert, mark lost", async ({ page }) => {
  const newId = await seedLead("Funnel New", "new", 80);
  const contactedId = await seedLead("Funnel Contacted", "contacted", 60);

  // List shows both rows; funnel strip renders.
  await page.goto("/leads");
  await expect(page.getByTestId("funnel")).toBeVisible();
  await expect(page.locator(`[data-testid="lead-row"][data-lead-id="${newId}"]`)).toBeVisible();
  await expect(page.locator(`[data-testid="lead-row"][data-lead-id="${contactedId}"]`)).toBeVisible();

  // Filter to contacted: the 'new' lead drops out.
  await page.goto("/leads?status=contacted");
  await expect(page.locator(`[data-testid="lead-row"][data-lead-id="${contactedId}"]`)).toBeVisible();
  await expect(page.locator(`[data-testid="lead-row"][data-lead-id="${newId}"]`)).toHaveCount(0);

  // Detail of the 'new' lead shows its score.
  await page.goto(`/leads/${newId}`);
  await expect(page.getByTestId("lead-detail")).toBeVisible();
  await expect(page.getByTestId("lead-score")).toContainText("80");

  // Convert -> redirected to the job; lead becomes 'booked'.
  await page.getByTestId("convert-lead").click();
  await page.waitForURL(/\/jobs\/.+/);
  const [converted] = await withTenant(tenantId, (tx) => tx.select().from(lead).where(eq(lead.id, newId)));
  expect(converted!.status).toBe("booked");

  // Re-open: Convert is gone (booked), Assign remains.
  await page.goto(`/leads/${newId}`);
  await expect(page.getByTestId("convert-lead")).toHaveCount(0);
  await expect(page.getByTestId("assign-owner")).toBeVisible();

  // Mark the contacted lead lost -> read-only.
  await page.goto(`/leads/${contactedId}`);
  await page.getByTestId("mark-lost").click();
  await expect(page.getByTestId("lead-actions-readonly")).toBeVisible();
  const [lost] = await withTenant(tenantId, (tx) => tx.select().from(lead).where(eq(lead.id, contactedId)));
  expect(lost!.status).toBe("lost");
});

test("leads: create via form + assign owner", async ({ page }) => {
  // Seed a tenant user so the assign dropdown has an option.
  const userId = await withTenant(tenantId, async (tx) => {
    const [u] = await tx
      .insert(user)
      .values({ tenantId, name: "Rep Robin", email: `robin-${Date.now()}@x.com` })
      .returning();
    return u!.id;
  });

  // Create through the form.
  await page.goto("/leads/new");
  await page.fill('input[name="name"]', "Formed Fiona");
  await page.fill('input[name="phone"]', "+15555551212");
  await page.fill('input[name="address"]', "12 Form Ave");
  await page.getByTestId("new-lead-submit").click();
  await page.waitForURL(/\/leads\/[0-9a-f-]+$/);
  await expect(page.getByTestId("lead-detail")).toBeVisible();

  // Assign the seeded user; owner cell reflects it after refresh.
  await page.getByTestId("assign-owner").selectOption(userId);
  await expect(page.getByTestId("lead-owner")).toContainText("Rep Robin");
});
```

- [ ] **Step 2: Run the e2e (DB up via `docker compose up -d` first)**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
export AI_STUB_PORT=4010
node apps/web/tests/e2e/ai-stub.mjs &
npx --yes inngest-cli@latest dev -u http://localhost:3000/api/inngest --no-discovery &
sleep 5
pnpm --filter @savvy/web exec tsx tests/e2e/create-tenant.ts
export TEST_TENANT_ID="$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)")"
pnpm --filter @savvy/web exec playwright test leads
```
Expected: PASS (2 tests). Kill the background `ai-stub`/`inngest` processes afterward.

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/e2e/leads.spec.ts
git commit -m "test(web): leads e2e (list, filter, create, convert, lost, assign)"
```

---

## Task 11: Full gate + PR

- [ ] **Step 1: Run the full gate**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Expected: typecheck + lint clean (pre-existing warnings OK); all package vitest suites green (Task 1's 3 new tests included).

- [ ] **Step 2: Push and open the PR (base `main`)**

```bash
git push -u origin feat/leads-page
gh pr create --base main --title "feat: real leads page (list, detail, create, actions)" \
  --body "Replaces the /leads stub with a data-backed funnel: sortable list + funnel strip, /leads/new creation, /leads/[id] detail with comms timeline, and status-gated actions (convert to job, assign owner, mark lost). New @savvy/db helpers setLeadOwner/setLeadLost (integration-tested) + leads.spec.ts e2e. Spec: docs/superpowers/specs/2026-06-17-leads-page-design.md"
```

---

## Self-Review notes (resolved during planning)

- **Spec coverage:** list+funnel (T6) ✓, create (T5/T7) ✓, detail+timeline (T4/T9) ✓, actions convert/assign/lost (T1/T5/T8) ✓, db helpers + tests (T1) ✓, e2e (T10) ✓, status tones + persona (T2/T3) ✓.
- **Name collision avoided:** db helpers `setLeadOwner`/`setLeadLost` vs web actions `assignLeadOwner`/`markLeadLost` — distinct, no import clash.
- **Inngest race:** seeded leads (direct insert) stay deterministic; only the form test goes through intake. `createLeadForTenant` send is made resilient (T5).
- **Type consistency:** `LeadListRow`/`LeadDetail`/`LeadComm` defined in T4 and consumed unchanged in T6/T9; `leadStatusPersona` returns `{persona, dimmed}` consumed in T6; `LeadActions` props match T9's call site.
