# BYO Telephony — Plan 2a (Outbound activation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route live outbound sends through each tenant's own credentials — SMS from their Twilio number, voice from their Vapi — with platform fallback when a `byo` tenant is not actively connected.

**Architecture:** A `getTenantSms(tenantId)` helper in `@savvy/agents` composes the Phase-1 `resolveTelephonyCreds` (db) with `makeTwilioSms` (integrations); call sites pass `tenantId` and get back `{ sender, from }`. A parallel `getTenantVoice(tenantId)` + new `makeHttpVapi(creds)` factory + new `resolveVoiceCreds` (db, `provider='vapi'`) do the same for outbound Vapi. Fallback (`byo`-inactive / empty placeholder creds / `platform` mode → global account) is decided in the helpers — the single policy point per channel.

**Tech Stack:** TypeScript, pnpm + Turborepo, Drizzle + Postgres (RLS), Vitest workspace, Next.js server actions.

## Global Constraints

- **Package manager: pnpm.** Test invocation: `npx vitest run --project @savvy/<pkg> <path-from-repo-root>`. `apps/web` is NOT in the vitest workspace (Playwright) — its tasks verify via `pnpm --filter @savvy/web typecheck`/`build`.
- **Composition direction (no cycle):** `@savvy/integrations` must NOT import `@savvy/db`. The tenant-cred composition helpers (`getTenantSms`, `getTenantVoice`) live in `@savvy/agents` (which depends on both). Integrations only ever receives plain creds.
- **Platform fallback is the single policy point:** `byo`+active with non-empty creds → tenant creds; everything else (`platform` mode, `byo`-inactive, empty placeholder creds) → the existing global `sms`/`smsFrom()` (SMS) or `voice` (Vapi) path. The resolver (`resolveTelephonyCreds`/`resolveVoiceCreds`) stays honest and is NOT changed to fall back.
- **Empty-creds guard:** a managed-setup placeholder row can be `active` with empty `accountSid`/`from` — treat empty `accountSid` OR empty `from` as fallback, never attempt a send with them.
- **Preserve existing test seams:** `drip`'s `SendDeps.sms` and `runRepAlert`'s 2nd-param sender must remain injectable. Resolve the tenant-aware sender at the call site that owns `tenantId`, then pass it through the existing seam.
- **Behavior-preserving for platform tenants:** every `platform`-mode tenant and every site with no `byo` connection sends exactly as today (same global sender, same `smsFrom()` number).
- **Lifecycle imports** in `packages/db/src/*` use NO file extension on relative imports (e.g. `from "../tenant"`); db TEST files use `.js`. `packages/db/src/index.ts` re-exports are named, no extension.

---

### Task 1: `getTenantSms` composition helper (`@savvy/agents`)

**Files:**
- Create: `packages/agents/src/telephony.ts`
- Create: `packages/agents/src/telephony.test.ts`

**Interfaces:**
- Consumes: `resolveTelephonyCreds` from `@savvy/db`; `makeTwilioSms`, `sms`, `smsFrom`, `type SmsSender` from `@savvy/integrations`.
- Produces:
  - `interface TenantSmsDeps { resolve: typeof resolveTelephonyCreds; platformSms: SmsSender; platformFrom: () => string }`
  - `getTenantSms(tenantId: string, deps?: TenantSmsDeps): Promise<{ sender: SmsSender; from: string }>`

- [ ] **Step 1: Write the failing test** — create `packages/agents/src/telephony.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { getTenantSms, type TenantSmsDeps } from "./telephony";

function deps(resolveResult: unknown): TenantSmsDeps {
  return {
    resolve: vi.fn().mockResolvedValue(resolveResult) as unknown as TenantSmsDeps["resolve"],
    platformSms: { sendSms: vi.fn().mockResolvedValue({ sid: "platform" }) },
    platformFrom: () => "+15550000000",
  };
}

describe("getTenantSms", () => {
  it("byo + active with full creds → tenant sender + tenant from", async () => {
    const d = deps({ source: "tenant", twilio: { accountSid: "AC1", authToken: "tok", from: "+14801112222" } });
    const r = await getTenantSms("t1", d);
    expect(r.from).toBe("+14801112222");
    // tenant sender is a fresh makeTwilioSms instance, not the platform mock
    expect(r.sender).not.toBe(d.platformSms);
  });

  it("platform mode → platform sender + platform from", async () => {
    const d = deps({ source: "platform", twilio: { accountSid: "ACenv", authToken: "tokenv", from: "+19999999999" } });
    const r = await getTenantSms("t1", d);
    expect(r.sender).toBe(d.platformSms);
    expect(r.from).toBe("+15550000000");
  });

  it("byo inactive → platform fallback", async () => {
    const d = deps({ source: "inactive" });
    const r = await getTenantSms("t1", d);
    expect(r.sender).toBe(d.platformSms);
    expect(r.from).toBe("+15550000000");
  });

  it("tenant source but empty placeholder creds → platform fallback", async () => {
    const d = deps({ source: "tenant", twilio: { accountSid: "", authToken: "", from: "" } });
    const r = await getTenantSms("t1", d);
    expect(r.sender).toBe(d.platformSms);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project @savvy/agents packages/agents/src/telephony.test.ts`
