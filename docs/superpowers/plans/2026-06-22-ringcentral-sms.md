# RingCentral SMS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send and receive SMS through RingCentral as an env-selected alternative to Twilio (Twilio stays for voice + as the default), so the pilot's RingCentral-based roofing company can use its own number.

**Architecture:** A new `ringcentralSms` adapter implements the existing `SmsSender` interface (JWT auth + cached token + `account/~/extension/~/sms`). A tiny `selectSms(env)` picks the provider; the four agent consumers import the selected `sms` instead of `twilioSms`. Inbound SMS arrives via a RingCentral webhook **subscription** → a new `/api/ringcentral/inbound` route parses the payload (pure parser, unit-tested) and calls the existing provider-agnostic `handleInboundSms` (STOP/CANCEL/opt-out). A one-time `rc:subscribe` script registers the webhook.

**Tech Stack:** TypeScript, `@savvy/integrations` (vitest unit), `@savvy/agents` (Inngest consumers), Next.js route handler (apps/web, Playwright e2e — no vitest there), `pnpm` + Turborepo.

**Spec:** `docs/superpowers/specs/2026-06-22-ringcentral-sms-design.md`

**Gate (repo root):**
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Docker `savvy_db` running + migrated. **apps/web is Playwright-only** — the route is validated by an e2e + the pure parser's unit tests, not a vitest.

---

## File Structure

| File | Responsibility | Task |
|------|----------------|------|
| `packages/integrations/src/ringcentral.ts` | `makeRingCentralSms` (JWT auth + token cache + send), `ringcentralSms`, `parseRingCentralInboundSms` | 1, 3 |
| `packages/integrations/src/ringcentral.test.ts` | unit: auth/caching, send shape, error, inbound parser | 1, 3 |
| `packages/integrations/src/comms.ts` | `selectSms(env)` + `export const sms` | 2 |
| `packages/integrations/src/comms.test.ts` | unit: selector picks ringcentral vs twilio | 2 |
| `packages/integrations/src/index.ts` | export `sms`, `ringcentralSms`, `makeRingCentralSms`, `parseRingCentralInboundSms` | 2, 3 |
| `packages/agents/src/functions/{drip,lead-intake,dunning,appointment-reminders}.ts` | import `sms` instead of `twilioSms` | 2 |
| `apps/web/src/app/api/ringcentral/inbound/route.ts` | validation handshake + verify + parse + `handleInboundSms` | 4 |
| `apps/web/tests/e2e/ringcentral.spec.ts` | e2e: inbound SMS → comm logged + STOP opt-out; validation handshake | 4 |
| `packages/integrations/src/scripts/rc-subscribe.ts` + root `package.json` | one-time `pnpm rc:subscribe` | 5 |
| `.env.example`, `.env.production.example` | RingCentral env keys | 5 |

---

## Task 1: RingCentral outbound adapter (JWT auth + cached token + send)

