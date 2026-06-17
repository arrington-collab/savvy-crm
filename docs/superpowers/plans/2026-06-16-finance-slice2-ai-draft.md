# Finance Slice 2 — AI Scope-Drafting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** A rep types a plain-English scope change in the Change Order editor → the Finance agent (`reason` capability) drafts **priced** line items by selecting items from the tenant's price book → the rep reviews/edits before sending. Never auto-applied. Implements spec §9.

**Architecture:** The AI returns `{key, quantity}[]` referencing price-book keys (grounded — no invented prices); the server resolves each key to a fully-priced `EstimateLineItem`. Logic lives in `@savvy/agents` (the Finance agent), exposed to the web via a thin server action; the editor appends the drafted items for review. Logs a `finance`/`change-order.ai-draft` `agent_run` (visible in the Command Center).

**Tech Stack:** TypeScript, `@savvy/ai` gateway (`completeObject`, capability `reason`), Drizzle, React client component, Playwright.

---

### Task 1: `draftChangeOrderScope` (`@savvy/agents`) + unit tests

**Files:**
- Create `packages/agents/src/functions/change-order-draft.ts`
- Create `packages/agents/src/functions/change-order-draft.test.ts`
- Modify `packages/agents/src/index.ts` (export)

- [ ] **Step 1: Write the failing test** `packages/agents/src/functions/change-order-draft.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { adminDb, withTenant, eq, tenant, agentRun } from "@savvy/db";
import { draftChangeOrderScope } from "./change-order-draft";

async function seedTenant() {
  const [t] = await adminDb.insert(tenant).values({
    name: "AID", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
  }).returning();
  return t!.id;
}

// Fake AI: returns two items (one valid price-book key, one unknown).
const fakeAi = {
  completeObject: async () => ({
    object: { items: [{ key: "pipe-boots", quantity: 3 }, { key: "nonexistent", quantity: 1 }], summary: "added boots" },
    model: "claude-sonnet-stub",
  }),
};

describe("draftChangeOrderScope", () => {
  it("resolves price-book keys to priced line items, drops unknown keys, logs finance/ai-draft", async () => {
    const tenantId = await seedTenant();
    const res = await draftChangeOrderScope(
      { tenantId, jobId: null, description: "add 3 pipe boots" },
      fakeAi,
    );
    expect(res.lineItems).toHaveLength(1);                       // unknown key dropped
    expect(res.unmatched).toEqual(["nonexistent"]);
    const li = res.lineItems[0]!;
    expect(li.name).toBe("Pipe boots");                         // from DEFAULT_PRICE_BOOK fallback
    expect(li.unitPriceCents).toBe(2500);
    expect(li.quantity).toBe(3);
    expect(li.amountCents).toBe(7500);
    expect(res.summary).toBe("added boots");

    const runs = await adminDb.select().from(agentRun).where(eq(agentRun.tenantId, tenantId));
    expect(runs.some((r) => r.agent === "finance" && r.taskKey === "change-order.ai-draft" && r.status === "ok")).toBe(true);
  });

  it("logs finance/error and rethrows when the AI call fails", async () => {
    const tenantId = await seedTenant();
    const boomAi = { completeObject: async () => { throw new Error("ai down"); } };
    await expect(
      draftChangeOrderScope({ tenantId, jobId: null, description: "x" }, boomAi),
    ).rejects.toThrow("ai down");
    const runs = await adminDb.select().from(agentRun).where(eq(agentRun.tenantId, tenantId));
    expect(runs.some((r) => r.agent === "finance" && r.taskKey === "change-order.ai-draft" && r.status === "error")).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail**
```
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm --filter @savvy/agents test -- change-order-draft
```
Expected FAIL (module missing).

- [ ] **Step 3: Implement** `packages/agents/src/functions/change-order-draft.ts`:
```ts
import { withTenant, priceBookItem, recordAgentRun } from "@savvy/db";
import { completeObject } from "@savvy/ai";
import type { Capability } from "@savvy/ai";
import { z, DEFAULT_PRICE_BOOK, type EstimateLineItem } from "@savvy/core";