Expected: FAIL — `./telephony` does not exist.

- [ ] **Step 3: Implement** — create `packages/agents/src/telephony.ts`:

```ts
import { resolveTelephonyCreds } from "@savvy/db";
import { makeTwilioSms, sms, smsFrom, type SmsSender } from "@savvy/integrations";

export interface TenantSmsDeps {
  resolve: typeof resolveTelephonyCreds;
  platformSms: SmsSender;
  platformFrom: () => string;
}

const defaultDeps: TenantSmsDeps = { resolve: resolveTelephonyCreds, platformSms: sms, platformFrom: smsFrom };

/**
 * Resolve the SMS sender + from-number for a tenant.
 * byo + active with non-empty creds → the tenant's own Twilio; otherwise the
 * platform account (platform mode, inactive byo, or empty placeholder creds).
 */
export async function getTenantSms(
  tenantId: string,
  deps: TenantSmsDeps = defaultDeps,
): Promise<{ sender: SmsSender; from: string }> {
  const r = await deps.resolve(tenantId);
  if (r.source === "tenant" && r.twilio.accountSid && r.twilio.from) {
    return {
      sender: makeTwilioSms({ accountSid: r.twilio.accountSid, authToken: r.twilio.authToken }),
      from: r.twilio.from,
    };
  }
  return { sender: deps.platformSms, from: deps.platformFrom() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project @savvy/agents packages/agents/src/telephony.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @savvy/agents typecheck
git add packages/agents/src/telephony.ts packages/agents/src/telephony.test.ts
git commit -m "feat(agents): getTenantSms — per-tenant SMS sender with platform fallback"
```

---

### Task 2: Thread `getTenantSms` into the 5 module-`sms` agent sites

**Files:**
- Modify: `packages/agents/src/functions/lead-intake.ts:300`
- Modify: `packages/agents/src/functions/lead-cadence.ts:78`
- Modify: `packages/agents/src/functions/dunning.ts:148-152`
- Modify: `packages/agents/src/functions/appointment-reminders.ts:76`
- Modify: `packages/agents/src/functions/homeowner-notify.ts:26`

**Interfaces:**
- Consumes: `getTenantSms` from `../telephony` (Task 1).

Each site currently does `(sms as SmsSender).sendSms({ to, from: smsFrom(), body })` (or `sms.sendSms`). Replace with a `getTenantSms(tenantId)` resolution. The pattern for every site:

```ts
const { sender, from } = await getTenantSms(tenantId);
await sender.sendSms({ to, from, body });
```

- [ ] **Step 1: Update `lead-intake.ts`** — at line ~300, replace:

```ts
try { ({ sid } = await (sms as SmsSender).sendSms({ to: ctx.phone, from: smsFrom(), body: buildAckSms(vars) })); } catch { /* dev: no creds */ }
```
with:
```ts
try {
  const { sender, from } = await getTenantSms(tenantId);
  ({ sid } = await sender.sendSms({ to: ctx.phone, from, body: buildAckSms(vars) }));
} catch { /* dev: no creds */ }
```
Add `import { getTenantSms } from "../telephony";` (and drop the now-unused `sms`/`smsFrom`/`SmsSender` imports if nothing else in the file uses them — confirm per file).

- [ ] **Step 2: Update `lead-cadence.ts:78`, `dunning.ts:148-152`, `appointment-reminders.ts:76`, `homeowner-notify.ts:26`** the same way — resolve `const { sender, from } = await getTenantSms(tenantId);` immediately before each `sendSms`, pass `from`, and use `sender` instead of `sms`. `tenantId` is already in scope at every site (see recon). Keep any surrounding `try/catch`.

- [ ] **Step 3: Run the affected suites**

Run: `npx vitest run --project @savvy/agents packages/agents/src/functions/lead-intake.test.ts packages/agents/src/functions/lead-cadence.test.ts packages/agents/src/functions/dunning.test.ts packages/agents/src/functions/appointment-reminders.test.ts packages/agents/src/functions/homeowner-notify.test.ts`
Expected: PASS. (These tests run without Twilio creds; `getTenantSms` will resolve `platform`/`inactive` → the env `sms`, which in tests either no-ops or is caught — same effective behavior as before. If any test explicitly asserted the global `sms` was called, update it to assert via an injected resolver/sender per the Task 1 pattern; only change a test if it fails.)

- [ ] **Step 4: Full agents suite + typecheck**