**Files:**
- Create: `packages/integrations/src/ringcentral.ts`
- Test: `packages/integrations/src/ringcentral.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/integrations/src/ringcentral.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { makeRingCentralSms } from "./ringcentral";

function mockFetch(handlers: Array<(url: string, init: RequestInit) => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handlers[Math.min(i++, handlers.length - 1)]!(url, init);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const cfg = {
  serverUrl: "https://platform.ringcentral.test",
  clientId: "cid", clientSecret: "csec", jwt: "jwt-token", from: "+15555550000",
};

describe("makeRingCentralSms", () => {
  it("exchanges the JWT for a token, then sends an SMS with the right shape", async () => {
    const { fn, calls } = mockFetch([
      () => json({ access_token: "AT1", expires_in: 3600 }),
      () => json({ id: 42 }),
    ]);
    const sms = makeRingCentralSms({ ...cfg, fetchImpl: fn });
    const res = await sms.sendSms({ to: "+15551234567", from: cfg.from, body: "hi" });
    expect(res).toEqual({ sid: "42" });

    // auth call
    expect(calls[0]!.url).toBe("https://platform.ringcentral.test/restapi/oauth/token");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      "Basic " + Buffer.from("cid:csec").toString("base64"),
    );
    expect(String(calls[0]!.init.body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    expect(String(calls[0]!.init.body)).toContain("assertion=jwt-token");

    // send call
    expect(calls[1]!.url).toBe("https://platform.ringcentral.test/restapi/v1.0/account/~/extension/~/sms");
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe("Bearer AT1");
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      from: { phoneNumber: "+15555550000" }, to: [{ phoneNumber: "+15551234567" }], text: "hi",
    });
  });

  it("reuses the cached token across sends (only one auth call)", async () => {
    const { fn, calls } = mockFetch([
      () => json({ access_token: "AT1", expires_in: 3600 }),
      () => json({ id: 1 }),
      () => json({ id: 2 }),
    ]);
    const sms = makeRingCentralSms({ ...cfg, fetchImpl: fn });
    await sms.sendSms({ to: "+1", from: cfg.from, body: "a" });
    await sms.sendSms({ to: "+2", from: cfg.from, body: "b" });
    const authCalls = calls.filter((c) => c.url.endsWith("/restapi/oauth/token"));
    expect(authCalls).toHaveLength(1);
  });

  it("throws a descriptive error on a non-2xx send", async () => {
    const { fn } = mockFetch([
      () => json({ access_token: "AT1", expires_in: 3600 }),
      () => json({ message: "bad" }, 400),
    ]);
    const sms = makeRingCentralSms({ ...cfg, fetchImpl: fn });
    await expect(sms.sendSms({ to: "+1", from: cfg.from, body: "x" })).rejects.toThrow(/ringcentral send failed: 400/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @savvy/integrations test -- ringcentral`
Expected: FAIL — `makeRingCentralSms` not exported.

- [ ] **Step 3: Implement the adapter**

Create `packages/integrations/src/ringcentral.ts`:

```ts
import type { SmsSender } from "./twilio";

export interface RingCentralConfig {
  serverUrl: string;
  clientId: string;
  clientSecret: string;
  jwt: string;
  from: string;
  fetchImpl?: typeof fetch;
}

const JWT_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/** Factory so tests inject fetch; the token cache is closure-local (per instance). */
export function makeRingCentralSms(cfg: RingCentralConfig): SmsSender {
  const doFetch = cfg.fetchImpl ?? fetch;
  let cached: { token: string; expiresAt: number } | null = null;

  async function token(): Promise<string> {
    const now = Date.now();
    if (cached && now < cached.expiresAt - 60_000) return cached.token;
    const res = await doFetch(`${cfg.serverUrl}/restapi/oauth/token`, {
      method: "POST",
      headers: {
        authorization: "Basic " + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: JWT_GRANT, assertion: cfg.jwt }).toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`ringcentral auth failed: ${res.status} ${detail}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: data.access_token, expiresAt: now + data.expires_in * 1000 };
    return cached.token;
  }

  return {
    async sendSms({ to, from, body }) {
      const at = await token();
      const res = await doFetch(`${cfg.serverUrl}/restapi/v1.0/account/~/extension/~/sms`, {
        method: "POST",
        headers: { authorization: `Bearer ${at}`, "content-type": "application/json" },
        body: JSON.stringify({ from: { phoneNumber: from }, to: [{ phoneNumber: to }], text: body }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`ringcentral send failed: ${res.status} ${detail}`);
      }
      const data = (await res.json()) as { id: number | string };
      return { sid: String(data.id) };
    },
  };
}