const draftSchema = z.object({
  items: z.array(z.object({ key: z.string(), quantity: z.number().min(0) })).max(20),
  summary: z.string().max(280).optional(),
});

export type ScopeDraft = {
  lineItems: EstimateLineItem[];
  summary: string | null;
  model: string;
  unmatched: string[];
};

type AiClient = { completeObject: typeof completeObject };

/**
 * Finance agent: draft priced change-order line items from a plain-English
 * description. The model only chooses price-book keys + quantities (grounded —
 * it never invents prices); the server resolves each key to a real EstimateLineItem.
 * Logs a finance/change-order.ai-draft agent_run. Rethrows on AI failure (the
 * caller surfaces it to the rep).
 */
export async function draftChangeOrderScope(
  input: { tenantId: string; jobId: string | null; description: string },
  aiClient: AiClient = { completeObject },
): Promise<ScopeDraft> {
  const { tenantId, jobId, description } = input;
  const rows = await withTenant(tenantId, (tx) => tx.select().from(priceBookItem));
  const catalog = (rows.length ? rows : DEFAULT_PRICE_BOOK).map((c) => ({
    key: c.key, name: c.name, category: c.category, unit: c.unit, unitPriceCents: c.unitPriceCents,
  }));
  const byKey = new Map(catalog.map((c) => [c.key, c]));

  try {
    const { object, model } = await aiClient.completeObject({
      capability: "reason" as Capability,
      schema: draftSchema,
      system:
        "You are a roofing change-order assistant. Given a rep's plain-English description of a mid-job " +
        "scope change, select the relevant items from the supplied price book and set realistic quantities. " +
        "Use ONLY keys that appear in the price book. Never invent items or prices.",
      prompt: `Scope change: "${description}". Price book: ${JSON.stringify(catalog)}.`,
    });

    const unmatched: string[] = [];
    const lineItems: EstimateLineItem[] = [];
    object.items.forEach((it, i) => {
      const c = byKey.get(it.key);
      if (!c) { unmatched.push(it.key); return; }
      lineItems.push({
        key: `ai-${i}-${c.key}`,
        name: c.name,
        category: c.category,
        unit: c.unit,
        quantity: it.quantity,
        unitPriceCents: c.unitPriceCents,
        amountCents: Math.round(it.quantity * c.unitPriceCents),
      });
    });

    await recordAgentRun({
      tenantId, agent: "finance", taskKey: "change-order.ai-draft", status: "ok",
      jobId: jobId ?? null, modelUsed: model,
    });
    return { lineItems, summary: object.summary ?? null, model, unmatched };
  } catch (e) {
    await recordAgentRun({
      tenantId, agent: "finance", taskKey: "change-order.ai-draft", status: "error",
      jobId: jobId ?? null, error: String(e).slice(0, 200),
    });
    throw e;
  }
}
```
Add to `packages/agents/src/index.ts` (both a named re-export AND keep the `functions` array unchanged — this is NOT an Inngest function, so do NOT add it to `functions`):
```ts
export { draftChangeOrderScope } from "./functions/change-order-draft";
```

- [ ] **Step 4: Run, verify pass** `pnpm --filter @savvy/agents test -- change-order-draft`; then `pnpm --filter @savvy/agents typecheck`. Both clean.

- [ ] **Step 5: Commit**
```bash
git add packages/agents/src/functions/change-order-draft.ts packages/agents/src/functions/change-order-draft.test.ts packages/agents/src/index.ts
git commit -m "feat(agents): Finance agent AI scope-drafting (price-book-grounded)"
```

---

### Task 2: `draftChangeOrderLineItemsAction` server action (`apps/web`)

**Files:**
- Modify `apps/web/src/lib/change-order-actions.ts`

- [ ] **Step 1: Implement** (no unit test — apps/web is Playwright-only; covered by Task 5 e2e). Add to `apps/web/src/lib/change-order-actions.ts`:
```ts
import { draftChangeOrderScope } from "@savvy/agents";
import type { EstimateLineItem } from "@savvy/core";