Run: `npx vitest run --project @savvy/agents` then `pnpm --filter @savvy/agents typecheck`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/functions/lead-intake.ts packages/agents/src/functions/lead-cadence.ts packages/agents/src/functions/dunning.ts packages/agents/src/functions/appointment-reminders.ts packages/agents/src/functions/homeowner-notify.ts
git commit -m "feat(agents): route 5 SMS sites through getTenantSms (per-tenant + fallback)"
```

---

### Task 3: Thread the two injected-seam sites (`drip`, `lead-speed-to-lead`)

**Files:**
- Modify: `packages/agents/src/functions/drip.ts:181-184` (the `dripRun` call site that wires `SendDeps`)
- Modify: `packages/agents/src/functions/lead-speed-to-lead.ts` (`RepAlertCtx` + `runRepAlert` + the `leadSpeedToLead` caller)
- Test: `packages/agents/src/functions/drip-send.test.ts`, `packages/agents/src/functions/lead-speed-to-lead.test.ts` (keep green)

**Interfaces:**
- Consumes: `getTenantSms` from `../telephony`.
- Keeps: `SendDeps { sms: SmsSender; ... }` and `runRepAlert(ctx, sender?)` injectable — resolved at the caller.

- [ ] **Step 1: `drip.ts` — resolve at the `dripRun` call site.** `sendDripStep` already uses `deps.sms` + `smsFrom()` internally (lines 89-91). Change the internal `from` to come from deps too, and resolve the tenant sender where `dripRun` builds `SendDeps`.
  - In `sendDripStep`, change the send to use an injected `from`: add `from: string` to `SendDeps` and use `deps.from` instead of `smsFrom()` at line 90.
  - At the `dripRun` call site (lines 181-184), build deps from `getTenantSms`:

```ts
const { sender, from } = await getTenantSms(tenantId);
return sendDripStep(
  { tenantId, enrollmentId: setup.enrollmentId, customerId, step: s, templateBody, jobId },
  { sms: sender, from, email: getEmailSender({ gmailConnectionId: setup.gmailConnectionId }) },
);
```
  - Update `SendDeps` (line 35): `export type SendDeps = { sms: SmsSender; from: string; email: EmailSender; ai?: Pick<typeof ai, "complete"> };`
  - Update `drip-send.test.ts` to pass `from: "+15550000000"` in its injected deps (the test already injects `{ sms, email, ai }` — add `from`).

- [ ] **Step 2: `lead-speed-to-lead.ts` — thread `tenantId` into `RepAlertCtx`.** `RepAlertCtx` (lines 14-20) lacks `tenantId`. Add `tenantId: string` to it. In `runRepAlert`, when the caller does not inject a `sender`, resolve via `getTenantSms(ctx.tenantId)`:

```ts
export async function runRepAlert(ctx: RepAlertCtx, sender?: SmsSender): Promise<string> {
  const s = sender ?? (await getTenantSms(ctx.tenantId)).sender;
  const from = sender ? smsFrom() : (await getTenantSms(ctx.tenantId)).from;
  // ... existing body, using `s` and `from`
  await s.sendSms({ to: ctx.ownerPhone, from, body });
  // ...
}
```
> Cleaner: resolve once — `const resolved = sender ? { sender, from: smsFrom() } : await getTenantSms(ctx.tenantId);` then use `resolved.sender`/`resolved.from`. Use the single-resolve form to avoid calling `getTenantSms` twice.
  - At the `leadSpeedToLead` inngest caller (line ~67), pass `tenantId` into the `ctx` object it builds for `runRepAlert`.
  - Update `lead-speed-to-lead.test.ts`: the test injects a fake `sender` (2nd arg) — keep that path working (when `sender` is injected, `tenantId` resolution is skipped). Add `tenantId: "<id>"` to the `ctx` literal it passes so the type compiles.

- [ ] **Step 3: Run both seam suites**

Run: `npx vitest run --project @savvy/agents packages/agents/src/functions/drip-send.test.ts packages/agents/src/functions/lead-speed-to-lead.test.ts`
Expected: PASS.

- [ ] **Step 4: Full agents suite + typecheck**

Run: `npx vitest run --project @savvy/agents` then `pnpm --filter @savvy/agents typecheck`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/functions/drip.ts packages/agents/src/functions/lead-speed-to-lead.ts packages/agents/src/functions/drip-send.test.ts packages/agents/src/functions/lead-speed-to-lead.test.ts
git commit -m "feat(agents): route drip + speed-to-lead SMS through getTenantSms (seams intact)"
```

---

### Task 4: Thread the inbound-voice route's SMS send (`apps/web`)

**Files:**
- Modify: `apps/web/src/app/api/voice/vapi/route.ts:235-239`

**Interfaces:**
- Consumes: `getTenantSms` from `@savvy/agents` (confirm `@savvy/agents` is a dependency of `apps/web`; if not, this helper can also be imported from wherever the route already imports agent helpers — verify the import resolves).

- [ ] **Step 1: Replace the no-answer fallback SMS send** — at lines 235-239, replace:

```ts
await (sms as SmsSender).sendSms({
  to,
  from: smsFrom(),
  body: `Sorry we missed you! Book your free roof inspection here: ${bookingUrl}`,
});
```
with:
```ts
const { sender, from } = await getTenantSms(tenantId);
await sender.sendSms({
  to,
  from,
  body: `Sorry we missed you! Book your free roof inspection here: ${bookingUrl}`,
});
```
`tenantId` is in scope here (set at line ~179). Add the `getTenantSms` import; drop unused `sms`/`smsFrom`/`SmsSender` imports if nothing else in the file uses them.

- [ ] **Step 2: Typecheck + build**