// Real instance bound to env. Feature code uses the `sms` selector (comms.ts), not this directly.
export const ringcentralSms: SmsSender = makeRingCentralSms({
  serverUrl: process.env.RINGCENTRAL_SERVER_URL ?? "https://platform.ringcentral.com",
  clientId: process.env.RINGCENTRAL_CLIENT_ID ?? "",
  clientSecret: process.env.RINGCENTRAL_CLIENT_SECRET ?? "",
  jwt: process.env.RINGCENTRAL_JWT ?? "",
  from: process.env.RINGCENTRAL_FROM_NUMBER ?? "",
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @savvy/integrations test -- ringcentral`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/integrations/src/ringcentral.ts packages/integrations/src/ringcentral.test.ts
git commit -m "feat(integrations): RingCentral SMS adapter (JWT auth + cached token)"
```

---

## Task 2: env-selected `sms` gateway + repoint consumers

**Files:**
- Create: `packages/integrations/src/comms.ts`, `packages/integrations/src/comms.test.ts`
- Modify: `packages/integrations/src/index.ts`
- Modify: `packages/agents/src/functions/drip.ts`, `lead-intake.ts`, `dunning.ts`, `appointment-reminders.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/integrations/src/comms.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { selectSms } from "./comms";
import { ringcentralSms } from "./ringcentral";
import { twilioSms } from "./twilio";

describe("selectSms", () => {
  it("returns RingCentral when TELEPHONY_SMS_PROVIDER=ringcentral", () => {
    expect(selectSms({ TELEPHONY_SMS_PROVIDER: "ringcentral" })).toBe(ringcentralSms);
  });
  it("defaults to Twilio when unset or any other value", () => {
    expect(selectSms({})).toBe(twilioSms);
    expect(selectSms({ TELEPHONY_SMS_PROVIDER: "twilio" })).toBe(twilioSms);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @savvy/integrations test -- comms`
Expected: FAIL — `./comms` / `selectSms` not found.

- [ ] **Step 3: Implement the selector**

Create `packages/integrations/src/comms.ts`:

```ts
import type { SmsSender } from "./twilio";
import { twilioSms } from "./twilio";
import { ringcentralSms } from "./ringcentral";

/** Pure selector — pass an env bag for testing. */
export function selectSms(env: { TELEPHONY_SMS_PROVIDER?: string } = process.env): SmsSender {
  return env.TELEPHONY_SMS_PROVIDER === "ringcentral" ? ringcentralSms : twilioSms;
}

/** The SMS sender feature code should import. Resolved once at module load from env. */
export const sms: SmsSender = selectSms();
```

- [ ] **Step 4: Export from the package index**

In `packages/integrations/src/index.ts`, add:

```ts
export { ringcentralSms, makeRingCentralSms } from "./ringcentral";
export { sms, selectSms } from "./comms";
```

- [ ] **Step 5: Repoint the four consumers from `twilioSms` to `sms`**

In each file, change the import and the use. The `SmsSender` type import stays where present.

`packages/agents/src/functions/lead-intake.ts`:
- line ~6: `import { twilioSms, type SmsSender } from "@savvy/integrations";` → `import { sms, type SmsSender } from "@savvy/integrations";`
- line ~67: `const sender: SmsSender = twilioSms;` → `const sender: SmsSender = sms;`

`packages/agents/src/functions/drip.ts`:
- line ~7: `import { twilioSms, resendEmail } from "@savvy/integrations";` → `import { sms, resendEmail } from "@savvy/integrations";`
- line ~181 (the `sendDripStep` default deps): `{ sms: twilioSms, email: resendEmail }` → `{ sms, email: resendEmail }`

`packages/agents/src/functions/dunning.ts`:
- line ~17: `import { twilioSms, resendEmail } from "@savvy/integrations";` → `import { sms, resendEmail } from "@savvy/integrations";`
- line ~146: `await twilioSms.sendSms({` → `await sms.sendSms({`

`packages/agents/src/functions/appointment-reminders.ts`:
- line ~3: `import { twilioSms, resendEmail } from "@savvy/integrations";` → `import { sms, resendEmail } from "@savvy/integrations";`
- line ~75: `await twilioSms.sendSms({` → `await sms.sendSms({`

(Read each file first; if line numbers drifted, find the `twilioSms` token and swap it for `sms`. Do NOT touch the `resendEmail` references — those change in the separate Gmail build.)

- [ ] **Step 6: Run the gate**

Run: `export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy && pnpm typecheck && pnpm lint && pnpm --filter @savvy/integrations test && pnpm --filter @savvy/agents test`
Expected: PASS. (The agent tests inject their own `SendDeps`/mocks, so swapping the default import doesn't change them; `selectSms` defaults to Twilio when `TELEPHONY_SMS_PROVIDER` is unset, preserving today's behavior.)

- [ ] **Step 7: Commit**

```bash
git add packages/integrations/src/comms.ts packages/integrations/src/comms.test.ts packages/integrations/src/index.ts packages/agents/src/functions/drip.ts packages/agents/src/functions/lead-intake.ts packages/agents/src/functions/dunning.ts packages/agents/src/functions/appointment-reminders.ts
git commit -m "feat(comms): env-selected sms gateway; consumers use it instead of twilioSms"
```

---

## Task 3: inbound SMS payload parser (pure, TDD)

**Files:**
- Modify: `packages/integrations/src/ringcentral.ts` (add `parseRingCentralInboundSms`)
- Modify: `packages/integrations/src/ringcentral.test.ts` (add parser tests)
- Modify: `packages/integrations/src/index.ts` (export it)

- [ ] **Step 1: Write the failing test**

Append to `packages/integrations/src/ringcentral.test.ts`:

```ts
import { parseRingCentralInboundSms } from "./ringcentral";

describe("parseRingCentralInboundSms", () => {
  // RC message-store "instant" notification for an inbound SMS.
  const payload = {
    event: "/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS",
    body: {
      changes: [{ type: "SMS" }],
      lastUpdated: "2026-06-22T10:00:00Z",
      from: { phoneNumber: "+15551112222" },
      to: [{ phoneNumber: "+15555550000" }],
      type: "SMS",
      subject: "STOP",
      id: 9001,
      direction: "Inbound",
    },
  };

  it("extracts to/from/body/messageId for an inbound SMS", () => {
    expect(parseRingCentralInboundSms(payload)).toEqual([
      { to: "+15555550000", from: "+15551112222", body: "STOP", messageId: "9001" },
    ]);
  });

  it("ignores non-inbound or non-SMS payloads", () => {
    expect(parseRingCentralInboundSms({ body: { type: "Fax", direction: "Inbound", subject: "x" } })).toEqual([]);
    expect(parseRingCentralInboundSms({ body: { type: "SMS", direction: "Outbound", subject: "x" } })).toEqual([]);
    expect(parseRingCentralInboundSms({})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @savvy/integrations test -- ringcentral`
Expected: FAIL — `parseRingCentralInboundSms` not exported.

- [ ] **Step 3: Implement the parser**

Append to `packages/integrations/src/ringcentral.ts`:

```ts
export type InboundSms = { to: string; from: string; body: string; messageId: string };

/** Parse a RingCentral message-store notification into inbound SMS items.
 *  RC puts the message text in `subject`; we only act on Inbound SMS. */
export function parseRingCentralInboundSms(payload: unknown): InboundSms[] {
  const body = (payload as { body?: Record<string, unknown> } | null)?.body;
  if (!body) return [];
  if (body.type !== "SMS" || body.direction !== "Inbound") return [];
  const from = (body.from as { phoneNumber?: string } | undefined)?.phoneNumber;
  const toArr = (body.to as Array<{ phoneNumber?: string }> | undefined) ?? [];
  const to = toArr[0]?.phoneNumber;
  const text = typeof body.subject === "string" ? body.subject : "";
  if (!from || !to) return [];
  return [{ to, from, body: text, messageId: String(body.id ?? "") }];
}
```

- [ ] **Step 4: Export it**

In `packages/integrations/src/index.ts`, extend the ringcentral export:

```ts
export { ringcentralSms, makeRingCentralSms, parseRingCentralInboundSms, type InboundSms } from "./ringcentral";
```
(Replace the line added in Task 2 Step 4 so it includes the parser + type.)

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @savvy/integrations test -- ringcentral`
Expected: PASS (5 tests total).

- [ ] **Step 6: Commit**

```bash
git add packages/integrations/src/ringcentral.ts packages/integrations/src/ringcentral.test.ts packages/integrations/src/index.ts
git commit -m "feat(integrations): parseRingCentralInboundSms (message-store notification → SMS items)"
```

---

## Task 4: inbound webhook route + e2e

**Files:**
- Create: `apps/web/src/app/api/ringcentral/inbound/route.ts`
- Create: `apps/web/tests/e2e/ringcentral.spec.ts`

- [ ] **Step 1: Implement the route**

Create `apps/web/src/app/api/ringcentral/inbound/route.ts`. It mirrors `apps/web/src/app/api/twilio/inbound/route.ts` (read it first) but parses RC's JSON + handles RC's validation/verification headers.

```ts
import { NextResponse } from "next/server";
import { parseRingCentralInboundSms } from "@savvy/integrations";
import { tenantByPhone } from "@/lib/intake";
import { handleInboundSms } from "@/lib/inbound-sms";
import { log } from "@/lib/log";

export const runtime = "nodejs";

// RingCentral webhook. Two non-event cases first:
//  1) Subscription creation/renewal handshake: RC sends a `Validation-Token` header
//     that MUST be echoed back verbatim (200, empty body).
//  2) Per-delivery auth: RC echoes the `verificationToken` we set at subscribe time
//     in the `Verification-Token` header; reject mismatches when we have one configured.
export async function POST(req: Request) {
  const validation = req.headers.get("Validation-Token");
  if (validation) {
    return new NextResponse(null, { status: 200, headers: { "Validation-Token": validation } });
  }
  const expected = process.env.RINGCENTRAL_WEBHOOK_TOKEN;
  if (expected && req.headers.get("Verification-Token") !== expected) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const payload = await req.json().catch(() => null);
  const items = parseRingCentralInboundSms(payload);
  log.info("ringcentral inbound received", { route: "/api/ringcentral/inbound", items: items.length });
  for (const it of items) {
    const t = await tenantByPhone(it.to);
    if (!t) continue;
    await handleInboundSms(t.id, { from: it.from, body: it.body, twilioSid: it.messageId });
  }
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Write the e2e**

Create `apps/web/tests/e2e/ringcentral.spec.ts`. Read `apps/web/tests/e2e/comms.spec.ts` first for how it seeds a customer and asserts opt-out, and reuse `/tmp/savvy-e2e-tenant.json` + the tenant's inbound phone number (the route maps `to` → tenant via `tenantByPhone`; seed/lookup the tenant's number the same way `comms.spec.ts` / `lead-intake.spec.ts` does).

```ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, customer, communication, tenant, eq, and } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

async function tenantPhone(): Promise<string> {
  const [t] = await withTenant(tenantId, (tx) => tx.select().from(tenant).where(eq(tenant.id, tenantId)));
  // tenant.inboundPhone is what tenantByPhone matches on; fall back to a known seeded value.
  return (t as { inboundPhone?: string }).inboundPhone ?? "+15555550000";
}

function rcSmsPayload(to: string, from: string, text: string) {
  return { body: { type: "SMS", direction: "Inbound", from: { phoneNumber: from }, to: [{ phoneNumber: to }], subject: text, id: Date.now() } };
}

test("ringcentral: validation handshake echoes the token", async ({ request }) => {
  const res = await request.post("/api/ringcentral/inbound", { headers: { "Validation-Token": "vt-123" } });
  expect(res.status()).toBe(200);
  expect(res.headers()["validation-token"]).toBe("vt-123");
});

test("ringcentral: inbound STOP logs the comm and opts the customer out", async ({ request }) => {
  const phone = `+1555${Date.now().toString().slice(-7)}`;
  await withTenant(tenantId, (tx) => tx.insert(customer).values({ tenantId, name: "RC Optout", phone }));
  const to = await tenantPhone();

  const res = await request.post("/api/ringcentral/inbound", { data: rcSmsPayload(to, phone, "STOP") });
  expect(res.ok()).toBeTruthy();

  // inbound communication logged + customer opted out
  const [c] = await withTenant(tenantId, (tx) => tx.select().from(customer).where(eq(customer.phone, phone)));
  expect(c?.smsOptOut).toBe(true);
  const inbound = await withTenant(tenantId, (tx) =>
    tx.select().from(communication).where(and(eq(communication.from, phone), eq(communication.direction, "inbound"))));
  expect(inbound.length).toBeGreaterThan(0);
});
```

> **Implementer notes:** Confirm the tenant's inbound-number field name (`tenant.inboundPhone` per the seed; if `tenantByPhone` matches a different column, seed/assert that one). If the e2e tenant has no inbound number set, set it in the test setup (or use whatever `lead-intake.spec.ts`/`comms.spec.ts` already relies on). The `to` you POST must be the number `tenantByPhone` resolves to this tenant.

- [ ] **Step 3: Run the e2e locally (full harness)**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy AI_STUB_PORT=4010
lsof -ti:4010,8288,3000 | xargs kill -9 2>/dev/null
node apps/web/tests/e2e/ai-stub.mjs > /tmp/ai-stub.log 2>&1 &
npx --yes inngest-cli@latest dev -u http://localhost:3000/api/inngest --no-discovery > /tmp/inngest.log 2>&1 &
sleep 6
pnpm --filter @savvy/web exec tsx tests/e2e/create-tenant.ts
export TEST_TENANT_ID="$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)")"
pnpm --filter @savvy/web exec playwright test ringcentral.spec.ts
lsof -ti:4010,8288,3000 | xargs kill -9 2>/dev/null
```
Expected: 2 passed. Debug timing/seed/number-matching until green; do not weaken assertions.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/api/ringcentral/inbound/route.ts apps/web/tests/e2e/ringcentral.spec.ts
git commit -m "feat(web): /api/ringcentral/inbound — validation handshake + STOP/CANCEL via handleInboundSms"
```

---

## Task 5: subscription setup script + env docs

**Files:**
- Create: `packages/integrations/src/scripts/rc-subscribe.ts`
- Modify: root `package.json` (add `rc:subscribe` script)
- Modify: `.env.example`, `.env.production.example`

- [ ] **Step 1: Implement the subscribe script**

Create `packages/integrations/src/scripts/rc-subscribe.ts` — reuses the same JWT auth as the adapter (factor the token fetch by calling a small exported helper OR inline the same auth call). Inline is fine here:

```ts
// One-time: register a RingCentral WebHook subscription so inbound SMS is pushed to
// our /api/ringcentral/inbound route. Re-runnable. RC WebHook subscriptions expire
// (~7 days / on repeated delivery failure) — re-run to renew for the pilot.
//   pnpm rc:subscribe
async function main() {
  const serverUrl = process.env.RINGCENTRAL_SERVER_URL ?? "https://platform.ringcentral.com";
  const clientId = process.env.RINGCENTRAL_CLIENT_ID ?? "";
  const clientSecret = process.env.RINGCENTRAL_CLIENT_SECRET ?? "";
  const jwt = process.env.RINGCENTRAL_JWT ?? "";
  const appBase = process.env.APP_BASE_URL;
  const verificationToken = process.env.RINGCENTRAL_WEBHOOK_TOKEN ?? "";
  if (!clientId || !clientSecret || !jwt || !appBase) throw new Error("RINGCENTRAL_* and APP_BASE_URL required");

  const authRes = await fetch(`${serverUrl}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString(),
  });
  if (!authRes.ok) throw new Error(`auth failed: ${authRes.status} ${await authRes.text()}`);
  const { access_token } = (await authRes.json()) as { access_token: string };

  const subRes = await fetch(`${serverUrl}/restapi/v1.0/subscription`, {
    method: "POST",
    headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
    body: JSON.stringify({
      eventFilters: ["/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS"],
      deliveryMode: {
        transportType: "WebHook",
        address: `${appBase}/api/ringcentral/inbound`,
        ...(verificationToken ? { verificationToken } : {}),
      },
      expiresIn: 604800,
    }),
  });
  const out = await subRes.text();
  if (!subRes.ok) throw new Error(`subscription failed: ${subRes.status} ${out}`);
  console.log("RingCentral subscription created:", out);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add the script to root `package.json`**

