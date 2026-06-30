# BYO Telephony — Plan 2b (Inbound Vapi routing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route inbound Vapi calls to the right tenant when a `byo` tenant points their own Vapi assistant at Savvy's webhook — resolving the tenant from the inbound payload's `assistantId`, falling through to today's dialed-number resolution so existing inbound (Bloom) is untouched.

**Architecture:** Extend `parseVapiMessage` to surface `assistantId`/`phoneNumberId`. Add a cross-tenant reverse lookup `tenantByVapiAssistant(assistantId)` (adminDb over `integration_connection` `vapi` rows). A single `resolveInboundTenant(msg)` helper does BYO-assistant-first, then dialed-number (`tenantByPhone`) fallthrough; the Vapi route's three inbound branches use it. Builds on Plan 2a (Vapi lifecycle / `provider='vapi'` rows already store `metadata.assistantId`).

**Tech Stack:** TypeScript, pnpm + Turborepo, Drizzle + Postgres (RLS), Vitest workspace, Next.js route handler, Playwright e2e.

## Global Constraints

- **Package manager: pnpm.** Test invocation: `npx vitest run --project @savvy/<pkg> <path>`. `apps/web` is NOT in the vitest workspace — route logic is exercised by Playwright e2e (`apps/web/tests/e2e/voice-webhook.spec.ts`); the new db/core logic IS unit-tested.
- **BYO-first, dialed-number fallthrough:** inbound tenant resolution tries `assistantId` (BYO) first, then falls through to the existing `tenantByPhone(toNumber)`. A tenant with no `byo` Vapi connection resolves exactly as today. No existing inbound behavior changes.
- **Cross-tenant lookup is adminDb (RLS-bypassing) by necessity:** `tenantByVapiAssistant` must run before the tenant is known, so it uses `adminDb` and matches on the exact `assistantId` — mirror the existing `listManagedSetupRequests` pattern. Only `status='active'` `vapi` rows match.
- **Webhook auth unchanged:** the shared `VAPI_WEBHOOK_SECRET` header stays the verification; tenant identity comes from the verified payload's `assistantId`, not the secret.
- **Import conventions:** `packages/db` source modules use NO file extension on relative imports; db test files use `.js`. `packages/core` relative imports have no extension.
- **Behavior-preserving:** `parseVapiMessage`'s existing fields and all current route branches keep working; only additive fields + a prepended resolution step.

---

### Task 1: Surface `assistantId` + `phoneNumberId` in `parseVapiMessage`

**Files:**
- Modify: `packages/core/src/voice-webhook.ts`
- Modify: `packages/core/src/voice-webhook.test.ts`

**Interfaces:**
- Produces: `ParsedVapiMessage` gains `assistantId: string | null` and `phoneNumberId: string | null`.

- [ ] **Step 1: Write the failing test** — add to `packages/core/src/voice-webhook.test.ts`:

```ts
it("surfaces assistantId and phoneNumberId from an inbound message", () => {
  const msg = parseVapiMessage({
    message: {
      type: "assistant-request",
      assistant: { id: "asst_byo_1" },
      phoneNumber: { id: "pn_byo_1", number: "+16025550000" },
      customer: { number: "+16025551111" },
    },
  });
  expect(msg.assistantId).toBe("asst_byo_1");
  expect(msg.phoneNumberId).toBe("pn_byo_1");
});

it("defaults assistantId/phoneNumberId to null on empty input", () => {
  const m = parseVapiMessage(null);
  expect(m.assistantId).toBeNull();
  expect(m.phoneNumberId).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project @savvy/core packages/core/src/voice-webhook.test.ts`
Expected: FAIL — `assistantId`/`phoneNumberId` are `undefined`.