Run: `pnpm --filter @savvy/web typecheck` then `pnpm --filter @savvy/web build`
Expected: typecheck clean; Turbopack compiles (a residual `/_not-found` Clerk-publishableKey prerender failure is the known worktree env gap — not a code error).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/voice/vapi/route.ts
git commit -m "feat(web): route inbound-voice fallback SMS through getTenantSms"
```

---

### Task 5: Vapi connection lifecycle (`@savvy/db`)

**Files:**
- Modify: `packages/db/src/lifecycle/telephony.ts`
- Modify: `packages/db/src/index.ts`
- Create: `packages/db/tests/vapi-lifecycle.test.ts`

**Interfaces:**
- Consumes: `seal`, `open`, `type SealedSecret` from `@savvy/core`; `withTenant`, `adminDb`, `integrationConnection`, existing helpers.
- Produces (mirroring the Twilio set, `provider='vapi'`):
  - `interface VapiSecret { apiKey: string }`
  - `interface VapiConnectionView { provider: "vapi"; status: IntegrationStatus; assistantId: string | null; phoneNumberId: string | null; lastVerifiedAt: Date | null }`
  - `upsertVapiConnection(tenantId, input: { secret: VapiSecret; assistantId: string; phoneNumberId: string }): Promise<void>` (status → `pending`)
  - `getVapiConnection(tenantId): Promise<VapiConnectionView | null>` (never returns apiKey)
  - `getVapiSecret(tenantId): Promise<VapiSecret | null>` (decrypt, server-only)
  - `resolveVoiceCreds(tenantId): Promise<{ source: "platform" | "tenant"; vapi: { apiKey: string; assistantId: string; phoneNumberId: string } } | { source: "inactive" }>`
- Note: `setTelephonyConnectionStatus` and `disconnectTelephony` currently type `provider: "twilio"` — widen their `provider` param type to `"twilio" | "vapi"` so they serve both (no logic change).

- [ ] **Step 1: Write the failing test** — create `packages/db/tests/vapi-lifecycle.test.ts` (mirror `telephony-lifecycle.test.ts`: seed a tenant via `adminDb`, set `INTEGRATION_SECRET_KEY`, end both pools in `afterAll`):

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { pool } from "../src/client.js";
import { tenant, integrationConnection } from "../src/schema/index.js";
import {
  upsertVapiConnection, getVapiConnection, getVapiSecret, resolveVoiceCreds,
  setTelephonyConnectionStatus, setTelephonyMode,
} from "../src/lifecycle/telephony.js";

let tid: string;
beforeAll(async () => {
  process.env.INTEGRATION_SECRET_KEY = Buffer.alloc(32, 5).toString("base64");
  const [t] = await adminDb.insert(tenant).values({ name: "VAPI-LC", publicKey: "vapi-lc", clerkOrgId: "org_vapi_lc" }).returning();
  tid = t!.id;
});
afterAll(async () => {
  await adminDb.delete(integrationConnection).where(eq(integrationConnection.tenantId, tid));
  await adminDb.delete(tenant).where(eq(tenant.id, tid));
  await pool.end();
  await adminPool.end();
});

describe("vapi lifecycle", () => {
  it("upserts without exposing the apiKey, decrypts server-side", async () => {
    await upsertVapiConnection(tid, { secret: { apiKey: "vapi_secret_key" }, assistantId: "asst_1", phoneNumberId: "pn_1" });
    const view = await getVapiConnection(tid);
    expect(view!.status).toBe("pending");
    expect(view!.assistantId).toBe("asst_1");
    expect(JSON.stringify(view)).not.toContain("vapi_secret_key");
    expect(await getVapiSecret(tid)).toEqual({ apiKey: "vapi_secret_key" });
  });

  it("resolveVoiceCreds: platform when mode=platform", async () => {
    process.env.VAPI_API_KEY = "envkey";
    process.env.VAPI_ASSISTANT_ID = "envasst";
    process.env.VAPI_PHONE_NUMBER_ID = "envpn";
    await setTelephonyMode(tid, "platform");
    expect(await resolveVoiceCreds(tid)).toEqual({ source: "platform", vapi: { apiKey: "envkey", assistantId: "envasst", phoneNumberId: "envpn" } });
  });

  it("resolveVoiceCreds: tenant when byo + active", async () => {
    await setTelephonyConnectionStatus(tid, "vapi", "active");
    await setTelephonyMode(tid, "byo");
    expect(await resolveVoiceCreds(tid)).toEqual({ source: "tenant", vapi: { apiKey: "vapi_secret_key", assistantId: "asst_1", phoneNumberId: "pn_1" } });
  });

  it("resolveVoiceCreds: inactive when byo + not active", async () => {
    await setTelephonyConnectionStatus(tid, "vapi", "disabled");
    await setTelephonyMode(tid, "byo");
    expect(await resolveVoiceCreds(tid)).toEqual({ source: "inactive" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project @savvy/db packages/db/tests/vapi-lifecycle.test.ts`
Expected: FAIL — `upsertVapiConnection` not exported.

- [ ] **Step 3: Implement** — append to `packages/db/src/lifecycle/telephony.ts` (and widen the two `provider` types). Add:

