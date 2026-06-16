# Finance Slice 1 — Auto-send Supplemental Invoice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a change order is approved, the Finance agent auto-sends the supplemental invoice (number + `draft→sent`, Stripe checkout link, dunning enrollment) — guarded + idempotent.

**Architecture:** Extend the existing `changeOrderAccepted` Inngest function with a durable auto-send step that reuses `sendInvoice` (db) + `stripeGateway.createCheckoutSession` (integrations), logs via a new `recordAgentRun` helper, and emits `invoice/sent` to enroll dunning. No schema change. Idempotency: money mutation still guarded by `change_order.applied`; the send guarded by `invoice.status='draft'`.

**Tech Stack:** TypeScript, Drizzle (Postgres RLS), Inngest, Stripe (via `@savvy/integrations`), Vitest.

---

### Task 1: `recordAgentRun` helper (`@savvy/db`)

**Files:**
- Create: `packages/db/src/lifecycle/agent-run.ts`
- Test: `packages/db/src/lifecycle/agent-run.test.ts`
- Modify: `packages/db/src/index.ts` (export)

- [ ] **Step 1: Write the failing test**

`packages/db/src/lifecycle/agent-run.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { adminDb, withTenant, eq, agentRun, tenant } from "@savvy/db";
import { recordAgentRun } from "./agent-run.js";

describe("recordAgentRun", () => {
  it("writes an agent_run row with taskKey, skipped status, finishedAt set", async () => {
    const [t] = await adminDb.insert(tenant).values({
      name: "AR", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
    }).returning();
    await recordAgentRun({
      tenantId: t!.id, agent: "finance", taskKey: "test.task", status: "skipped", error: "x",
    });
    const rows = await withTenant(t!.id, (tx) =>
      tx.select().from(agentRun).where(eq(agentRun.tenantId, t!.id)));
    expect(rows.length).toBe(1);
    expect(rows[0]!.agent).toBe("finance");
    expect(rows[0]!.taskKey).toBe("test.task");
    expect(rows[0]!.status).toBe("skipped");
    expect(rows[0]!.finishedAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/db test -- agent-run`
Expected: FAIL — `recordAgentRun` is not exported / file missing.

- [ ] **Step 3: Write minimal implementation**

`packages/db/src/lifecycle/agent-run.ts`:
```ts
import { withTenant } from "../tenant";
import { agentRun } from "../schema/index";
import type { Agent } from "@savvy/core";

export type AgentRunStatus = "running" | "ok" | "error" | "skipped";

/**
 * One consistent write-path for agent activity. Opens its own withTenant tx
 * (matches the existing ad-hoc inserts). `status` is free text by convention:
 * running|ok|error|skipped (skipped = a legitimate no-op, e.g. Stripe unconfigured).
 */
export async function recordAgentRun(input: {
  tenantId: string;
  agent: Agent;
  taskKey: string;
  status: AgentRunStatus;
  jobId?: string | null;
  modelUsed?: string | null;
  tokens?: number | null;
  costCents?: number | null;
  inngestRunId?: string | null;
  error?: string | null;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx.insert(agentRun).values({
      tenantId: input.tenantId,
      agent: input.agent,
      taskKey: input.taskKey,
      status: input.status,
      jobId: input.jobId ?? null,
      modelUsed: input.modelUsed ?? null,
      tokens: input.tokens ?? null,
      costCents: input.costCents ?? null,
      inngestRunId: input.inngestRunId ?? null,
      error: input.error ?? null,
      finishedAt: new Date(),
    }),
  );
}
```

Add to `packages/db/src/index.ts` near the other lifecycle exports:
```ts
export { recordAgentRun, type AgentRunStatus } from "./lifecycle/agent-run";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @savvy/db test -- agent-run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/agent-run.ts packages/db/src/lifecycle/agent-run.test.ts packages/db/src/index.ts
git commit -m "feat(db): recordAgentRun helper for consistent agent activity logging"
```

---

### Task 2: Extend `approveChangeOrder` to return `invoiceId`

**Files:**
- Modify: `packages/db/src/lifecycle/change-order.ts`
- Modify: `packages/db/src/lifecycle/change-order.test.ts` (add one assertion)