export async function draftChangeOrderLineItemsAction(
  input: { jobId: string; description: string },
): Promise<{ ok: true; lineItems: EstimateLineItem[]; summary: string | null } | { error: "empty_description" | "ai_failed" }> {
  const tenantId = await getTenantId();
  if (!input.description.trim()) return { error: "empty_description" };
  try {
    const draft = await draftChangeOrderScope({ tenantId, jobId: input.jobId, description: input.description });
    return { ok: true, lineItems: draft.lineItems, summary: draft.summary };
  } catch {
    return { error: "ai_failed" };
  }
}
```
Reuse the existing `getTenantId` import already in the file. If `EstimateLineItem` is already imported there, don't duplicate the import.

- [ ] **Step 2: Typecheck** `pnpm --filter @savvy/web typecheck` → clean.

- [ ] **Step 3: Commit**
```bash
git add apps/web/src/lib/change-order-actions.ts
git commit -m "feat(web): draftChangeOrderLineItemsAction (AI scope-draft server action)"
```

---

### Task 3: "Draft with AI" UI in ChangeOrderEditor

**Files:**
- Modify `apps/web/src/app/(app)/jobs/[id]/change-orders/[changeOrderId]/ChangeOrderEditor.tsx`

- [ ] **Step 1: Implement.** Add imports + the new action; add a state field + a "Draft with AI" card ABOVE the Line Items card. Concretely:
  - Add to the imports from `@/lib/change-order-actions`: `draftChangeOrderLineItemsAction`.
  - Inside the component, add:
    ```ts
    const [aiDesc, setAiDesc] = useState("");
    const [draftPending, startDraft] = useTransition();
    function handleDraft() {
      startDraft(async () => {
        const r = await draftChangeOrderLineItemsAction({ jobId, description: aiDesc });
        if ("ok" in r) {
          setLineItems((p) => [...p, ...r.lineItems]);
          toast.success(r.summary ? `Drafted: ${r.summary}` : `Drafted ${r.lineItems.length} item(s) — review below.`);
          setAiDesc("");
        } else if (r.error === "empty_description") {
          toast.error("Describe the change first.");
        } else {
          toast.error("AI drafting is unavailable right now.");
        }
      });
    }
    ```
  - Add this card immediately BEFORE the `Line Items` `<Card>` (only useful while editable, so guard on draft status):
    ```tsx
    {changeOrder.status === "draft" && (
      <Card>
        <CardHeader><CardTitle>Draft with AI</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <textarea
            value={aiDesc}
            onChange={(e) => setAiDesc(e.target.value)}
            placeholder="Describe the scope change in plain English (e.g. 'replace 3 pipe boots and add 2 squares of ridge cap')"
            aria-label="Describe the change"
            data-testid="ai-draft-input"
            className="w-full min-h-20 rounded border border-border bg-background p-2 text-sm"
          />
          <Button type="button" size="sm" variant="outline" disabled={draftPending} onClick={handleDraft} data-testid="ai-draft-btn">
            {draftPending ? "Drafting…" : "Draft with AI"}
          </Button>
        </CardContent>
      </Card>
    )}
    ```

- [ ] **Step 2: Typecheck + lint** `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint` → 0 errors. (`toast`, `useState`, `useTransition`, `Button`, `Card*` are already imported in this file.)

- [ ] **Step 3: Commit**
```bash
git add "apps/web/src/app/(app)/jobs/[id]/change-orders/[changeOrderId]/ChangeOrderEditor.tsx"
git commit -m "feat(web): Draft-with-AI panel in Change Order editor"
```

---

### Task 4: Make the e2e AI stub request-aware

**Files:**
- Modify `apps/web/tests/e2e/ai-stub.mjs`

- [ ] **Step 1: Implement.** The stub currently returns a fixed `{score, reason}`. Make it inspect the request body and, for a scope-draft request, return a `{items, summary}` payload instead. Read the file first; then change the per-request handler so that after reading `body`, it chooses the payload:
```js
    const isScopeDraft = body.includes("Scope change") || body.includes('"items"');
    const payload = isScopeDraft
      ? { items: [{ key: "pipe-boots", quantity: 2 }], summary: "e2e stub: 2 pipe boots" }
      : { score: 75, reason: "e2e stub: storm zone, owner-occupied" };