```ts
export interface VapiSecret {
  apiKey: string;
}

export interface VapiConnectionView {
  provider: "vapi";
  status: IntegrationStatus;
  assistantId: string | null;
  phoneNumberId: string | null;
  lastVerifiedAt: Date | null;
}

export async function upsertVapiConnection(
  tenantId: string,
  input: { secret: VapiSecret; assistantId: string; phoneNumberId: string },
): Promise<void> {
  const sealed = seal(JSON.stringify(input.secret));
  await withTenant(tenantId, (tx) =>
    tx
      .insert(integrationConnection)
      .values({
        tenantId, provider: "vapi", status: "pending",
        secretCiphertext: sealed.ciphertext, secretIv: sealed.iv, secretTag: sealed.tag, keyVersion: sealed.keyVersion,
        metadata: { assistantId: input.assistantId, phoneNumberId: input.phoneNumberId },
      })
      .onConflictDoUpdate({
        target: [integrationConnection.tenantId, integrationConnection.provider],
        set: {
          status: "pending",
          secretCiphertext: sealed.ciphertext, secretIv: sealed.iv, secretTag: sealed.tag, keyVersion: sealed.keyVersion,
          metadata: { assistantId: input.assistantId, phoneNumberId: input.phoneNumberId },
          lastVerifiedAt: null, updatedAt: new Date(),
        },
      }),
  );
}

export async function getVapiConnection(tenantId: string): Promise<VapiConnectionView | null> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.select().from(integrationConnection)
      .where(and(eq(integrationConnection.tenantId, tenantId), eq(integrationConnection.provider, "vapi"))),
  );
  const row = rows[0];
  if (!row) return null;
  const m = row.metadata ?? {};
  return {
    provider: "vapi",
    status: row.status as IntegrationStatus,
    assistantId: typeof m.assistantId === "string" ? m.assistantId : null,
    phoneNumberId: typeof m.phoneNumberId === "string" ? m.phoneNumberId : null,
    lastVerifiedAt: row.lastVerifiedAt ?? null,
  };
}

export async function getVapiSecret(tenantId: string): Promise<VapiSecret | null> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.select().from(integrationConnection)
      .where(and(eq(integrationConnection.tenantId, tenantId), eq(integrationConnection.provider, "vapi"))),
  );
  const row = rows[0];
  if (!row) return null;
  const sealed: SealedSecret = { ciphertext: row.secretCiphertext, iv: row.secretIv, tag: row.secretTag, keyVersion: row.keyVersion };
  return JSON.parse(open(sealed)) as VapiSecret;
}

export type VoiceResolution =
  | { source: "platform" | "tenant"; vapi: { apiKey: string; assistantId: string; phoneNumberId: string } }
  | { source: "inactive" };

export async function resolveVoiceCreds(tenantId: string): Promise<VoiceResolution> {
  const mode = await getTelephonyMode(tenantId);
  if (mode === "platform") {
    return {
      source: "platform",
      vapi: {
        apiKey: process.env.VAPI_API_KEY ?? "",
        assistantId: process.env.VAPI_ASSISTANT_ID ?? "",
        phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID ?? "",
      },
    };
  }
  const view = await getVapiConnection(tenantId);
  if (!view || view.status !== "active") return { source: "inactive" };
  const secret = await getVapiSecret(tenantId);
  if (!secret) return { source: "inactive" };
  return {
    source: "tenant",
    vapi: { apiKey: secret.apiKey, assistantId: view.assistantId ?? "", phoneNumberId: view.phoneNumberId ?? "" },
  };
}
```
Then widen the `provider` param type on `setTelephonyConnectionStatus` and `disconnectTelephony` from `"twilio"` to `"twilio" | "vapi"` (signatures only; bodies unchanged).

- [ ] **Step 4: Re-export** — add to the named block in `packages/db/src/index.ts`:

```ts
upsertVapiConnection, getVapiConnection, getVapiSecret, resolveVoiceCreds,
type VapiSecret, type VapiConnectionView, type VoiceResolution,
```

- [ ] **Step 5: Run the test + typecheck**

Run: `npx vitest run --project @savvy/db packages/db/tests/vapi-lifecycle.test.ts` (4 passing) then `pnpm --filter @savvy/db typecheck`.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/lifecycle/telephony.ts packages/db/src/index.ts packages/db/tests/vapi-lifecycle.test.ts
git commit -m "feat(db): vapi connection lifecycle + resolveVoiceCreds (provider='vapi')"
```

---

### Task 6: `makeHttpVapi(creds)` + `verifyVapiCreds` factory (`@savvy/integrations`)

**Files:**
- Modify: `packages/integrations/src/vapi.ts`
- Modify: `packages/integrations/src/index.ts`
- Create: `packages/integrations/src/vapi.test.ts`

**Interfaces:**
- Produces:
  - `interface VapiApiCreds { apiKey: string; assistantId: string; phoneNumberId: string }`
  - `makeHttpVapi(creds: VapiApiCreds): VoiceGateway`
  - `verifyVapiCreds(creds: { apiKey: string; assistantId: string }, fetchImpl?: typeof fetch): Promise<boolean>`
- Keeps: the env-bound `httpVapi`/`voice` exports unchanged (platform path).

- [ ] **Step 1: Write the failing test** — create `packages/integrations/src/vapi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeHttpVapi, verifyVapiCreds } from "./vapi";