- [ ] **Step 3: Implement** — in `packages/core/src/voice-webhook.ts`:
  - Add the two fields to the `ParsedVapiMessage` type:
    ```ts
    assistantId: string | null;
    phoneNumberId: string | null;
    ```
  - In `parseVapiMessage`, after `const phone = asRecord(message.phoneNumber);` add:
    ```ts
    const assistant = asRecord(message.assistant);
    ```
  - In the returned object (alongside `toNumber`/`fromNumber`), add:
    ```ts
    assistantId: typeof assistant.id === "string" ? assistant.id : (typeof call.assistantId === "string" ? call.assistantId : null),
    phoneNumberId: typeof phone.id === "string" ? phone.id : null,
    ```
  (The `assistant.id` primary path with a `call.assistantId` fallback covers both Vapi payload shapes; `call` is already destructured at the top of the function.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project @savvy/core packages/core/src/voice-webhook.test.ts`
Expected: PASS.

- [ ] **Step 5: Full core suite + typecheck + commit**

```bash
npx vitest run --project @savvy/core
pnpm --filter @savvy/core typecheck
git add packages/core/src/voice-webhook.ts packages/core/src/voice-webhook.test.ts
git commit -m "feat(core): surface assistantId/phoneNumberId in parseVapiMessage"
```

---

### Task 2: `tenantByVapiAssistant` reverse lookup (`@savvy/db`)

**Files:**
- Modify: `packages/db/src/lifecycle/telephony.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/tests/vapi-lifecycle.test.ts`

**Interfaces:**
- Consumes: `adminDb`, `integrationConnection`, `and`, `eq`, and `sql` (from `drizzle-orm`).
- Produces: `tenantByVapiAssistant(assistantId: string): Promise<string | null>` — the `tenant_id` of the active `vapi` connection whose `metadata.assistantId` matches, else null.

- [ ] **Step 1: Add the failing test** — append to `packages/db/tests/vapi-lifecycle.test.ts` (reuse its seeded tenant `tid`; use a unique assistant id to avoid cross-file collision on the shared DB):

```ts
import { tenantByVapiAssistant } from "../src/lifecycle/telephony.js";

describe("tenantByVapiAssistant", () => {
  it("returns the tenant id for an active vapi connection by assistantId", async () => {
    // tid already has a vapi connection from the upsert test above; ensure it is active with a known assistant.
    await upsertVapiConnection(tid, { secret: { apiKey: "k2" }, assistantId: "asst_lookup_unique", phoneNumberId: "pn_2" });
    await setTelephonyConnectionStatus(tid, "vapi", "active");
    expect(await tenantByVapiAssistant("asst_lookup_unique")).toBe(tid);
  });

  it("returns null for an unknown assistant", async () => {
    expect(await tenantByVapiAssistant("asst_does_not_exist")).toBeNull();
  });

  it("does not match a disabled connection", async () => {
    await upsertVapiConnection(tid, { secret: { apiKey: "k3" }, assistantId: "asst_disabled_unique", phoneNumberId: "pn_3" });
    await setTelephonyConnectionStatus(tid, "vapi", "disabled");
    expect(await tenantByVapiAssistant("asst_disabled_unique")).toBeNull();
  });
});
```
> Note: `upsertVapiConnection` upserts on `(tenant_id, provider)`, so the same `tid` row is reused — the last upsert wins. Order the assertions so each test sets the state it checks (as written above).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project @savvy/db packages/db/tests/vapi-lifecycle.test.ts`
Expected: FAIL — `tenantByVapiAssistant` not exported.

- [ ] **Step 3: Implement** — in `packages/db/src/lifecycle/telephony.ts`:
  - Add `sql` to the drizzle import: `import { and, eq, sql } from "drizzle-orm";`
  - Append:
    ```ts
    /**
     * Reverse lookup: the tenant id owning an ACTIVE vapi connection whose
     * assistantId matches. Cross-tenant (adminDb) because the tenant is unknown
     * at inbound time. Mirrors the metadata->>'' filter used elsewhere.
     */
    export async function tenantByVapiAssistant(assistantId: string): Promise<string | null> {
      if (!assistantId) return null;
      const rows = await adminDb
        .select({ tenantId: integrationConnection.tenantId })
        .from(integrationConnection)
        .where(
          and(
            eq(integrationConnection.provider, "vapi"),
            eq(integrationConnection.status, "active"),
            sql`${integrationConnection.metadata}->>'assistantId' = ${assistantId}`,
          ),
        );
      return rows[0]?.tenantId ?? null;
    }
    ```

- [ ] **Step 4: Re-export** — add `tenantByVapiAssistant` to the named telephony re-export block in `packages/db/src/index.ts`.

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run --project @savvy/db packages/db/tests/vapi-lifecycle.test.ts` then `pnpm --filter @savvy/db typecheck`.
Expected: PASS (existing vapi tests + 3 new).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/telephony.ts packages/db/src/index.ts packages/db/tests/vapi-lifecycle.test.ts
git commit -m "feat(db): tenantByVapiAssistant reverse lookup (active vapi connection by assistantId)"
```

---

### Task 3: `resolveInboundTenant` + wire the Vapi route's three branches

**Files:**
- Modify: `apps/web/src/lib/intake.ts` (add `tenantById` + `resolveInboundTenant`)
- Modify: `apps/web/src/app/api/voice/vapi/route.ts` (3 branches)
- Modify: `apps/web/tests/e2e/voice-webhook.spec.ts` (BYO-assistant resolution case)

**Interfaces:**
- Consumes: `tenantByVapiAssistant` from `@savvy/db`; `parseVapiMessage`'s new `assistantId` field; existing `tenantByPhone`.
- Produces (in `intake.ts`):
  - `tenantById(id: string)` — full tenant row by id (adminDb), mirrors `tenantByPhone`.
  - `resolveInboundTenant(msg: { assistantId: string | null; toNumber: string | null })` — BYO assistant first → `tenantById`, else `tenantByPhone(toNumber)`, else null. Returns the full tenant row or null.

- [ ] **Step 1: Add the resolution helpers** — in `apps/web/src/lib/intake.ts` (mirror `tenantByPhone`; add `tenantByVapiAssistant` to the `@savvy/db` import):

```ts
export async function tenantById(id: string) {
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, id));
  return t ?? null;
}

/** Inbound tenant resolution: BYO Vapi assistant first, else dialed-number. */
export async function resolveInboundTenant(msg: { assistantId: string | null; toNumber: string | null }) {
  if (msg.assistantId) {
    const tid = await tenantByVapiAssistant(msg.assistantId);
    if (tid) return tenantById(tid);
  }
  return msg.toNumber ? tenantByPhone(msg.toNumber) : null;
}
```

- [ ] **Step 2: Wire the `assistant-request` branch** — in `route.ts`, replace `const t = msg.toNumber ? await tenantByPhone(msg.toNumber) : null;` (the assistant-request resolution) with:

```ts
const t = await resolveInboundTenant(msg);
```
(Keep the subsequent `if (!t) return ...` and the `t.settings`/`t.name`/`t.id` usage unchanged.) Update the import from `@/lib/intake` to include `resolveInboundTenant`.

- [ ] **Step 3: Wire the `tool-calls`/`function-call` branch** — replace the `tenantId` resolution:

```ts
const tenantId = msg.metadata.tenantId ?? (await resolveInboundTenant(msg))?.id ?? null;
```
(Outbound still wins via `msg.metadata.tenantId`; inbound now does BYO-first then dialed-number.)

- [ ] **Step 4: Wire the `end-of-call-report` branch** — change the guard + resolution so a BYO inbound call (assistantId present, possibly no `toNumber`) still resolves. Replace `if (!leadId && msg.toNumber) { ... const t = await tenantByPhone(msg.toNumber); ... }` so the entry condition is `if (!leadId && (msg.toNumber || msg.assistantId))` and the inner lookup is `const t = await resolveInboundTenant(msg);` (rest of the block — `tenantId = t.id`, `getLeadByVoiceCallId`, etc. — unchanged).

- [ ] **Step 5: Extend the e2e spec** — in `apps/web/tests/e2e/voice-webhook.spec.ts`, add a test that:
  - seeds a `vapi` `integration_connection` for a tenant with `metadata.assistantId = <random unique>` and `status='active'` (via `adminDb` / the lifecycle helpers), with the tenant's `telephonyMode='byo'` not required (resolution is by assistant id regardless of mode);
  - POSTs `{ message: { type: "assistant-request", assistant: { id: <that assistantId> }, customer: { number: "+1..." } } }` with the valid secret header;
  - asserts the response is the branded assistant for THAT tenant (mirror the existing inboundPhone test's assertions);
  - cleans up the seeded row in a `finally`/`afterEach`.
  Use a randomized assistant id (like the existing test randomizes `inboundPhone`) to avoid collisions on the shared DB.

- [ ] **Step 6: Typecheck + build + e2e**

Run: `pnpm --filter @savvy/web typecheck` (clean), `pnpm --filter @savvy/web build` (Turbopack compiles; known `/_not-found` Clerk gap aside). If the e2e environment is available, run the voice-webhook spec: `pnpm --filter @savvy/web exec playwright test voice-webhook` — otherwise note that e2e requires the app + DB running and verify the spec compiles.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/intake.ts apps/web/src/app/api/voice/vapi/route.ts apps/web/tests/e2e/voice-webhook.spec.ts
git commit -m "feat(web): inbound Vapi BYO routing — resolve tenant by assistantId, fall through to dialed number"
```

---

### Task 4: Final verification

- [ ] **Step 1: Sweep** — confirm clean:
- `npx vitest run --project @savvy/core packages/core/src/voice-webhook.test.ts`
- `npx vitest run --project @savvy/db packages/db/tests/vapi-lifecycle.test.ts`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm --filter @savvy/web build` (compile succeeds)

- [ ] **Step 2: Trace check (no code change)** — confirm by reading: all three inbound route branches call `resolveInboundTenant(msg)`; the BYO path returns before `tenantByPhone` only when an active vapi assistant matches; existing dialed-number behavior is the fallthrough (unchanged for non-BYO tenants).

- [ ] **Step 3: Commit any test adjustments** made during the sweep, else nothing.

---

## Plan 2b deliverable
Inbound Vapi calls to a `byo` tenant's own assistant resolve to that tenant (by `assistantId`), with dialed-number resolution as the fallthrough so existing inbound is unchanged. Completes the BYO telephony surface (outbound from 2a + inbound here).

## Follow-ups / notes
- `verifyVapiCreds` (from 2a) only checks the assistant, not the phone-number id — a wrong `phoneNumberId` passes "Test connection" but fails at first outbound dial. Optional hardening: extend verify to GET the phone-number resource; surface in support docs.
- Per-tenant webhook secrets remain deferred (the shared `VAPI_WEBHOOK_SECRET` + assistant-id identity is the v1 model).
- Phone-number-id-based inbound matching (instead of assistant-id) is available via the now-parsed `phoneNumberId` if a future Vapi config makes assistant-id unreliable; not wired in v1.

## Self-review notes
- **Spec coverage (§C inbound):** payload field surfacing → Task 1; reverse lookup → Task 2; BYO-first route resolution with platform fallthrough → Task 3; testing → each task + Task 4.
- **Prod safety:** `resolveInboundTenant` falls through to today's `tenantByPhone`, so a tenant with no active `vapi` BYO connection resolves exactly as before — Bloom inbound unchanged.
- **Type consistency:** `parseVapiMessage` → `msg.assistantId` (string|null) feeds `resolveInboundTenant` → `tenantByVapiAssistant(assistantId)` (returns tenantId) → `tenantById` (full row). The route branches use the full row (`.id`/`.settings`/`.name`).