```
Use `payload` in BOTH the `content` JSON string and the `tool_calls[0].function.arguments` (whatever the file already does — keep emitting both forms, just swap the object). Keep everything else identical.

- [ ] **Step 2: Commit**
```bash
git add apps/web/tests/e2e/ai-stub.mjs
git commit -m "test(web): make AI stub request-aware for scope-draft e2e"
```

---

### Task 5: e2e + full gate + PR

**Files:**
- Create `apps/web/tests/e2e/change-order-ai-draft.spec.ts`

- [ ] **Step 1: Write the e2e.** Read `apps/web/tests/e2e/change-order.spec.ts` for the exact seed pattern (tenant id from `/tmp/savvy-e2e-tenant.json`, `adminDb` insert of customer/property/job, `createChangeOrder`). Then:
```ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, createChangeOrder, customer, property, job } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("change order: draft line items with AI from a description", async ({ page }) => {
  const stamp = Date.now();
  const [c] = await adminDb.insert(customer).values({ tenantId, name: `AI Carl ${stamp}`, email: `ai-${stamp}@e2e.test` }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} AI Way` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production", valueFinal: 100000 }).returning();
  const co = await createChangeOrder({ tenantId, jobId: j!.id, customerId: c!.id, reason: "AI", lineItems: [] });

  await page.goto(`/jobs/${j!.id}/change-orders/${co.id}`);
  await expect(page.getByTestId("change-order-editor")).toBeVisible();
  await page.getByTestId("ai-draft-input").fill("replace 2 pipe boots");
  await page.getByTestId("ai-draft-btn").click();
  // The stub returns the pipe-boots key -> editor appends a "Pipe boots" line.
  await expect(page.getByText("Pipe boots").first()).toBeVisible();
});
```
Confirm `createChangeOrder` accepts an empty `lineItems: []` (it does — `computeChangeOrderTotal([])` = 0). Match the exact import names against `change-order.spec.ts`.

- [ ] **Step 2: Sync + full gate (repo root)**
```bash
git fetch origin main
git log --oneline $(git merge-base HEAD origin/main)..origin/main   # rebase if advanced
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Expected: typecheck clean, lint 0 errors, all tests pass (existing 204 + 2 new agents tests). Don't run e2e locally.

- [ ] **Step 3: Push + PR**
```bash
git push -u origin feat/finance-scope-drafting
gh pr create --base main --title "Finance agent: AI scope-drafting for change orders" \
  --body "Slice 2 — the flagship moat demo. Rep describes a scope change in plain English; the Finance agent (reason capability) drafts priced line items by selecting price-book keys+quantities (grounded — no invented prices); the rep reviews/edits in the editor before sending. Logs a finance/change-order.ai-draft agent_run (shows in the Command Center). AI logic in @savvy/agents (injected client, unit-tested); thin server action; editor panel; request-aware e2e AI stub. No schema change. Spec §9 + plan in docs/superpowers/."
```

- [ ] **Step 4: Watch CI; merge on green**
```bash
gh pr checks --watch
gh pr merge --squash --delete-branch
```
Re-run on the Google-Fonts/geist e2e flake.

---

## Self-review
- **Spec §9 coverage:** NL description (Task 3 input) → `reason` capability draft (Task 1) → price-book-grounded line items (Task 1, key resolution) → human review before send (Task 3 appends to editable list, never auto-sends) → logged agent_run visible in Command Center (Task 1). ✓
- **Placeholders:** none.
- **Type consistency:** `draftChangeOrderScope` returns `ScopeDraft.lineItems: EstimateLineItem[]` consumed unchanged by the action and appended to the editor's `EstimateLineItem[]` state; AI schema `{items:{key,quantity}[], summary?}` resolved server-side; `recordAgentRun` inputs match the helper (incl. `status:"error"`).
- **Grounding:** prices come ONLY from the price book (rows or `DEFAULT_PRICE_BOOK` fallback), never from the model — defensible + deterministic amounts.

## Deferred (note, don't build)
- Replace-vs-append toggle for drafted items (currently appends).
- Capability-tier rename (`reason` → `reasoning`) — separate data-coupled PR.
- Multi-turn refinement ("make it cheaper") — v2.