describe("vapi factory", () => {
  it("makeHttpVapi places a call using injected creds", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.assistantId).toBe("asst_byo");
      expect(body.phoneNumberId).toBe("pn_byo");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer key_byo");
      return new Response(JSON.stringify({ id: "call_1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const gw = makeHttpVapi({ apiKey: "key_byo", assistantId: "asst_byo", phoneNumberId: "pn_byo" }, fakeFetch);
    const r = await gw.placeOutboundCall({ toPhone: "+1480", assistantOverrides: {} as never, metadata: {} });
    expect(r).toEqual({ callId: "call_1" });
  });

  it("verifyVapiCreds returns true on 200", async () => {
    const fakeFetch = (async (url: string) => { expect(url).toContain("/assistant/asst_1"); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    expect(await verifyVapiCreds({ apiKey: "k", assistantId: "asst_1" }, fakeFetch)).toBe(true);
  });

  it("verifyVapiCreds returns false on 401", async () => {
    const fakeFetch = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    expect(await verifyVapiCreds({ apiKey: "bad", assistantId: "asst_1" }, fakeFetch)).toBe(false);
  });
});
```
> `makeHttpVapi` takes an optional 2nd `fetchImpl` arg (default `fetch`) for testability — mirror `verifyTwilioCreds`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project @savvy/integrations packages/integrations/src/vapi.test.ts`
Expected: FAIL — `makeHttpVapi` not exported.

- [ ] **Step 3: Implement** — add to `packages/integrations/src/vapi.ts` (keep `httpVapi`/`voice` as-is):

```ts
export interface VapiApiCreds {
  apiKey: string;
  assistantId: string;
  phoneNumberId: string;
}

/** Build a VoiceGateway from explicit creds (per-tenant BYO or platform env). */
export function makeHttpVapi(creds: VapiApiCreds, fetchImpl: typeof fetch = fetch): VoiceGateway {
  return {
    async placeOutboundCall({ toPhone, assistantOverrides, metadata }) {
      if (!creds.apiKey || !creds.assistantId || !creds.phoneNumberId) return null;
      try {
        const res = await fetchImpl(`${VAPI_BASE}/call`, {
          method: "POST",
          headers: { authorization: `Bearer ${creds.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            assistantId: creds.assistantId,
            phoneNumberId: creds.phoneNumberId,
            assistantOverrides,
            customer: { number: toPhone },
            metadata,
          }),
        });
        if (!res.ok) return null;
        const d = (await res.json()) as { id?: string };
        return d.id ? { callId: d.id } : null;
      } catch {
        return null;
      }
    },
  };
}