In the root `package.json` `"scripts"` block, add:

```json
"rc:subscribe": "pnpm --filter @savvy/integrations exec tsx src/scripts/rc-subscribe.ts",
```

- [ ] **Step 3: Document env**

Append to `.env.example` AND `.env.production.example` (under a "RingCentral (SMS)" header):

```
# ── Telephony SMS provider ───────────────────────────────────────────
# Set to "ringcentral" to route SMS through RingCentral (voice stays Twilio). Unset = Twilio.
TELEPHONY_SMS_PROVIDER=
RINGCENTRAL_SERVER_URL=https://platform.ringcentral.com
RINGCENTRAL_CLIENT_ID=
RINGCENTRAL_CLIENT_SECRET=
RINGCENTRAL_JWT=
RINGCENTRAL_FROM_NUMBER=
RINGCENTRAL_WEBHOOK_TOKEN=
```

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm typecheck` → PASS.
```bash
git add packages/integrations/src/scripts/rc-subscribe.ts package.json .env.example .env.production.example
git commit -m "feat(comms): rc:subscribe script + RingCentral env docs"
```

---

## Task 6: Full gate, whole-branch review, PR

- [ ] **Step 1: Full gate**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Expected: typecheck 7/7, lint 0, all unit/integration tests pass (incl. new `ringcentral`/`comms` tests).

- [ ] **Step 2: Production build (catches build-only errors CI misses)**

```bash
rm -rf apps/web/.next && pnpm --filter @savvy/web build
```
Expected: compiles; `/api/ringcentral/inbound` appears as a route.

- [ ] **Step 3: Final whole-branch review** — `git diff main...feat/ringcentral-sms`: confirm the four consumers no longer import `twilioSms` (use `sms`), `resendEmail` untouched, the route's validation/verification handshakes are correct, the parser ignores non-inbound/non-SMS, and no secret is logged.

- [ ] **Step 4: Push + PR**

```bash
git push -u origin feat/ringcentral-sms
gh pr create --base main --title "RingCentral SMS (env-selected provider; Twilio stays for voice)" --body "<summary + test plan>"
```

- [ ] **Step 5: Watch CI green, squash-merge**

```bash
gh pr checks <PR#> --watch
gh pr merge <PR#> --squash --delete-branch
```

---

## Self-Review (author)

**Spec coverage:** env-selected `sms` (Task 2 ✅), RC JWT-auth outbound adapter (Task 1 ✅), inbound parse → `handleInboundSms` (Tasks 3–4 ✅), validation handshake + verification token (Task 4 ✅), subscription script (Task 5 ✅), env docs (Task 5 ✅). Voice stays Twilio (untouched ✅). No migration (✅).

**Placeholder scan:** PR body `<…>` in Task 6 is author-filled at PR time. No code placeholders.

**Type consistency:** `SmsSender` reused from `./twilio` throughout; `makeRingCentralSms`/`ringcentralSms`/`parseRingCentralInboundSms`/`InboundSms`/`selectSms`/`sms` names match across tasks and the index exports. The fake impl was intentionally dropped (consumers already try/catch cred-absence and log the comm with a mock sid — verified in `lead-intake.ts`), so dev/e2e stay green with the default Twilio selection.

**Decision noted:** `communication.twilioSid` stores the RC message id for inbound (provider-neutral rename deferred — would need a migration; out of scope).