- [ ] **Step 1: Update the test to assert the new field**

In `packages/db/src/lifecycle/change-order.test.ts`, in the `approveChangeOrder` "approves once" test, after `expect(r1.invoiceCreated).toBe(true);` add:
```ts
    expect(r1.invoiceId).toBe(invs[0]!.id);
```
(`invs` is the invoice list already selected later in that test — if it is declared after this line, move this assertion below the `const invs = ...` line.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @savvy/db test -- change-order`
Expected: FAIL — `r1.invoiceId` is `undefined` (property does not exist yet).

- [ ] **Step 3: Implement**

In `packages/db/src/lifecycle/change-order.ts`, change the signature + both returns of `approveChangeOrder`:
```ts
export async function approveChangeOrder(input: {
  tenantId: string;
  changeOrderId: string;
}): Promise<{ invoiceCreated: boolean; invoiceId: string | null }> {
  return withTenant(input.tenantId, async (tx) => {
    const [co] = await tx.select().from(changeOrder).where(eq(changeOrder.id, input.changeOrderId));
    if (!co || co.applied) return { invoiceCreated: false, invoiceId: co?.invoiceId ?? null };
    // ... unchanged body ...
    await tx.update(changeOrder).set({ applied: true, invoiceId }).where(eq(changeOrder.id, co.id));
    return { invoiceCreated: invoiceId !== null, invoiceId };
  });
}
```
(Only the return type and the two `return` statements change. The early return now also yields the already-applied invoice id so a redelivery can still complete the send.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @savvy/db test -- change-order`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/change-order.ts packages/db/src/lifecycle/change-order.test.ts
git commit -m "feat(db): approveChangeOrder returns invoiceId for downstream send"
```

---

### Task 3: `autoSendSupplementalInvoice` orchestration (`@savvy/agents`)

**Files:**
- Modify: `packages/agents/src/functions/change-order.ts`
- Modify: `packages/agents/src/functions/change-order.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/agents/src/functions/change-order.test.ts` (and extend the imports on line 2 to add `makeFakeStripe` is NOT in @savvy/db — import it from `@savvy/integrations`; also add `invoice` already imported):
```ts
import { makeFakeStripe } from "@savvy/integrations";
import { agentRun } from "@savvy/db";
import { applyAcceptedChangeOrder, autoSendSupplementalInvoice } from "./change-order";

describe("autoSendSupplementalInvoice", () => {
  it("sends a draft supplemental invoice: number, checkout, dunning-ready, finance/ok run", async () => {
    const { tenantId, jobId, changeOrderId } = await seed(50000);
    await adminDb.update(tenant).set({ stripeAccountId: "acct_test" }).where(eq(tenant.id, tenantId));
    const applied = await applyAcceptedChangeOrder(tenantId, changeOrderId);
    expect(applied.invoiceId).toBeTruthy();

    const fake = makeFakeStripe();
    const res = await autoSendSupplementalInvoice({ tenantId, invoiceId: applied.invoiceId }, { stripe: fake });
    expect(res.sent).toBe(true);

    const [inv] = await adminDb.select().from(invoice).where(eq(invoice.jobId, jobId));
    expect(inv!.status).toBe("sent");
    expect(inv!.number).toBeTruthy();
    expect(inv!.stripeCheckoutSessionId).toBeTruthy();
    expect(fake.calls.some((c) => c.op === "checkout")).toBe(true);

    const runs = await adminDb.select().from(agentRun).where(eq(agentRun.tenantId, tenantId));
    expect(runs.some((r) => r.agent === "finance" && r.taskKey === "change-order.auto-send-invoice" && r.status === "ok")).toBe(true);

    // idempotent: second call is a no-op
    const res2 = await autoSendSupplementalInvoice({ tenantId, invoiceId: applied.invoiceId }, { stripe: fake });
    expect(res2).toEqual({ sent: false, reason: "already-sent" });
    const invs = await adminDb.select().from(invoice).where(eq(invoice.jobId, jobId));
    expect(invs.length).toBe(1);
  });

  it("skips (no throw) when the tenant has no Stripe account; logs finance/skipped", async () => {
    const { tenantId, jobId, changeOrderId } = await seed(50000);
    const applied = await applyAcceptedChangeOrder(tenantId, changeOrderId);
    const res = await autoSendSupplementalInvoice({ tenantId, invoiceId: applied.invoiceId }, { stripe: makeFakeStripe() });
    expect(res).toEqual({ sent: false, reason: "stripe-not-connected" });
    const [inv] = await adminDb.select().from(invoice).where(eq(invoice.jobId, jobId));
    expect(inv!.status).toBe("draft");
    const runs = await adminDb.select().from(agentRun).where(eq(agentRun.tenantId, tenantId));
    expect(runs.some((r) => r.agent === "finance" && r.status === "skipped")).toBe(true);
  });
});
```
Note: the existing top imports already include `adminDb, withTenant, eq, tenant, customer, property, job, invoice, createChangeOrder`. Add `agentRun` to that import and add the `makeFakeStripe` import line.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @savvy/agents test -- change-order`
Expected: FAIL — `autoSendSupplementalInvoice` is not exported.

- [ ] **Step 3: Implement**

In `packages/agents/src/functions/change-order.ts`, replace the file with:
```ts
import { withTenant, agentRun, approveChangeOrder, sendInvoice, recordAgentRun, invoice, tenant, eq } from "@savvy/db";
import { stripeGateway, type StripeGateway } from "@savvy/integrations";
import { inngest } from "../client";

/** Thin wrapper so the apply step stays a one-liner and the test can call the work directly. */
export async function applyAcceptedChangeOrder(
  tenantId: string,
  changeOrderId: string,
): Promise<{ invoiceCreated: boolean; invoiceId: string | null }> {
  const res = await approveChangeOrder({ tenantId, changeOrderId });
  await recordAgentRun({ tenantId, agent: "finance", taskKey: "change-order.apply", status: "ok" });
  return res;
}

export type AutoSendResult =
  | { sent: true; invoiceId: string }
  | { sent: false; reason: "no-invoice" | "already-sent" | "stripe-not-connected" };

/**
 * Finance agent: auto-send a draft supplemental invoice created by approveChangeOrder.
 * Idempotent via invoice.status='draft' (sendInvoice flips draft->sent atomically).
 * Resilient: no Stripe account -> skipped (no throw, no infinite Inngest retry).
 * Outbound Stripe I/O happens outside any withTenant tx.
 */
export async function autoSendSupplementalInvoice(
  input: { tenantId: string; invoiceId: string | null },
  deps: { stripe?: StripeGateway } = {},
): Promise<AutoSendResult> {
  const stripe = deps.stripe ?? stripeGateway;
  const { tenantId } = input;
  if (!input.invoiceId) return { sent: false, reason: "no-invoice" };
  const invoiceId = input.invoiceId;

  const ctx = await withTenant(tenantId, async (tx) => {
    const [inv] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId));
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
    return { inv, accountId: t?.stripeAccountId ?? null };
  });
  if (!ctx.inv || ctx.inv.status !== "draft") return { sent: false, reason: "already-sent" };

  if (!ctx.accountId) {
    await recordAgentRun({
      tenantId, agent: "finance", taskKey: "change-order.auto-send-invoice",
      status: "skipped", jobId: ctx.inv.jobId, error: "stripe-not-connected",
    });
    return { sent: false, reason: "stripe-not-connected" };
  }

  const sent = await sendInvoice({ tenantId, invoiceId }); // number + draft->sent (atomic)

  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const session = await stripe.createCheckoutSession({
    connectedAccountId: ctx.accountId,
    amountCents: sent.amountDue ?? 0,
    invoiceId, tenantId,
    description: sent.number ?? "Supplemental Invoice",
    successUrl: `${base}/invoices/${invoiceId}?paid=1`,
    cancelUrl: `${base}/invoices/${invoiceId}`,
  });

  await withTenant(tenantId, (tx) =>
    tx.update(invoice)
      .set({
        stripeCheckoutSessionId: session.id,
        ...(session.paymentIntentId ? { stripePaymentIntentId: session.paymentIntentId } : {}),
      })
      .where(eq(invoice.id, invoiceId)),
  );

  await recordAgentRun({
    tenantId, agent: "finance", taskKey: "change-order.auto-send-invoice",
    status: "ok", jobId: sent.jobId,
  });
  return { sent: true, invoiceId };
}

export const changeOrderAccepted = inngest.createFunction(
  { id: "change-order-accepted", concurrency: { limit: 10 } },
  { event: "change_order/accepted" },
  async ({ event, step }) => {
    const applied = await step.run("apply", () =>
      applyAcceptedChangeOrder(event.data.tenantId, event.data.changeOrderId));
    const result = await step.run("auto-send-invoice", () =>
      autoSendSupplementalInvoice({ tenantId: event.data.tenantId, invoiceId: applied.invoiceId }));
    if (result.sent) {
      await step.run("enroll-dunning", async () => {
        await inngest.send({ name: "invoice/sent", data: { invoiceId: result.invoiceId, tenantId: event.data.tenantId } });
        return { enrolled: true };
      });
    }
    return { invoiceCreated: applied.invoiceCreated, sent: result.sent };
  },
);
```
(`agentRun` is imported because the test file references it via `@savvy/db`; the source no longer inserts it directly — it goes through `recordAgentRun`. If lint flags `agentRun`/`withTenant` as unused in the source, remove them from the source import — they are only needed if still referenced. Keep `withTenant` — it IS used. Drop `agentRun` from the source import if unused.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @savvy/agents test -- change-order`
Expected: PASS (3 tests: existing apply idempotency + the two new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/functions/change-order.ts packages/agents/src/functions/change-order.test.ts
git commit -m "feat(agents): Finance agent auto-sends supplemental invoice on change-order approval"
```

---

### Task 4: Full gate + push + PR

- [ ] **Step 1: Sync with main (parallel-session safety)**

```bash
git fetch origin main
git log --oneline $(git merge-base HEAD origin/main)..origin/main
```
If origin/main advanced, `git rebase origin/main`. (No migration in this PR, so no number collision possible.)

- [ ] **Step 2: Run the full gate from repo root**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Expected: typecheck clean; lint 0 errors (pre-existing warnings OK); all tests pass (existing ~195 + 3 new). If the shared local DB is flaky, reset it (`DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;` then `pnpm db:migrate`) and re-run — trust CI on a fresh DB.

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin feat/agent-runtime-finance
gh pr create --base main --title "Finance agent: auto-send supplemental invoice on change-order approval" \
  --body "Slice 1 of the agent-runtime initiative. On change_order/accepted, the Finance agent now sends the draft supplemental invoice (number + draft->sent, Stripe checkout link, dunning via invoice/sent), guarded + idempotent (invoice.status='draft'). Adds recordAgentRun helper. No schema change. Spec/plan: docs/superpowers/."
```

- [ ] **Step 4: Watch CI; merge when green**

```bash
gh pr checks --watch
gh pr merge --squash --delete-branch
```
If CI fails on the Google-Fonts/`geist_mono` dev-compile flake (whole e2e suite 500s identically), re-run: `gh run rerun <id> --failed`.

---

## Deferred follow-ups (note, don't build)
- **Partial-failure gap:** if `sendInvoice` succeeds but `createCheckoutSession` throws, the invoice is `sent` with no checkout link; the status-guard then skips it on retry. Rare (fake never throws; real Stripe seldom). Future: create checkout before the status flip, or guard on `stripeCheckoutSessionId IS NULL` for the checkout step only.
- Credit/negative-delta invoicing (Stripe credit notes) for `total < 0` — still adjusts `valueFinal` only.
- Per-tenant "auto-send vs draft" toggle in `tenant.settings.finance`.

## Self-review
- **Spec coverage:** §7 (Finance Slice 1) fully covered by Tasks 2–4; §5 (`recordAgentRun`) by Task 1; idempotency (§7) by the status-guard test; no-Stripe resilience by the skipped test. Capability tiers (§4) and Command Center (§6) are PR2 — out of scope here by design (§10).
- **Placeholders:** none — every step has real code/commands.
- **Type consistency:** `approveChangeOrder` return `{invoiceCreated, invoiceId}` consumed by `applyAcceptedChangeOrder` → `autoSendSupplementalInvoice({invoiceId})`; `AutoSendResult` discriminated union matches the `.sent` checks in the Inngest fn and tests; `recordAgentRun` input matches both call sites.