/** Cheap auth check: GET the assistant resource. 2xx ⇒ creds valid. */
export async function verifyVapiCreds(
  creds: { apiKey: string; assistantId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const res = await fetchImpl(`${VAPI_BASE}/assistant/${creds.assistantId}`, {
    headers: { authorization: `Bearer ${creds.apiKey}` },
  });
  return res.ok;
}
```
> `VAPI_BASE` is already declared at module scope. Optionally refactor `httpVapi` to delegate to `makeHttpVapi({...env})` (mirrors `twilioSms` → `makeTwilioSms`) — do so only if it stays behavior-identical; otherwise leave `httpVapi` untouched.

- [ ] **Step 4: Export** — in `packages/integrations/src/index.ts:15`, extend the vapi re-export:

```ts
export { voice, httpVapi, makeFakeVoice, makeHttpVapi, verifyVapiCreds, type VoiceGateway, type VapiApiCreds } from "./vapi";
```

- [ ] **Step 5: Run test + full integrations suite + typecheck**

Run: `npx vitest run --project @savvy/integrations packages/integrations/src/vapi.test.ts` (3 passing), then `npx vitest run --project @savvy/integrations` (no regressions), then `pnpm --filter @savvy/integrations typecheck`.

- [ ] **Step 6: Commit**

```bash
git add packages/integrations/src/vapi.ts packages/integrations/src/vapi.test.ts packages/integrations/src/index.ts
git commit -m "feat(integrations): makeHttpVapi + verifyVapiCreds factory"
```

---

### Task 7: `getTenantVoice` helper + thread into `voice-fallback`

**Files:**
- Modify: `packages/agents/src/telephony.ts` (add `getTenantVoice`)
- Modify: `packages/agents/src/telephony.test.ts` (add tests)
- Modify: `packages/agents/src/functions/voice-fallback.ts:97-101`

**Interfaces:**
- Consumes: `resolveVoiceCreds` from `@savvy/db`; `makeHttpVapi`, `voice`, `type VoiceGateway` from `@savvy/integrations`.
- Produces: `getTenantVoice(tenantId: string, deps?: TenantVoiceDeps): Promise<VoiceGateway>` with `interface TenantVoiceDeps { resolve: typeof resolveVoiceCreds; platformVoice: VoiceGateway }`.

- [ ] **Step 1: Add failing tests** to `packages/agents/src/telephony.test.ts`:

```ts
import { getTenantVoice, type TenantVoiceDeps } from "./telephony";

function vdeps(result: unknown): TenantVoiceDeps {
  return {
    resolve: vi.fn().mockResolvedValue(result) as unknown as TenantVoiceDeps["resolve"],
    platformVoice: { placeOutboundCall: vi.fn().mockResolvedValue({ callId: "platform" }) },
  };
}

describe("getTenantVoice", () => {
  it("byo + active full creds → tenant gateway (not platform)", async () => {
    const d = vdeps({ source: "tenant", vapi: { apiKey: "k", assistantId: "a", phoneNumberId: "p" } });
    const gw = await getTenantVoice("t1", d);
    expect(gw).not.toBe(d.platformVoice);
  });
  it("platform → platform gateway", async () => {
    const d = vdeps({ source: "platform", vapi: { apiKey: "k", assistantId: "a", phoneNumberId: "p" } });
    expect(await getTenantVoice("t1", d)).toBe(d.platformVoice);
  });
  it("inactive → platform gateway", async () => {
    const d = vdeps({ source: "inactive" });
    expect(await getTenantVoice("t1", d)).toBe(d.platformVoice);
  });
  it("tenant but empty creds → platform gateway", async () => {
    const d = vdeps({ source: "tenant", vapi: { apiKey: "", assistantId: "", phoneNumberId: "" } });
    expect(await getTenantVoice("t1", d)).toBe(d.platformVoice);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run --project @savvy/agents packages/agents/src/telephony.test.ts` → FAIL (`getTenantVoice` missing).

- [ ] **Step 3: Implement** — add to `packages/agents/src/telephony.ts`:

```ts
import { resolveTelephonyCreds, resolveVoiceCreds } from "@savvy/db";
import { makeTwilioSms, makeHttpVapi, sms, smsFrom, voice, type SmsSender, type VoiceGateway } from "@savvy/integrations";

export interface TenantVoiceDeps {
  resolve: typeof resolveVoiceCreds;
  platformVoice: VoiceGateway;
}
const defaultVoiceDeps: TenantVoiceDeps = { resolve: resolveVoiceCreds, platformVoice: voice };

export async function getTenantVoice(tenantId: string, deps: TenantVoiceDeps = defaultVoiceDeps): Promise<VoiceGateway> {
  const r = await deps.resolve(tenantId);
  if (r.source === "tenant" && r.vapi.apiKey && r.vapi.assistantId && r.vapi.phoneNumberId) {
    return makeHttpVapi(r.vapi);
  }
  return deps.platformVoice;
}
```
(merge the imports with the existing ones at the top of the file).

- [ ] **Step 4: Thread into `voice-fallback.ts`** — replace the module `voice` usage at lines 97-101:

```ts
const gateway = await getTenantVoice(tenantId);
const result = await gateway.placeOutboundCall({
  toPhone: decision.phone,
  assistantOverrides: overrides,
  metadata: { leadId, tenantId, direction: "outbound", toPhone: decision.phone },
});
```
Add `import { getTenantVoice } from "../telephony";`; drop the now-unused `voice` import if nothing else uses it.

- [ ] **Step 5: Run agents tests + typecheck**

Run: `npx vitest run --project @savvy/agents packages/agents/src/telephony.test.ts packages/agents/src/functions/voice-fallback.test.ts` then `npx vitest run --project @savvy/agents` then `pnpm --filter @savvy/agents typecheck`.
Expected: green. (If `voice-fallback.test.ts` asserted on the module `voice` singleton, switch it to inject via `getTenantVoice`'s deps or assert the outcome; only change a failing test.)

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/telephony.ts packages/agents/src/telephony.test.ts packages/agents/src/functions/voice-fallback.ts
git commit -m "feat(agents): getTenantVoice + route outbound Vapi through tenant creds"
```

---

### Task 8: Vapi connect UI + server actions (`apps/web`)

**Files:**
- Modify: `apps/web/src/lib/telephony-actions.ts` (add Vapi actions)
- Modify: `apps/web/src/app/(app)/settings/integrations/page.tsx` (load vapi connection)
- Modify: `apps/web/src/app/(app)/settings/integrations/TelephonyCard.tsx` (add Vapi section)

**Interfaces:**
- Consumes (db, Task 5): `getVapiConnection`, `getVapiSecret`, `upsertVapiConnection`; (integrations, Task 6) `verifyVapiCreds`; existing `setTelephonyConnectionStatus`, `disconnectTelephony` (now accept `"vapi"`); `getTenantId`, `getCurrentUser`, `isOrgAdmin`.
- Produces server actions: `saveVapiConnectionAction({ apiKey, assistantId, phoneNumberId })`, `testVapiConnectionAction()`, `disconnectVapiAction()` — each `{ ok: true } | { error: string }`, admin-gated, `revalidatePath("/settings/integrations")`.

- [ ] **Step 1: Add the Vapi server actions** — in `apps/web/src/lib/telephony-actions.ts`, mirroring the Twilio actions (each starts with `if (!(await isOrgAdmin())) return { error: "forbidden" };`):

```ts
export async function saveVapiConnectionAction(input: {
  apiKey: string; assistantId: string; phoneNumberId: string;
}): Promise<{ ok: true } | { error: string }> {
  if (!(await isOrgAdmin())) return { error: "forbidden" };
  if (!input.apiKey || !input.assistantId || !input.phoneNumberId) return { error: "missing_fields" };
  const tenantId = await getTenantId();
  await upsertVapiConnection(tenantId, { secret: { apiKey: input.apiKey }, assistantId: input.assistantId, phoneNumberId: input.phoneNumberId });
  revalidatePath("/settings/integrations");
  return { ok: true };
}

export async function testVapiConnectionAction(): Promise<{ ok: true } | { error: string }> {
  if (!(await isOrgAdmin())) return { error: "forbidden" };
  const tenantId = await getTenantId();
  const secret = await getVapiSecret(tenantId);
  const view = await getVapiConnection(tenantId);
  if (!secret || !view?.assistantId) return { error: "no_connection" };
  const valid = await verifyVapiCreds({ apiKey: secret.apiKey, assistantId: view.assistantId });
  await setTelephonyConnectionStatus(tenantId, "vapi", valid ? "active" : "pending", { verifiedNow: valid });
  revalidatePath("/settings/integrations");
  return valid ? { ok: true } : { error: "verify_failed" };
}

export async function disconnectVapiAction(): Promise<{ ok: true } | { error: string }> {
  if (!(await isOrgAdmin())) return { error: "forbidden" };
  try {
    const tenantId = await getTenantId();
    await disconnectTelephony(tenantId, "vapi");
    revalidatePath("/settings/integrations");
    return { ok: true };
  } catch { return { error: "disconnect_failed" }; }
}
```
Update the imports at the top to add `upsertVapiConnection, getVapiSecret, getVapiConnection` from `@savvy/db` and `verifyVapiCreds` from `@savvy/integrations`.

- [ ] **Step 2: Load the vapi connection in the page** — in `settings/integrations/page.tsx`, also fetch `const vapi = await getVapiConnection(tenantId);` and pass `vapiStatus={vapi?.status ?? null}`, `vapiAssistantId={vapi?.assistantId ?? null}`, `vapiPhoneNumberId={vapi?.phoneNumberId ?? null}` to `TelephonyCard`.

- [ ] **Step 3: Add a Vapi section to `TelephonyCard.tsx`** — within the `mode === "byo"` block, after the Twilio inputs, add a Vapi sub-section using the shadcn `Input` (apiKey type="password", assistantId, phoneNumberId pre-filled from props) with Save / Test / Disconnect buttons wired to the three new actions (reuse the existing `run(fn, msg)` helper). Add the three props to the `Props` interface.

- [ ] **Step 4: Typecheck + build**

Run: `pnpm --filter @savvy/web typecheck` then `pnpm --filter @savvy/web build`
Expected: typecheck clean; Turbopack compiles (known `/_not-found` Clerk prerender gap aside).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/telephony-actions.ts "apps/web/src/app/(app)/settings/integrations"
git commit -m "feat(web): Vapi BYO connect section (save/test/disconnect, admin-gated)"
```

---

### Task 9: Final verification

- [ ] **Step 1: Full sweep** — run and confirm clean:
- `npx vitest run --project @savvy/agents`
- `npx vitest run --project @savvy/integrations`
- `npx vitest run --project @savvy/db packages/db/tests/telephony-schema.test.ts packages/db/tests/telephony-lifecycle.test.ts packages/db/tests/vapi-lifecycle.test.ts`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm --filter @savvy/web build` (Turbopack compile succeeds; known Clerk prerender gap aside)

- [ ] **Step 2: Manual trace check (no code change)** — confirm by reading: every one of the 8 SMS sites now calls `getTenantSms(tenantId)`; `voice-fallback` calls `getTenantVoice(tenantId)`; no remaining `from: smsFrom()` paired with a module `sms.sendSms` in a tenant-scoped send. Note any site intentionally left on the global path.

- [ ] **Step 3: Commit any test adjustments made during the sweep** (if a site test needed updating to the injected-resolver pattern), else nothing to commit.

---

## Plan 2a deliverable & what's deferred to Plan 2b
**Delivered:** outbound SMS (all 8 sites) and outbound Vapi voice route through each `byo`+active tenant's own credentials, with platform fallback for platform-mode / inactive / empty-creds; a Vapi BYO connect UI. Behavior-preserving for every platform-mode tenant.

**Deferred to Plan 2b:** inbound Vapi routing — resolve the tenant from the inbound payload's `assistantId`/`phoneNumberId` (extend `parseVapiMessage` to surface them; add `tenantByVapiAssistant`), BYO-first with fallthrough to today's dialed-number (`tenantByPhone`) resolution.

## Self-review notes
- **Spec coverage:** §A SMS activation → Tasks 1–4; §B Vapi connect UI + outbound → Tasks 5–8; §D fallback policy → Tasks 1 & 7 (single point); §E testing → each task + Task 9. §C inbound = Plan 2b (out of scope here).
- **Cycle safety:** composition helpers live in `@savvy/agents`; `@savvy/integrations` receives only plain creds (Global Constraints).
- **Type consistency:** `ResolvedTwilioCreds.from` feeds `getTenantSms`; `VoiceResolution.vapi` feeds `getTenantVoice` → `makeHttpVapi(VapiApiCreds)`. `TwilioApiCreds`/`VapiApiCreds` are the integration-layer cred shapes; the db resolvers return the `{source,...}` wrappers.
- **Test seams preserved:** `SendDeps` (now incl. `from`) and `runRepAlert(ctx, sender?)` remain injectable; resolution happens at the owning call site.
