# Phase D — AI Voice Agent (Vapi) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fail-open AI voice agent (Vapi) that books inspections in two modes — an outbound 3-minute speed-to-lead fallback (on `lead/contact-overdue`) and a 24/7 inbound receptionist — booking exclusively through the existing scheduling engine.

**Architecture:** A deterministic Inngest workflow + a single shared webhook do the wiring; the LLM lives entirely inside one shared Vapi assistant, configured per-call via `assistantOverrides` (tenant-branded, multi-tenant). The gateway mirrors the env-or-fake pattern of `stormproof.ts`/`distance.ts`: no `VAPI_API_KEY` → outbound no-ops and the webhook is inert but deployable. Booking reuses the Phase A convert→`bookAppointment` flow — never invented times.

**Tech Stack:** TypeScript, pnpm + Turborepo, Drizzle/Postgres (RLS), Inngest, Next.js route handlers, Vitest. Vapi REST (`https://api.vapi.ai`).

## Global Constraints

Copied verbatim from the spec + the build's accumulated gotchas. **Every task implicitly includes these.**

- **NO `.js` import extensions in production `.ts` files** (breaks Turbopack → e2e-only red CI; build+unit still pass). Match sibling files (no extension). Test files (`*.test.ts`) conventionally DO keep `.js` — leave those.
- **Tenant isolation on every DB write.** All reads/writes go through `withTenant(tenantId, tx => …)` or `adminDb` only for cross-tenant resolution (mirror `intake.ts`/`booking-action.ts`). The cross-tenant RLS test stays green.
- **Migration hygiene:** commit the generated `.sql` **and** its drizzle meta (`_journal.json` entry + `NNNN_snapshot.json`) together, or CI/fresh-DB silently skips the migration.
- **Inngest idempotency:** every `inngest.send`/external side-effect goes INSIDE a `step.run`/`step.sendEvent`. A retry must not double-dial — the place-call step is memoized.
- **Date JSON round-trip:** values returned from `step.run` are JSON-serialized — a `Date` becomes a string; coerce with `new Date(...)` before date ops (see `smsConsentAt` handling in `lead-cadence.ts`).
- **Fail-open:** no `VAPI_API_KEY` → `placeOutboundCall` returns `null` (gateway is the fake); the workflow records a `skipped` attempt and never throws. Webhook with no/bad secret → 401, no side effects.
- **AI never invents times or prices:** booking is `getRecommendedSlots` → `bookLeadSlot` (engine). The persona guardrails forbid pricing/deductible/insurance-fraud talk.
- **Config via env, documented in `.env.example`. No secrets in the repo.**
- **Every task ends green:** `pnpm typecheck` + `pnpm lint` clean. Pure-core/integrations unit tests run locally; DB/route/workflow tests are CI-gated (local Postgres `ECONNREFUSED 5432` is EXPECTED).

### Local gate commands (use these — `pnpm --filter` swallows vitest output here)

```bash
cd packages/core && npx vitest run            # Wave 1 core
cd packages/integrations && npx vitest run    # Wave 1 gateway
# from repo root:
pnpm typecheck && pnpm lint
```

DB/route/workflow tests (`packages/db`, `packages/agents`, `apps/web` Playwright) verify in CI.

---

## File Structure

| File | New/Mod | Responsibility |
|---|---|---|
| `packages/core/src/voice-persona.ts` | **new** | Pure: `AssistantOverrides`/`VoiceLeadContext` types, `buildAssistantOverrides`, `parseVoiceOutcome`, `shouldPlaceVoiceCall`, `VoiceOutcome` type. The canonical home of the overrides type (core, so integrations can depend on it). |
| `packages/core/src/index.ts` | mod | Barrel: `export * from "./voice-persona"`. |
| `packages/core/src/voice-persona.test.ts` | **new** | Unit tests (Wave 1, local). |
| `packages/integrations/src/vapi.ts` | **new** | `VoiceGateway` (`placeOutboundCall`), `httpVapi`, `makeFakeVoice`, `voice` singleton. Imports `AssistantOverrides` type from `@savvy/core`. |
| `packages/integrations/src/index.ts` | mod | Barrel: export `voice`, `httpVapi`, `makeFakeVoice`, `VoiceGateway`. |
| `packages/integrations/package.json` | mod | Add `@savvy/core` workspace dep (type-only import). |
| `packages/integrations/src/vapi.test.ts` | **new** | Unit tests (Wave 1, local). |
| `packages/db/src/schema/crm.ts` | mod | Add `voiceOutcome: text("voice_outcome")` to `lead`. |
| `packages/db/drizzle/0020_*.sql` + meta | **new** | `ALTER TABLE "lead" ADD COLUMN "voice_outcome" text;` |
| `packages/db/src/lifecycle/voice.ts` | **new** | `recordVoiceCallReport(...)` — one tenant-scoped tx: insert `communication(channel='call')` + set `lead.voice_outcome`. |
| `packages/db/src/index.ts` | mod | Export `recordVoiceCallReport`. |
| `packages/db/src/lifecycle/voice.test.ts` | **new** | Integration test (Wave 2, CI). |
| `packages/db/src/lifecycle/booking.ts` | **new** | `bookLeadSlot({tenantId,leadId,startsAt,endsAt})` — resolve assignee + convert→`bookAppointment`; returns `{appointmentId,jobId} \| {error}`. NO inngest emit (db must not depend on agents). CI-tested. |
| `packages/db/src/lifecycle/booking.test.ts` | **new** | Integration test (Wave 2, CI). |
| `apps/web/src/lib/booking-action.ts` | mod | `confirmSlot`'s lead-only path delegates to db `bookLeadSlot`, then emits `appointment/booked`. |
| `packages/core/src/voice-webhook.ts` | **new** | Pure: `parseVapiMessage`/`toolResult`. In **core** (NOT apps/web) so vitest runs it. |
| `packages/core/src/voice-webhook.test.ts` | **new** | Unit tests for the parser (Wave 2, local — no DB). |
| `apps/web/src/app/api/voice/vapi/route.ts` | **new** | Shared webhook: `x-vapi-secret` auth; `tool-calls` (getRecommendedSlots/bookSlot) + `end-of-call-report` (transcript + outcome, inbound lead-from-call, no-answer SMS). Emits `appointment/booked` after a tool booking. |
| `apps/web/tests/e2e/voice-webhook.spec.ts` | **new** | Playwright e2e: wrong/missing secret → 401, correct secret + unknown type → 200. (apps/web has NO vitest project — `vitest.workspace.ts = ["packages/*"]`; a `.test.ts` under `apps/web/src` is silently never run. e2e is the only route-level gate.) |
| `apps/web/playwright.config.ts` | mod | Add `VAPI_WEBHOOK_SECRET: "test-vapi-secret"` to `webServer.env` so the e2e can exercise the 401 path (dev allows all when the secret is unset). |
| `apps/web/middleware.ts` | mod | Add `/api/voice/vapi` to PUBLIC (Clerk must not 401 it). |
| `packages/agents/src/functions/voice-fallback.ts` | **new** | Inngest fn on `lead/contact-overdue`, `cancelOn lead/contacted`; guard → `voice.placeOutboundCall` → log attempt + `recordAgentRun`. |
| `packages/agents/src/index.ts` | mod | Register `voiceFallback`. |
| `packages/agents/src/functions/voice-fallback.test.ts` | **new** | Workflow test (Wave 3, CI). |
| `.env.example` | mod | The four `VAPI_*` vars + comments. |
| `docs/VOICE-AGENT-SETUP.md` | **new** | Ops doc: Vapi account/assistant/number/webhook wiring. |
| `apps/web/src/app/(app)/leads/[id]/page.tsx` | mod (**optional**) | Thin read-only `voice_outcome` badge. |

---

# WAVE 1 — Pure core (local-gated)

`buildAssistantOverrides` + `parseVoiceOutcome` + `shouldPlaceVoiceCall` (core) + the Vapi gateway fake (integrations). Verify with `cd packages/core && npx vitest run`, `cd packages/integrations && npx vitest run`, `pnpm typecheck && pnpm lint`.

---

### Task 1: Voice persona types + `buildAssistantOverrides`

**Files:**
- Create: `packages/core/src/voice-persona.ts`
- Create: `packages/core/src/voice-persona.test.ts`
- Modify: `packages/core/src/index.ts` (add barrel line)

**Interfaces:**
- Produces:
  - `type AssistantOverrides = { firstMessage: string; model: { provider: string; model: string; messages: { role: "system"; content: string }[]; tools: VoiceToolDef[] }; variableValues: Record<string, string> }`
  - `type VoiceToolDef = { type: "function"; function: { name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required: string[] } } }`
  - `type VoiceLeadContext = { tenantName: string; leadName: string; address: string; stormContext: string | null; leadId: string; tenantId: string }`
  - `function buildAssistantOverrides(ctx: VoiceLeadContext): AssistantOverrides`
- Consumes: nothing (pure).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/voice-persona.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildAssistantOverrides, type VoiceLeadContext } from "./voice-persona";

const baseCtx: VoiceLeadContext = {
  tenantName: "Acme Roofing",
  leadName: "Jane Homeowner",
  address: "123 Main St, Phoenix, AZ",
  stormContext: "1.5\" hail on 2026-05-01",
  leadId: "lead-1",
  tenantId: "tenant-1",
};

describe("buildAssistantOverrides", () => {
  it("identifies as the tenant's company in the first message and system prompt", () => {
    const o = buildAssistantOverrides(baseCtx);
    expect(o.firstMessage).toContain("Acme Roofing");
    const sys = o.model.messages.find((m) => m.role === "system")!.content;
    expect(sys).toContain("Acme Roofing");
    expect(sys).toContain("Jane Homeowner");
    expect(sys).toContain("123 Main St, Phoenix, AZ");
  });

  it("embeds every guardrail phrase verbatim", () => {
    const sys = buildAssistantOverrides(baseCtx).model.messages[0]!.content;
    expect(sys).toMatch(/do not (quote|discuss) (pricing|prices)/i);
    expect(sys).toMatch(/deductible/i);
    expect(sys).toMatch(/insurance fraud/i);
    expect(sys).toMatch(/TCPA/);
    expect(sys).toMatch(/quiet hours/i);
    expect(sys).toMatch(/do not call/i); // DNC
    expect(sys).toMatch(/hand (off|you )?.*(human|representative|rep)/i);
  });

  it("includes the storm context when present and omits it when null", () => {
    expect(buildAssistantOverrides(baseCtx).model.messages[0]!.content).toContain("1.5\" hail");
    const noStorm = buildAssistantOverrides({ ...baseCtx, stormContext: null });
    expect(noStorm.model.messages[0]!.content).not.toMatch(/hail|recent storm/i);
  });

  it("defines the getRecommendedSlots and bookSlot tools", () => {
    const tools = buildAssistantOverrides(baseCtx).model.tools;
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("getRecommendedSlots");
    expect(names).toContain("bookSlot");
    const book = tools.find((t) => t.function.name === "bookSlot")!;
    expect(book.function.parameters.required).toEqual(expect.arrayContaining(["startsAt", "endsAt"]));
  });

  it("passes leadId + tenantId through variableValues for the webhook to read", () => {
    const o = buildAssistantOverrides(baseCtx);
    expect(o.variableValues).toMatchObject({ leadId: "lead-1", tenantId: "tenant-1" });
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd packages/core && npx vitest run src/voice-persona.test.ts`
Expected: FAIL — "Cannot find module './voice-persona'".

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/voice-persona.ts` (types + builder; `parseVoiceOutcome` and `shouldPlaceVoiceCall` are added in Tasks 2–3):

```ts
// Pure persona/override builder for the shared Vapi assistant. No I/O.
// Lives in @savvy/core so packages/integrations can import the AssistantOverrides
// type (correct dependency direction: integrations -> core).

export type VoiceToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, unknown>; required: string[] };
  };
};

export type AssistantOverrides = {
  firstMessage: string;
  model: {
    provider: string;
    model: string;
    messages: { role: "system"; content: string }[];
    tools: VoiceToolDef[];
  };
  variableValues: Record<string, string>;
};

export type VoiceLeadContext = {
  tenantName: string;
  leadName: string;
  address: string;
  stormContext: string | null;
  leadId: string;
  tenantId: string;
};

const VOICE_TOOLS: VoiceToolDef[] = [
  {
    type: "function",
    function: {
      name: "getRecommendedSlots",
      description:
        "Get up to 3 available inspection appointment times for this lead. Takes no arguments; the lead is resolved from the call.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "bookSlot",
      description:
        "Book one of the offered inspection times. startsAt/endsAt are ISO-8601 timestamps copied exactly from a getRecommendedSlots result — never invent a time.",
      parameters: {
        type: "object",
        properties: {
          startsAt: { type: "string", description: "ISO-8601 start time from getRecommendedSlots" },
          endsAt: { type: "string", description: "ISO-8601 end time from getRecommendedSlots" },
        },
        required: ["startsAt", "endsAt"],
      },
    },
  },
];

export function buildAssistantOverrides(ctx: VoiceLeadContext): AssistantOverrides {
  const stormLine = ctx.stormContext
    ? `Recent storm context for this property: ${ctx.stormContext}. You may mention it as the reason for the free inspection.`
    : "";

  const systemPrompt = [
    `You are the scheduling assistant for ${ctx.tenantName}, a roofing company. You always identify yourself as calling from ${ctx.tenantName}.`,
    `You are speaking with ${ctx.leadName} about the property at ${ctx.address}.`,
    `Your goal: book a free roof inspection, or warmly hand the caller to a human representative if they prefer or the conversation gets complex.`,
    stormLine,
    `To offer times, call the getRecommendedSlots tool, read back the options, and when the caller picks one call bookSlot with that exact startsAt/endsAt. Never invent or estimate an appointment time.`,
    `Guardrails (follow exactly):`,
    `- Do not quote pricing or prices, and do not give cost estimates.`,
    `- Do not discuss the homeowner's insurance deductible, and never suggest anything resembling insurance fraud (e.g. covering a deductible).`,
    `- Comply with TCPA, quiet hours, and Do Not Call requests at all times. If the caller asks not to be called, acknowledge and stop.`,
    `- Hand off to a human representative on request, or for anything complex or insurance-heavy.`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    firstMessage: `Hi, this is the scheduling assistant for ${ctx.tenantName}. Is now a good time to set up your free roof inspection?`,
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "system", content: systemPrompt }],
      tools: VOICE_TOOLS,
    },
    variableValues: { leadId: ctx.leadId, tenantId: ctx.tenantId },
  };
}
```

- [ ] **Step 4: Add the barrel export**

In `packages/core/src/index.ts`, append (keep alphabetical-ish with siblings):

```ts
export * from "./voice-persona";
```

- [ ] **Step 5: Run the test — verify it passes**

Run: `cd packages/core && npx vitest run src/voice-persona.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/voice-persona.ts packages/core/src/voice-persona.test.ts packages/core/src/index.ts
git commit -m "feat(core): voice persona overrides builder for Vapi assistant"
```

---

### Task 2: `parseVoiceOutcome`

**Files:**
- Modify: `packages/core/src/voice-persona.ts`
- Modify: `packages/core/src/voice-persona.test.ts`

**Interfaces:**
- Produces:
  - `type VoiceOutcome = "booked" | "no_answer" | "callback" | "dnc" | "needs_human"`
  - `function parseVoiceOutcome(raw: string | null | undefined): VoiceOutcome | null`

- [ ] **Step 1: Write the failing test** — append to `voice-persona.test.ts`:

```ts
import { parseVoiceOutcome } from "./voice-persona";

describe("parseVoiceOutcome", () => {
  it("maps each known Vapi outcome string to the enum", () => {
    expect(parseVoiceOutcome("booked")).toBe("booked");
    expect(parseVoiceOutcome("no_answer")).toBe("no_answer");
    expect(parseVoiceOutcome("callback")).toBe("callback");
    expect(parseVoiceOutcome("dnc")).toBe("dnc");
    expect(parseVoiceOutcome("needs_human")).toBe("needs_human");
  });
  it("is case/whitespace tolerant", () => {
    expect(parseVoiceOutcome("  Booked ")).toBe("booked");
    expect(parseVoiceOutcome("NO_ANSWER")).toBe("no_answer");
  });
  it("returns null for unknown, empty, null, or undefined", () => {
    expect(parseVoiceOutcome("voicemail")).toBeNull();
    expect(parseVoiceOutcome("")).toBeNull();
    expect(parseVoiceOutcome(null)).toBeNull();
    expect(parseVoiceOutcome(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd packages/core && npx vitest run src/voice-persona.test.ts`
Expected: FAIL — `parseVoiceOutcome` is not exported.

- [ ] **Step 3: Implement** — append to `packages/core/src/voice-persona.ts`:

```ts
export type VoiceOutcome = "booked" | "no_answer" | "callback" | "dnc" | "needs_human";

const VOICE_OUTCOMES: readonly VoiceOutcome[] = ["booked", "no_answer", "callback", "dnc", "needs_human"];

export function parseVoiceOutcome(raw: string | null | undefined): VoiceOutcome | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  return (VOICE_OUTCOMES as readonly string[]).includes(v) ? (v as VoiceOutcome) : null;
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `cd packages/core && npx vitest run src/voice-persona.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/voice-persona.ts packages/core/src/voice-persona.test.ts
git commit -m "feat(core): parseVoiceOutcome maps Vapi outcome string to enum"
```

---

### Task 3: `shouldPlaceVoiceCall` outbound guard predicate

**Files:**
- Modify: `packages/core/src/voice-persona.ts`
- Modify: `packages/core/src/voice-persona.test.ts`

**Interfaces:**
- Consumes: `isWithinQuietHours` (from `./quiet-hours`), `shouldSendChannel` (from `./lead-followup`).
- Produces:
  - `type VoiceGuardInput = { status: string; firstRepContactAt: Date | null; phone: string | null; smsOptOut: boolean; emailOptOut: boolean; smsConsentAt: Date | null; now: Date; tz: string; quietHours: { startHour: number; endHour: number } }`
  - `function shouldPlaceVoiceCall(i: VoiceGuardInput): { ok: true } | { ok: false; reason: string }`

**Why these gates:** open (non-terminal) lead + not yet contacted by a rep + has a phone + SMS-grade consent/opt-out (proxy for call consent/DNC) + outside quiet hours (tenant tz). Mirrors the `OPEN` set and `shouldSendChannel`/quiet-hours usage in `lead-cadence.ts`.

- [ ] **Step 1: Write the failing test** — append to `voice-persona.test.ts`:

```ts
import { shouldPlaceVoiceCall } from "./voice-persona";

const guardBase = {
  status: "new",
  firstRepContactAt: null as Date | null,
  phone: "+16025551234",
  smsOptOut: false,
  emailOptOut: false,
  smsConsentAt: new Date("2026-06-01T00:00:00Z"),
  // 2026-06-24 19:00 UTC = 12:00 in America/Phoenix (UTC-7) — outside 21–8 quiet hours
  now: new Date("2026-06-24T19:00:00Z"),
  tz: "America/Phoenix",
  quietHours: { startHour: 21, endHour: 8 },
};

describe("shouldPlaceVoiceCall", () => {
  it("allows an open, uncontacted, consented lead during business hours", () => {
    expect(shouldPlaceVoiceCall(guardBase)).toEqual({ ok: true });
  });
  it("skips a closed/terminal lead", () => {
    expect(shouldPlaceVoiceCall({ ...guardBase, status: "lost" })).toEqual({ ok: false, reason: "closed" });
    expect(shouldPlaceVoiceCall({ ...guardBase, status: "won" })).toEqual({ ok: false, reason: "closed" });
  });
  it("skips an already-contacted lead", () => {
    expect(shouldPlaceVoiceCall({ ...guardBase, firstRepContactAt: new Date() })).toEqual({ ok: false, reason: "contacted" });
  });
  it("skips when there is no phone", () => {
    expect(shouldPlaceVoiceCall({ ...guardBase, phone: null })).toEqual({ ok: false, reason: "no-phone" });
  });
  it("skips when consent is missing or opted out", () => {
    expect(shouldPlaceVoiceCall({ ...guardBase, smsConsentAt: null })).toEqual({ ok: false, reason: "no-consent" });
    expect(shouldPlaceVoiceCall({ ...guardBase, smsOptOut: true })).toEqual({ ok: false, reason: "no-consent" });
  });
  it("skips inside quiet hours (2am Phoenix)", () => {
    // 2026-06-24 09:00 UTC = 02:00 America/Phoenix — inside 21–8 quiet window
    const quiet = { ...guardBase, now: new Date("2026-06-24T09:00:00Z") };
    expect(shouldPlaceVoiceCall(quiet)).toEqual({ ok: false, reason: "quiet-hours" });
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd packages/core && npx vitest run src/voice-persona.test.ts`
Expected: FAIL — `shouldPlaceVoiceCall` not exported.

- [ ] **Step 3: Implement** — append to `packages/core/src/voice-persona.ts`:

```ts
import { isWithinQuietHours } from "./quiet-hours";
import { shouldSendChannel } from "./lead-followup";

const VOICE_OPEN_STATUSES = ["new", "contacted", "qualified", "booked"];

export type VoiceGuardInput = {
  status: string;
  firstRepContactAt: Date | null;
  phone: string | null;
  smsOptOut: boolean;
  emailOptOut: boolean;
  smsConsentAt: Date | null;
  now: Date;
  tz: string;
  quietHours: { startHour: number; endHour: number };
};

export function shouldPlaceVoiceCall(i: VoiceGuardInput): { ok: true } | { ok: false; reason: string } {
  if (!VOICE_OPEN_STATUSES.includes(i.status)) return { ok: false, reason: "closed" };
  if (i.firstRepContactAt != null) return { ok: false, reason: "contacted" };
  if (!i.phone) return { ok: false, reason: "no-phone" };
  // SMS-grade consent stands in for call consent/DNC (we have no separate voice-consent column).
  if (!shouldSendChannel("sms", { smsOptOut: i.smsOptOut, emailOptOut: i.emailOptOut, smsConsentAt: i.smsConsentAt }))
    return { ok: false, reason: "no-consent" };
  if (isWithinQuietHours(i.now, i.tz, i.quietHours)) return { ok: false, reason: "quiet-hours" };
  return { ok: true };
}
```

> The two `import` lines go at the TOP of the file with the other module code (move them up if your editor placed them mid-file). Plain (non-`.js`) specifiers — these are intra-package and Turbopack-safe.

- [ ] **Step 4: Run the test — verify it passes**

Run: `cd packages/core && npx vitest run src/voice-persona.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Typecheck + lint, then commit**

```bash
pnpm typecheck && pnpm lint
git add packages/core/src/voice-persona.ts packages/core/src/voice-persona.test.ts
git commit -m "feat(core): shouldPlaceVoiceCall outbound guard (open+uncontacted+phone+consent+not-quiet)"
```

---

### Task 4: Vapi gateway (`placeOutboundCall`, env-or-fake, fail-open)

**Files:**
- Modify: `packages/integrations/package.json` (add `@savvy/core` dep)
- Create: `packages/integrations/src/vapi.ts`
- Create: `packages/integrations/src/vapi.test.ts`
- Modify: `packages/integrations/src/index.ts` (barrel)

**Interfaces:**
- Consumes: `type AssistantOverrides` from `@savvy/core` (Task 1).
- Produces:
  - `interface VoiceGateway { placeOutboundCall(o: { toPhone: string; assistantOverrides: AssistantOverrides; metadata: Record<string, string> }): Promise<{ callId: string } | null> }`
  - `const httpVapi: VoiceGateway`
  - `function makeFakeVoice(): VoiceGateway & { calls: { toPhone: string; metadata: Record<string, string> }[] }`
  - `const voice: VoiceGateway` (singleton; `httpVapi` when `VAPI_API_KEY` set, else `makeFakeVoice()`).

- [ ] **Step 1: Add the workspace dependency**

Edit `packages/integrations/package.json` — add to `"dependencies"` (keep JSON valid, alphabetical):

```json
"@savvy/core": "workspace:*",
```

Then relink (a workspace dep add requires it, or `@savvy/core` won't resolve from integrations):

```bash
pnpm install
```

Expected: lockfile updates, `node_modules/@savvy/integrations` gains the `@savvy/core` link. (Known gotcha: skip this and typecheck fails "Cannot find module '@savvy/core'".)

- [ ] **Step 2: Write the failing test**

Create `packages/integrations/src/vapi.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeFakeVoice } from "./vapi";
import type { AssistantOverrides } from "@savvy/core";

const overrides: AssistantOverrides = {
  firstMessage: "hi",
  model: { provider: "openai", model: "gpt-4o", messages: [{ role: "system", content: "x" }], tools: [] },
  variableValues: { leadId: "lead-1", tenantId: "tenant-1" },
};

describe("makeFakeVoice", () => {
  it("returns a deterministic fake callId and records the call", async () => {
    const fake = makeFakeVoice();
    const res = await fake.placeOutboundCall({ toPhone: "+16025551234", assistantOverrides: overrides, metadata: { leadId: "lead-1" } });
    expect(res).not.toBeNull();
    expect(res!.callId).toMatch(/^fake-/);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ toPhone: "+16025551234", metadata: { leadId: "lead-1" } });
  });
});
```

- [ ] **Step 3: Run it — verify it fails**

Run: `cd packages/integrations && npx vitest run src/vapi.test.ts`
Expected: FAIL — "Cannot find module './vapi'".

- [ ] **Step 4: Implement** — create `packages/integrations/src/vapi.ts`:

```ts
import type { AssistantOverrides } from "@savvy/core";

export interface VoiceGateway {
  /** Places an outbound call. Returns the provider call id, or null on no-key/error (fail-open). */
  placeOutboundCall(o: {
    toPhone: string;
    assistantOverrides: AssistantOverrides;
    metadata: Record<string, string>;
  }): Promise<{ callId: string } | null>;
}

const VAPI_BASE = "https://api.vapi.ai";

export const httpVapi: VoiceGateway = {
  async placeOutboundCall({ toPhone, assistantOverrides, metadata }) {
    const key = process.env.VAPI_API_KEY;
    const assistantId = process.env.VAPI_ASSISTANT_ID;
    const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
    if (!key || !assistantId || !phoneNumberId) return null; // fail-open: not fully configured
    try {
      const res = await fetch(`${VAPI_BASE}/call`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          assistantId,
          phoneNumberId,
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

export function makeFakeVoice(): VoiceGateway & { calls: { toPhone: string; metadata: Record<string, string> }[] } {
  const calls: { toPhone: string; metadata: Record<string, string> }[] = [];
  let n = 0;
  return {
    calls,
    async placeOutboundCall({ toPhone, metadata }) {
      n += 1;
      calls.push({ toPhone, metadata });
      return { callId: `fake-call-${n}` };
    },
  };
}

export const voice: VoiceGateway = process.env.VAPI_API_KEY ? httpVapi : makeFakeVoice();
```

- [ ] **Step 5: Barrel export** — append to `packages/integrations/src/index.ts`:

```ts
export { voice, httpVapi, makeFakeVoice, type VoiceGateway } from "./vapi";
```

- [ ] **Step 6: Run the test — verify it passes**

Run: `cd packages/integrations && npx vitest run src/vapi.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean (confirms the `@savvy/core` cross-package type import resolves).

- [ ] **Step 8: Commit**

```bash
git add packages/integrations/package.json pnpm-lock.yaml packages/integrations/src/vapi.ts packages/integrations/src/vapi.test.ts packages/integrations/src/index.ts
git commit -m "feat(integrations): Vapi voice gateway (placeOutboundCall, env-or-fake, fail-open)"
```

### Wave 1 review checkpoint

Run a per-wave review (subagent-driven-development's reviewer). Then proceed.

---

# WAVE 2 — Migration + booking + webhook (CI-gated)

`lead.voice_outcome` migration, `bookLeadSlot` factored from `confirmSlot`, the `recordVoiceCallReport` db helper, and the shared webhook. DB/route tests run in **CI** (local Postgres `ECONNREFUSED` expected). Still run `pnpm typecheck && pnpm lint` locally + the `voice-webhook.test.ts` parser units (no DB).

---

### Task 5: Migration — `lead.voice_outcome`

**Files:**
- Modify: `packages/db/src/schema/crm.ts` (add column to `lead`)
- Create (generated): `packages/db/drizzle/0020_*.sql` + `packages/db/drizzle/meta/0020_snapshot.json` + `_journal.json` entry

**Interfaces:**
- Produces: `lead.voiceOutcome` (Drizzle col, `text`, nullable) → consumed by Tasks 6–8 + the optional UI.

- [ ] **Step 1: Add the column to the schema**

In `packages/db/src/schema/crm.ts`, inside the `lead = pgTable("lead", { … })` object, add after `firstRepContactAt`:

```ts
  voiceOutcome: text("voice_outcome"),
```

(`text` is already imported in this file — it's used by `source`/`scoreReason`.)

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: writes `packages/db/drizzle/0020_<name>.sql` containing `ALTER TABLE "lead" ADD COLUMN "voice_outcome" text;`, a new `meta/0020_snapshot.json`, and an idx-20 entry appended to `meta/_journal.json`.

- [ ] **Step 3: Verify the generated SQL + meta**

Run: `cat packages/db/drizzle/0020_*.sql && git status --short packages/db/drizzle`
Expected: the `.sql` shows the single `ADD COLUMN "voice_outcome" text;`. `git status` shows the new `.sql`, new `0020_snapshot.json`, and modified `_journal.json` — **all three must be staged together** (migration-hygiene gotcha).

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit (sql + meta together)**

```bash
git add packages/db/src/schema/crm.ts packages/db/drizzle/0020_*.sql packages/db/drizzle/meta/0020_snapshot.json packages/db/drizzle/meta/_journal.json
git commit -m "feat(db): add lead.voice_outcome column (migration 0020)"
```

---

### Task 6: `bookLeadSlot` — engine booking in `@savvy/db` (CI-tested), `confirmSlot` delegates

**Why db, not apps/web:** the booking logic must be CI-tested, but `apps/web` has **no vitest project** (`vitest.workspace.ts = ["packages/*"]`) — a test there never runs. So the engine logic lives in `packages/db` (integration-tested in CI); the inngest emit stays in the apps/web callers (db must not depend on `@savvy/agents`).

**Files:**
- Create: `packages/db/src/lifecycle/booking.ts`
- Create: `packages/db/src/lifecycle/booking.test.ts` (integration — CI)
- Modify: `packages/db/src/index.ts` (export `bookLeadSlot`)
- Modify: `apps/web/src/lib/booking-action.ts` (`confirmSlot` lead path delegates + emits)

**Interfaces:**
- Consumes (in booking.ts): `convertLeadToJob`, `bookAppointment`, `SlotTakenError`, `NoAssigneeError`, `adminDb`, `lead`, `user` (`../schema/index`), `eq`, `and`, `or` (`drizzle-orm`).
- Produces:
  - `async function bookLeadSlot(input: { leadId: string; startsAt: string; endsAt: string; tenantId?: string }): Promise<{ appointmentId: string; jobId: string; tenantId: string } | { error: "no_lead" | "no_assignee" | "slot_taken" }>` — NO inngest emit. Used by the webhook (Task 8) and `confirmSlot`.

- [ ] **Step 1: Write the failing integration test**

Create `packages/db/src/lifecycle/booking.test.ts` (seed-then-assert style of sibling `@savvy/db` integration tests; runs in CI):

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { bookLeadSlot } from "./booking";
import { adminDb, withTenant, tenant, user, customer, property, lead, appointment, eq } from "../index";

let tenantId: string;
let leadId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "Book Test Co", publicKey: `book-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [u] = await adminDb.insert(user).values({ tenantId, role: "rep", name: "Rep", email: `rep-${Date.now()}@x.com` }).returning();
  await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Homeowner", phone: "+16025550000" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "1 Main" }).returning();
    const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, status: "new", assignedUserId: u!.id }).returning();
    leadId = l!.id;
  });
});

describe("bookLeadSlot", () => {
  it("converts the lead to a job and books the appointment", async () => {
    const startsAt = new Date(Date.now() + 86_400_000).toISOString();
    const endsAt = new Date(Date.now() + 86_400_000 + 3_600_000).toISOString();
    const res = await bookLeadSlot({ leadId, startsAt, endsAt });
    expect("appointmentId" in res).toBe(true);
    const appts = await adminDb.select().from(appointment).where(eq(appointment.tenantId, tenantId));
    expect(appts).toHaveLength(1);
  });

  it("returns no_lead for an unknown lead id", async () => {
    expect(await bookLeadSlot({ leadId: "00000000-0000-0000-0000-000000000000", startsAt: new Date().toISOString(), endsAt: new Date().toISOString() }))
      .toEqual({ error: "no_lead" });
  });
});
```

- [ ] **Step 2: Run it — verify it fails** (CI is the gate; locally expect `ECONNREFUSED 5432` or "not a function" — both acceptable "red").

Run: `cd packages/db && npx vitest run src/lifecycle/booking.test.ts`

- [ ] **Step 3: Implement** — create `packages/db/src/lifecycle/booking.ts`:

```ts
import { adminDb } from "../admin-client";
import { lead, user } from "../schema/index";
import { eq, and, or } from "drizzle-orm";
import { convertLeadToJob } from "./jobs";
import { bookAppointment, SlotTakenError, NoAssigneeError } from "./appointments";

/**
 * Token-less engine booking for the voice agent. Resolves the lead's tenant + assignee,
 * converts the lead to a job, and books an inspection appointment. Does NOT emit
 * appointment/booked — the caller (apps/web) owns that (db must not import @savvy/agents).
 */
export async function bookLeadSlot(input: {
  leadId: string;
  startsAt: string;
  endsAt: string;
  tenantId?: string;
}): Promise<{ appointmentId: string; jobId: string; tenantId: string } | { error: "no_lead" | "no_assignee" | "slot_taken" }> {
  const [l] = await adminDb
    .select({ tenantId: lead.tenantId, assignedUserId: lead.assignedUserId })
    .from(lead)
    .where(eq(lead.id, input.leadId));
  if (!l) return { error: "no_lead" };
  const tenantId = l.tenantId;

  let assigneeId = l.assignedUserId ?? undefined;
  if (!assigneeId) {
    const [u] = await adminDb
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.tenantId, tenantId), or(eq(user.role, "owner"), eq(user.role, "rep"))));
    assigneeId = u?.id;
  }
  if (!assigneeId) return { error: "no_assignee" };

  try {
    const conv = await convertLeadToJob({ tenantId, leadId: input.leadId });
    const appt = await bookAppointment({
      tenantId,
      jobId: conv.jobId,
      customerId: conv.customerId,
      type: "inspection",
      assigneeUserId: assigneeId,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
    });
    return { appointmentId: appt.id, jobId: conv.jobId, tenantId };
  } catch (e) {
    if (e instanceof SlotTakenError) return { error: "slot_taken" };
    if (e instanceof NoAssigneeError) return { error: "no_assignee" };
    throw e;
  }
}
```

> Verify the exact import paths at implementation time by reading a sibling lifecycle file (e.g. `lifecycle/agent-run.ts` for `adminDb`/schema imports; the file that defines `convertLeadToJob`, `bookAppointment`, `SlotTakenError`, `NoAssigneeError` — they're re-exported from `@savvy/db`'s barrel, so worst case import them from `../index`). Match siblings; NO `.js` extensions.

- [ ] **Step 4: Export from the db barrel** — add to `packages/db/src/index.ts`:

```ts
export { bookLeadSlot } from "./lifecycle/booking";
```

- [ ] **Step 5: DRY — delegate `confirmSlot`'s lead-only path** — in `apps/web/src/lib/booking-action.ts`:
  - add `bookLeadSlot` to the `@savvy/db` import list.
  - in `confirmSlot`, at the TOP of the booking branch (right after the `appointmentId` early-return block, before `const assignee = await resolveAssignee(p);`), insert:

```ts
    // Lead-only token (no jobId/appointmentId): reuse the shared engine booking.
    if (p.leadId && !p.jobId) {
      const r = await bookLeadSlot({ leadId: p.leadId, startsAt, endsAt });
      if ("appointmentId" in r) {
        try {
          await inngest.send({ name: "appointment/booked", data: { appointmentId: r.appointmentId, tenantId: r.tenantId } });
        } catch (e) { console.error(e); }
        return { ok: true as const };
      }
      if (r.error === "slot_taken") return { error: "slot_taken" as const };
      return { error: "no_assignee" as const }; // no_assignee or no_lead -> no_assignee for the token caller
    }
```

Leave the existing jobId path below unchanged (now only runs for jobId tokens).

- [ ] **Step 6: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/lifecycle/booking.ts packages/db/src/lifecycle/booking.test.ts packages/db/src/index.ts apps/web/src/lib/booking-action.ts
git commit -m "feat(db): bookLeadSlot engine booking; confirmSlot lead path delegates + emits"
```

---

### Task 7: `recordVoiceCallReport` db helper

**Files:**
- Create: `packages/db/src/lifecycle/voice.ts`
- Modify: `packages/db/src/index.ts` (export it)
- Create: `packages/db/src/lifecycle/voice.test.ts` (integration — CI)

**Interfaces:**
- Consumes: `withTenant`, `communication`, `lead`, `eq` (`@savvy/db` internals).
- Produces:
  - `async function recordVoiceCallReport(input: { tenantId: string; leadId: string; direction: "inbound" | "outbound"; transcript: string | null; recordingUrl: string | null; durationSeconds: number | null; providerCallId: string | null; outcome: VoiceOutcome | null }): Promise<void>`

- [ ] **Step 1: Write the failing integration test**

Create `packages/db/src/lifecycle/voice.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { recordVoiceCallReport } from "./voice";
import { adminDb, withTenant, tenant, customer, property, lead, communication, eq } from "../index";

let tenantId: string;
let leadId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "Voice Co", publicKey: `voice-${Date.now()}` }).returning();
  tenantId = t!.id;
  await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Caller", phone: "+16025551111" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "2 Main" }).returning();
    const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, status: "new" }).returning();
    leadId = l!.id;
  });
});

describe("recordVoiceCallReport", () => {
  it("logs a call communication and sets lead.voice_outcome", async () => {
    await recordVoiceCallReport({
      tenantId, leadId, direction: "inbound",
      transcript: "AI: hello\nCaller: book me", recordingUrl: "https://rec/1",
      durationSeconds: 42, providerCallId: "vapi-1", outcome: "booked",
    });

    const [comm] = await adminDb.select().from(communication).where(eq(communication.tenantId, tenantId));
    expect(comm).toMatchObject({ channel: "call", direction: "inbound", transcript: "AI: hello\nCaller: book me", recordingUrl: "https://rec/1", durationSeconds: 42, twilioSid: "vapi-1", aiHandled: true });

    const [l] = await adminDb.select({ vo: lead.voiceOutcome }).from(lead).where(eq(lead.id, leadId));
    expect(l!.vo).toBe("booked");
  });

  it("tolerates a null outcome (logs the call, leaves voice_outcome null)", async () => {
    await recordVoiceCallReport({
      tenantId, leadId, direction: "outbound",
      transcript: null, recordingUrl: null, durationSeconds: null, providerCallId: "vapi-2", outcome: null,
    });
    const comms = await adminDb.select().from(communication).where(eq(communication.tenantId, tenantId));
    expect(comms.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd packages/db && npx vitest run src/lifecycle/voice.test.ts` (CI is the real gate; locally expect `ECONNREFUSED` or "not a function").

- [ ] **Step 3: Implement** — create `packages/db/src/lifecycle/voice.ts`:

```ts
import { withTenant } from "../tenant";
import { communication, lead } from "../schema/index";
import { eq } from "drizzle-orm";
import type { VoiceOutcome } from "@savvy/core";

/**
 * One tenant-scoped tx: log the call transcript as a communication (channel 'call')
 * and stamp lead.voice_outcome. The customerId is resolved from the lead inside the tx.
 */
export async function recordVoiceCallReport(input: {
  tenantId: string;
  leadId: string;
  direction: "inbound" | "outbound";
  transcript: string | null;
  recordingUrl: string | null;
  durationSeconds: number | null;
  providerCallId: string | null;
  outcome: VoiceOutcome | null;
}): Promise<void> {
  await withTenant(input.tenantId, async (tx) => {
    const [l] = await tx.select({ customerId: lead.customerId }).from(lead).where(eq(lead.id, input.leadId));
    await tx.insert(communication).values({
      tenantId: input.tenantId,
      customerId: l?.customerId ?? null,
      channel: "call",
      direction: input.direction,
      transcript: input.transcript,
      recordingUrl: input.recordingUrl,
      durationSeconds: input.durationSeconds,
      twilioSid: input.providerCallId,
      aiHandled: true,
    });
    if (input.outcome) {
      await tx.update(lead).set({ voiceOutcome: input.outcome }).where(eq(lead.id, input.leadId));
    }
  });
}
```

> Match the existing lifecycle import style. Confirm `withTenant` lives at `../tenant` and the schema barrel at `../schema/index` (this mirrors `lifecycle/agent-run.ts`). `eq` imports from `drizzle-orm` as in sibling lifecycle files. No `.js` extensions.

- [ ] **Step 4: Export from the db barrel** — add to `packages/db/src/index.ts` (near the other `lifecycle/*` re-exports):

```ts
export { recordVoiceCallReport } from "./lifecycle/voice";
```

- [ ] **Step 5: Typecheck + lint, commit**

```bash
pnpm typecheck && pnpm lint
git add packages/db/src/lifecycle/voice.ts packages/db/src/lifecycle/voice.test.ts packages/db/src/index.ts
git commit -m "feat(db): recordVoiceCallReport logs call transcript + sets lead.voice_outcome"
```

---

### Task 8: Shared webhook `/api/voice/vapi`

**Files:**
- Create: `packages/core/src/voice-webhook.ts` (pure parsing helpers — vitest-run in **core**, NOT apps/web)
- Create: `packages/core/src/voice-webhook.test.ts`
- Modify: `packages/core/src/index.ts` (barrel)
- Create: `apps/web/src/app/api/voice/vapi/route.ts`
- Modify: `apps/web/middleware.ts` (PUBLIC)
- Create: `apps/web/tests/e2e/voice-webhook.spec.ts` (Playwright — the only route-level gate)

**Interfaces:**
- Consumes (route): `requireSecret`, `parseVoiceOutcome`, `signPayloadToken`, `parseVapiMessage`, `toolResult` (`@savvy/core`); `getRecommendedSlots` (`@/lib/recommended-slots`); `bookLeadSlot`, `recordVoiceCallReport` (`@savvy/db`); `tenantByPhone`, `createLeadForTenant` (`@/lib/intake`); `inngest` (`@savvy/agents`); `sms`, `smsFrom` (`@savvy/integrations`).
- Produces: `parseVapiMessage`/`toolResult` (core) + the route.

**Vapi envelope is best-effort** (like CompanyCam/QBO): we parse defensively. The parser is unit-tested in core; the route's auth is e2e-tested; the booking/logging DB paths are covered by Tasks 6–7's CI integration tests. The exact JSON is validated when Brett wires the live assistant.

- [ ] **Step 1: Write the failing parser unit test**

Create `packages/core/src/voice-webhook.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseVapiMessage, toolResult } from "./voice-webhook";

describe("parseVapiMessage", () => {
  it("extracts type + metadata (leadId/tenantId) from a tool-calls message", () => {
    const msg = parseVapiMessage({
      message: {
        type: "tool-calls",
        toolCalls: [{ id: "tc1", function: { name: "getRecommendedSlots", arguments: {} } }],
        call: { metadata: { leadId: "lead-1", tenantId: "tenant-1", direction: "outbound" } },
      },
    });
    expect(msg.type).toBe("tool-calls");
    expect(msg.metadata).toMatchObject({ leadId: "lead-1", tenantId: "tenant-1" });
    expect(msg.toolCalls[0]).toMatchObject({ id: "tc1", name: "getRecommendedSlots" });
  });

  it("parses an end-of-call-report with transcript + structured outcome + to-number", () => {
    const msg = parseVapiMessage({
      message: {
        type: "end-of-call-report",
        call: { metadata: { leadId: "lead-1" } },
        artifact: { transcript: "hello", recordingUrl: "https://r/1" },
        durationSeconds: 30,
        analysis: { structuredData: { outcome: "booked" } },
        phoneNumber: { number: "+16025559999" },
      },
    });
    expect(msg.type).toBe("end-of-call-report");
    expect(msg.transcript).toBe("hello");
    expect(msg.recordingUrl).toBe("https://r/1");
    expect(msg.durationSeconds).toBe(30);
    expect(msg.outcomeRaw).toBe("booked");
    expect(msg.toNumber).toBe("+16025559999");
  });

  it("toolResult wraps a result in Vapi's results shape", () => {
    expect(toolResult("tc1", { slots: [] })).toEqual({ results: [{ toolCallId: "tc1", result: { slots: [] } }] });
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd packages/core && npx vitest run src/voice-webhook.test.ts`
Expected: FAIL — "Cannot find module './voice-webhook'".

- [ ] **Step 3: Implement the parser** — create `packages/core/src/voice-webhook.ts`:

```ts
type ParsedTool = { id: string; name: string; args: Record<string, unknown> };
export type ParsedVapiMessage = {
  type: string;
  metadata: Record<string, string>;
  toolCalls: ParsedTool[];
  transcript: string | null;
  recordingUrl: string | null;
  durationSeconds: number | null;
  outcomeRaw: string | null;
  toNumber: string | null;
  fromNumber: string | null;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function parseVapiMessage(body: unknown): ParsedVapiMessage {
  const message = asRecord(asRecord(body).message);
  const call = asRecord(message.call);
  const metaRaw = asRecord(call.metadata);
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(metaRaw)) if (typeof v === "string") metadata[k] = v;

  const rawCalls = Array.isArray(message.toolCalls)
    ? message.toolCalls
    : Array.isArray(message.toolCallList)
      ? message.toolCallList
      : [];
  const toolCalls: ParsedTool[] = rawCalls.map((c) => {
    const cc = asRecord(c);
    const fn = asRecord(cc.function);
    let args: Record<string, unknown> = {};
    if (typeof fn.arguments === "string") {
      try { args = asRecord(JSON.parse(fn.arguments)); } catch { args = {}; }
    } else {
      args = asRecord(fn.arguments);
    }
    return { id: String(cc.id ?? ""), name: String(fn.name ?? ""), args };
  });

  const artifact = asRecord(message.artifact);
  const analysis = asRecord(message.analysis);
  const structured = asRecord(analysis.structuredData);
  const phone = asRecord(message.phoneNumber);
  const customer = asRecord(message.customer);
  const durationRaw = message.durationSeconds ?? artifact.durationSeconds;

  return {
    type: String(message.type ?? ""),
    metadata,
    toolCalls,
    transcript: typeof artifact.transcript === "string" ? artifact.transcript : null,
    recordingUrl: typeof artifact.recordingUrl === "string" ? artifact.recordingUrl : null,
    durationSeconds: typeof durationRaw === "number" ? durationRaw : null,
    outcomeRaw: typeof structured.outcome === "string" ? structured.outcome : null,
    toNumber: typeof phone.number === "string" ? phone.number : null, // the dialed (tenant) number
    fromNumber: typeof customer.number === "string" ? customer.number : null, // the caller's number
  };
}

export function toolResult(toolCallId: string, result: unknown): { results: { toolCallId: string; result: unknown }[] } {
  return { results: [{ toolCallId, result }] };
}
```

- [ ] **Step 4: Barrel + run the parser test — verify it passes**

Append to `packages/core/src/index.ts`:

```ts
export * from "./voice-webhook";
```

Run: `cd packages/core && npx vitest run src/voice-webhook.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the route**

Create `apps/web/src/app/api/voice/vapi/route.ts`:

```ts
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { requireSecret, parseVoiceOutcome, signPayloadToken, parseVapiMessage, toolResult } from "@savvy/core";
import { recordVoiceCallReport, bookLeadSlot } from "@savvy/db";
import { inngest } from "@savvy/agents";
import { sms, smsFrom, type SmsSender } from "@savvy/integrations";
import { getRecommendedSlots } from "@/lib/recommended-slots";
import { tenantByPhone, createLeadForTenant } from "@/lib/intake";

export const runtime = "nodejs"; // node:crypto + DB

// Repo webhook posture (mirrors /api/ringcentral/inbound + lib/svix.ts): no secret
// configured => allow in dev/test, FAIL CLOSED in production. A clean 401, never a 500.
// (Do NOT use requireSecret here — it THROWS in prod when unset, which would 500 every
// webhook call and contradict "inert but deployable".)
function secretOk(provided: string | null): boolean {
  const expected = process.env.VAPI_WEBHOOK_SECRET;
  if (!expected) return process.env.NODE_ENV !== "production";
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!secretOk(req.headers.get("x-vapi-secret"))) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  let body: unknown;
  try { body = await req.json(); } catch { return new NextResponse("bad payload", { status: 400 }); }
  const msg = parseVapiMessage(body);

  // --- Mid-call tool dispatch -------------------------------------------------
  if (msg.type === "tool-calls" || msg.type === "function-call") {
    const leadId = msg.metadata.leadId;
    const tc = msg.toolCalls[0];
    if (!tc) return NextResponse.json(toolResult("", { error: "no tool call" }));
    if (!leadId) return NextResponse.json(toolResult(tc.id, { error: "no lead context" }));

    if (tc.name === "getRecommendedSlots") {
      const r = await getRecommendedSlots(leadId);
      if ("error" in r) return NextResponse.json(toolResult(tc.id, { slots: [], message: "No times available right now." }));
      return NextResponse.json(toolResult(tc.id, { slots: r.slots }));
    }
    if (tc.name === "bookSlot") {
      const startsAt = String(tc.args.startsAt ?? "");
      const endsAt = String(tc.args.endsAt ?? "");
      const r = await bookLeadSlot({ leadId, startsAt, endsAt });
      if ("appointmentId" in r) {
        try {
          await inngest.send({ name: "appointment/booked", data: { appointmentId: r.appointmentId, tenantId: r.tenantId } });
        } catch (e) { console.error(e); }
        return NextResponse.json(toolResult(tc.id, { booked: true }));
      }
      const message = r.error === "slot_taken" ? "That time was just taken — offer another." : "Could not book — offer to have a rep follow up.";
      return NextResponse.json(toolResult(tc.id, { booked: false, message }));
    }
    return NextResponse.json(toolResult(tc.id, { error: "unknown tool" }));
  }

  // --- End-of-call report -----------------------------------------------------
  if (msg.type === "end-of-call-report") {
    const outcome = parseVoiceOutcome(msg.outcomeRaw);
    let leadId = msg.metadata.leadId;
    let tenantId = msg.metadata.tenantId;
    const direction: "inbound" | "outbound" = leadId ? "outbound" : "inbound";

    // Inbound: no lead context — resolve tenant by the dialed number, create a lead-from-call.
    if (!leadId && msg.toNumber) {
      const t = await tenantByPhone(msg.toNumber);
      if (t) {
        tenantId = t.id;
        try {
          // Satisfy leadIntakeSchema's phone-or-email refine with the caller's number.
          if (msg.fromNumber) {
            leadId = await createLeadForTenant(t.id, {
              name: "Inbound caller",
              phone: msg.fromNumber,
              address: "",
              source: "inbound-call",
            } as Parameters<typeof createLeadForTenant>[1]);
          }
        } catch (e) { console.error("inbound lead-from-call failed", e); }
      }
    }

    if (leadId && tenantId) {
      try {
        await recordVoiceCallReport({
          tenantId, leadId, direction,
          transcript: msg.transcript, recordingUrl: msg.recordingUrl,
          durationSeconds: msg.durationSeconds, providerCallId: msg.metadata.callId ?? null,
          outcome,
        });
      } catch (e) { console.error("recordVoiceCallReport failed", e); }

      // No-answer fallback: text the self-schedule link (best-effort).
      if (outcome === "no_answer") {
        try {
          const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
          const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
          const bookingUrl = `${base}/book/${signPayloadToken({ leadId, tenantId, type: "inspection" }, secret)}`;
          const to = msg.metadata.toPhone ?? msg.fromNumber; // outbound stamps toPhone in metadata; inbound uses caller's number
          if (to) await (sms as SmsSender).sendSms({ to, from: smsFrom(), body: `Sorry we missed you! Book your free roof inspection here: ${bookingUrl}` });
        } catch (e) { console.error("no-answer SMS failed", e); }
      }
    }
    return NextResponse.json({ ok: true });
  }

  // Status updates etc. — acknowledge, no-op.
  return NextResponse.json({ ok: true });
}
```

> At implementation time, read `LeadIntakeInput`/`leadIntakeObject` in `@savvy/core/schemas.ts` and satisfy its REAL required fields exactly (it's `.refine(hasContactMethod)` — phone-or-email). We pass `phone: msg.fromNumber`; if `address` must be non-empty, pass a placeholder the UI tolerates (check the schema). Replace the `as Parameters<…>[1]` cast with the real typed object — no `any`, no unsafe cast if avoidable.

- [ ] **Step 6: Add the route to PUBLIC middleware**

In `apps/web/middleware.ts`, add `/api/voice/vapi` to the PUBLIC matcher array (mirror how `/api/companycam/webhook` and `/api/ringcentral/inbound` are listed — a webhook must not hit Clerk auth). Match the exact regex/string style already used.

- [ ] **Step 7: Set the webhook secret in the Playwright webServer env**

The e2e runs under `next dev` (NODE_ENV≠production), where `secretOk` allows everything when `VAPI_WEBHOOK_SECRET` is UNSET — so the 401-on-bad-secret case can only be exercised if the secret IS set for the test server. In `apps/web/playwright.config.ts`, add to the existing `webServer.env` block (alongside `TEST_MODE: "1"`):

```ts
      VAPI_WEBHOOK_SECRET: "test-vapi-secret",
```

- [ ] **Step 8: Write the Playwright e2e for the route (the only apps/web gate)**

`apps/web` has no vitest project, so the route is gated by Playwright. Create `apps/web/tests/e2e/voice-webhook.spec.ts` (match the style of a sibling spec, e.g. `tests/e2e/leads.spec.ts`, for the `request` fixture + base URL):

```ts
import { test, expect } from "@playwright/test";

// The webhook is in middleware PUBLIC, so Clerk does not intercept it.
// VAPI_WEBHOOK_SECRET is set to "test-vapi-secret" in playwright.config.ts webServer.env.
test.describe("POST /api/voice/vapi", () => {
  test("401s a wrong secret", async ({ request }) => {
    const res = await request.post("/api/voice/vapi", {
      headers: { "x-vapi-secret": "wrong-secret" },
      data: { message: { type: "end-of-call-report" } },
    });
    expect(res.status()).toBe(401);
  });

  test("401s a missing secret header", async ({ request }) => {
    const res = await request.post("/api/voice/vapi", {
      data: { message: { type: "end-of-call-report" } },
    });
    expect(res.status()).toBe(401);
  });

  test("acks an unknown message type with the correct secret", async ({ request }) => {
    const res = await request.post("/api/voice/vapi", {
      headers: { "x-vapi-secret": "test-vapi-secret" },
      data: { message: { type: "status-update" } },
    });
    expect(res.status()).toBe(200);
  });
});
```

> The valid secret string MUST match the value set in `playwright.config.ts` (Step 7). The deeper booking/logging/inbound paths are covered by Tasks 6–7's CI integration tests (`bookLeadSlot`, `recordVoiceCallReport`) — don't duplicate DB assertions here.

- [ ] **Step 9: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/voice-webhook.ts packages/core/src/voice-webhook.test.ts packages/core/src/index.ts \
  apps/web/src/app/api/voice/vapi/route.ts apps/web/tests/e2e/voice-webhook.spec.ts apps/web/middleware.ts apps/web/playwright.config.ts
git commit -m "feat(web): shared Vapi webhook (tool-calls dispatch + end-of-call report + inbound lead-from-call)"
```

### Wave 2 review checkpoint

Per-wave review. Confirm tenant isolation (all writes via `withTenant`), the 401 path, and migration meta committed.

---

# WAVE 3 — Outbound workflow + register + env + doc (CI-gated)

The Inngest fallback workflow, registration, `.env.example`, the setup doc, and the optional UI badge.

---

### Task 9: `voiceFallback` Inngest workflow + register

**Files:**
- Create: `packages/agents/src/functions/voice-fallback.ts`
- Modify: `packages/agents/src/index.ts` (import + export + add to `functions[]`)
- Create: `packages/agents/src/functions/voice-fallback.test.ts` (CI)

**Interfaces:**
- Consumes: `adminDb`, `withTenant`, `lead`, `customer`, `property`, `tenant`, `eq`, `recordAgentRun` (`@savvy/db`); `buildAssistantOverrides`, `shouldPlaceVoiceCall`, `parseFinanceConfig`, `parseLeadCadenceConfig` (`@savvy/core`); `voice` (`@savvy/integrations`); `inngest` (`../client`).
- Produces: `export const voiceFallback`.

**Concurrency:** `limit: 5` (Inngest free-plan cap — exceeding it rejects the whole app sync; see memory). `cancelOn: lead/contacted`.

- [ ] **Step 1: Write the failing workflow test**

Create `packages/agents/src/functions/voice-fallback.test.ts`. Use the same harness style as `lead-speed-to-lead.test.ts`/`lead-cadence.test.ts` in this folder (read one first to match the exact step-runner mock + import shape). The test must assert:

```ts
// Pseudocode of the three required assertions — match the sibling tests' harness exactly:
// 1. A daytime, open, uncontacted, consented lead with a phone => voice.placeOutboundCall called once (fake gateway records 1 call) + recordAgentRun status 'ok'.
// 2. A lead inside quiet hours (tenant tz) => no call placed; recordAgentRun status 'skipped' reason 'quiet-hours'.
// 3. A lead with no phone / opted-out => no call; 'skipped'.
```

Write it concretely against the harness you find in `lead-cadence.test.ts` (it already seeds tenant/customer/lead and drives `step`). Inject the fake voice gateway by importing `makeFakeVoice` and (if the sibling tests mock modules) `vi.mock("@savvy/integrations", …)` to return a controllable `voice`; otherwise set env so the singleton is the fake (no `VAPI_API_KEY`) and assert via `recordAgentRun` rows. Prefer the module-mock approach for a deterministic call-count assertion.

- [ ] **Step 2: Run it — verify it fails** (CI is the gate; locally expect ECONNREFUSED / missing export).

- [ ] **Step 3: Implement** — create `packages/agents/src/functions/voice-fallback.ts`:

```ts
import { adminDb, withTenant, lead, customer, property, tenant, eq, recordAgentRun } from "@savvy/db";
import { buildAssistantOverrides, shouldPlaceVoiceCall, parseFinanceConfig, parseLeadCadenceConfig } from "@savvy/core";
import { voice } from "@savvy/integrations";
import { inngest } from "../client";

export const voiceFallback = inngest.createFunction(
  {
    id: "voice-fallback",
    concurrency: { limit: 5 },
    cancelOn: [{ event: "lead/contacted", match: "data.leadId" }],
  },
  { event: "lead/contact-overdue" },
  async ({ event, step }) => {
    const { leadId, tenantId } = event.data;

    // 1) Load everything + decide the guard in one durable step.
    const decision = await step.run("guard", async () => {
      const [t] = await adminDb.select({ name: tenant.name, settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
      const tz = parseFinanceConfig((t?.settings as { finance?: unknown } | null)?.finance).timezone;
      const quietHours = parseLeadCadenceConfig((t?.settings as { leadCadence?: unknown } | null)?.leadCadence).quietHours;

      const row = await withTenant(tenantId, async (tx) => {
        const [r] = await tx
          .select({
            status: lead.status, firstRepContactAt: lead.firstRepContactAt, scoreFeatures: lead.scoreFeatures,
            customerId: lead.customerId, leadName: customer.name, phone: customer.phone,
            smsOptOut: customer.smsOptOut, emailOptOut: customer.emailOptOut, smsConsentAt: customer.smsConsentAt,
            address: property.address,
          })
          .from(lead)
          .leftJoin(customer, eq(lead.customerId, customer.id))
          .leftJoin(property, eq(lead.propertyId, property.id))
          .where(eq(lead.id, leadId));
        return r ?? null;
      });
      if (!row) return { ok: false as const, reason: "no-lead" };

      // step.run JSON-serializes Dates to strings — coerce before the guard.
      const firstRepContactAt = row.firstRepContactAt ? new Date(row.firstRepContactAt as unknown as string) : null;
      const smsConsentAt = row.smsConsentAt ? new Date(row.smsConsentAt as unknown as string) : null;
      const verdict = shouldPlaceVoiceCall({
        status: row.status, firstRepContactAt, phone: row.phone ?? null,
        smsOptOut: row.smsOptOut ?? false, emailOptOut: row.emailOptOut ?? false, smsConsentAt,
        now: new Date(), tz, quietHours,
      });
      if (!verdict.ok) return { ok: false as const, reason: verdict.reason };

      const sf = row.scoreFeatures as { storm?: { maxHailInches?: number; maxWindMph?: number } } | null;
      const storm = sf?.storm;
      const stormContext = storm && (storm.maxHailInches || storm.maxWindMph)
        ? `${storm.maxHailInches ? `${storm.maxHailInches}" hail` : ""}${storm.maxHailInches && storm.maxWindMph ? ", " : ""}${storm.maxWindMph ? `${storm.maxWindMph} mph wind` : ""}`.trim()
        : null;

      return {
        ok: true as const,
        tenantName: t?.name ?? "our team",
        leadName: row.leadName ?? "there",
        address: row.address ?? "",
        phone: row.phone!,
        stormContext,
      };
    });

    if (!decision.ok) {
      await step.run("record-skip", () =>
        recordAgentRun({ tenantId, agent: "comms", taskKey: "lead.voice.fallback", status: "skipped", error: decision.reason }),
      );
      return { status: "skipped", reason: decision.reason };
    }

    // 2) Place the call — memoized so a retry can't double-dial.
    await step.run("place-call", async () => {
      const overrides = buildAssistantOverrides({
        tenantName: decision.tenantName, leadName: decision.leadName, address: decision.address,
        stormContext: decision.stormContext, leadId, tenantId,
      });
      const result = await voice.placeOutboundCall({
        toPhone: decision.phone,
        assistantOverrides: overrides,
        metadata: { leadId, tenantId, direction: "outbound", toPhone: decision.phone },
      });
      await recordAgentRun({
        tenantId, agent: "comms", taskKey: "lead.voice.fallback",
        status: result ? "ok" : "skipped", error: result ? null : "no-vapi-key",
      });
      return { callId: result?.callId ?? null };
    });

    return { status: "placed" };
  },
);
```

> `recordAgentRun`'s `agent` must be one of `AGENT = ["orchestrator","comms","scheduling","finance","claims"]`. Voice is a comms action → `"comms"`. Confirm `customer.smsOptOut`/`emailOptOut`/`smsConsentAt` column names match `crm.ts` (they do — used in `lead-cadence.ts`). No `.js` extensions.

- [ ] **Step 4: Register the function** — in `packages/agents/src/index.ts`:
  - add the import: `import { voiceFallback } from "./functions/voice-fallback";`
  - add the export: `export { voiceFallback } from "./functions/voice-fallback";`
  - add `voiceFallback` to the `functions = [...]` array.

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/functions/voice-fallback.ts packages/agents/src/functions/voice-fallback.test.ts packages/agents/src/index.ts
git commit -m "feat(agents): voiceFallback workflow on lead/contact-overdue (quiet-hours-gated, fail-open)"
```

---

### Task 10: `.env.example` + setup doc

**Files:**
- Modify: `.env.example`
- Create: `docs/VOICE-AGENT-SETUP.md`

- [ ] **Step 1: Add the four VAPI vars** — append to `.env.example` (after the StormProof/Google block, matching the comment style):

```bash
# ── Phase D — AI voice agent (Vapi) ──────────────────────────────────
# Unset VAPI_API_KEY => the voice gateway is the fake: outbound calls no-op and
# the /api/voice/vapi webhook stays inert but deployable (fail-open).
VAPI_API_KEY=
VAPI_ASSISTANT_ID=          # the ONE shared assistant; per-call assistantOverrides brand it per tenant
VAPI_PHONE_NUMBER_ID=       # Vapi phone-number id used as the outbound caller
# Shared secret echoed by Vapi as the x-vapi-secret header on every webhook POST.
# REQUIRED in prod (the webhook 401s without a matching header). Set the assistant's
# server URL to https://<app>/api/voice/vapi.
VAPI_WEBHOOK_SECRET=
```

- [ ] **Step 2: Write the setup doc** — create `docs/VOICE-AGENT-SETUP.md`:

```markdown
# Voice Agent (Vapi) — Setup

Phase D ships **fail-open**: with no `VAPI_API_KEY`, outbound calls no-op and the
webhook is inert but deployable. To turn it on (Brett's hands):

1. **Vapi account** → create ONE shared assistant. Leave brand/persona generic; Savvy
   injects tenant brand + lead context per call via `assistantOverrides`.
2. **Assistant server URL** → `https://<your-app>/api/voice/vapi`. Add a custom header
   `x-vapi-secret: <VAPI_WEBHOOK_SECRET>` (or configure Vapi to send it).
3. **Tools** — the assistant calls `getRecommendedSlots` (no args) and
   `bookSlot({startsAt,endsAt})`; both are handled by the webhook. The full tool defs are
   also pushed per-call via overrides (`buildAssistantOverrides`).
4. **Phone number** → buy/import a number in Vapi, note its `phoneNumberId`. Route inbound
   calls for that number to the shared assistant.
5. **Per-tenant inbound** → set each tenant's `tenant.inboundPhone` to the number whose
   calls should create leads for that tenant (the webhook resolves the tenant by the dialed
   number via `tenantByPhone`).
6. **Env** (Vercel prod) → `VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID`,
   `VAPI_WEBHOOK_SECRET`. Redeploy + re-register Inngest.

Reference pattern: bresco-legal already runs a Vapi assistant (`~/Sites/bresco-legal`) —
same webhook/secret shape; Savvy gets its own account + number.

## Behavior
- **Outbound fallback**: on `lead/contact-overdue` (3-min SLA breach), `voiceFallback` calls
  the lead IF open + uncontacted + has phone + SMS consent + outside quiet hours (tenant tz).
- **Inbound receptionist**: a call to a tenant's number hits the shared assistant → books via
  the engine; the end-of-call report creates a lead-from-call.
- **Outcome**: `lead.voice_outcome` (booked/no_answer/callback/dnc/needs_human) + full
  transcript in `communication` (channel `call`).
```

- [ ] **Step 3: Commit**

```bash
git add .env.example docs/VOICE-AGENT-SETUP.md
git commit -m "docs(voice): document VAPI_* env + Vapi assistant/webhook setup"
```

---

### Task 11 (OPTIONAL): `voice_outcome` badge on lead detail

Skip if it risks bloating the phase or tripping the apps/web typecheck-passes-but-runtime-breaks trap (Slice C gotcha). If included:

**Files:**
- Modify: `apps/web/src/app/(app)/leads/[id]/page.tsx`

- [ ] **Step 1:** Read the page; find where the lead's `scoreBand`/status chip renders (reuse `StatusBadge` from `@/components/cockpit/StatusBadge`).
- [ ] **Step 2:** If `lead.voiceOutcome` is non-null, render a small read-only badge near the status (e.g. `<span data-testid="lead-voice-outcome">Voice: {lead.voiceOutcome}</span>`). Ensure the lead query already selects `voiceOutcome` (add to the `leads-queries.ts` select if missing).
- [ ] **Step 3:** `pnpm typecheck && pnpm lint`; if an e2e seeds a lead, optionally assert the badge. Commit:

```bash
git add apps/web/src/app/(app)/leads/[id]/page.tsx apps/web/src/lib/leads-queries.ts
git commit -m "feat(web): show lead.voice_outcome badge on lead detail (read-only)"
```

---

## Whole-branch review + ship

- [ ] **Whole-branch review** (subagent-driven-development final adversarial review). Focus: tenant isolation on every webhook/workflow write; fail-open holds with no `VAPI_API_KEY`; the `place-call` step is memoized (no double-dial); migration `.sql` + meta committed together; NO `.js` extensions in any `.ts` production file; `bookLeadSlot` doesn't regress `confirmSlot`'s jobId/appointmentId paths; `createLeadForTenant` is called with its real required input shape (no `any`).
- [ ] **Fix-forward** any findings.
- [ ] **Push + PR:**

```bash
git push -u origin feat/voice-agent
gh pr create --base main --title "Phase D: AI voice agent (Vapi inbound + outbound fallback)" --body "<summary + the fail-open + config-dep notes from the spec>"
```

- [ ] **Watch CI:** `gh pr checks <#> --watch` — confirm **build + e2e green** (e2e is where a stray `.js` extension or a `"use server"` type-export would surface). Fix-forward if red.
- [ ] **STOP. Do not merge** until Brett says so. After any future merge, verify `main` stays green (`gh run list --branch main`).

---

## Self-Review (plan vs. spec)

**Spec coverage:**
- Vapi gateway (env-or-fake, fail-open) → Task 4. ✅
- Persona builder + `parseVoiceOutcome` → Tasks 1–2. ✅
- Outbound guard predicate (pure) → Task 3. ✅
- Webhook (`x-vapi-secret`, tool-calls getRecommendedSlots/bookSlot, end-of-call-report, inbound lead-from-call, no-answer SMS) → Task 8. ✅
- `bookLeadSlot` factored from `confirmSlot` → Task 6. ✅
- Migration `lead.voice_outcome` (+meta) → Task 5. ✅
- Transcript in `communication` (no migration) + set outcome → Task 7 (`recordVoiceCallReport`). ✅
- Outbound workflow (cancelOn lead/contacted, quiet-hours-gated, memoized place-call, recordAgentRun) + register → Task 9. ✅
- `.env.example` four vars + doc → Task 10. ✅
- Optional UI badge → Task 11. ✅
- Middleware PUBLIC for the webhook → Task 8 step 6 (a prod-blocker if missed, per 6D lesson). ✅

**Architecture correction baked in:** `AssistantOverrides`/`VoiceLeadContext` live in `@savvy/core` (not integrations), so the gateway imports the type from core — correct dependency direction; Task 4 adds the `@savvy/core` workspace dep + `pnpm install`.

**Type consistency:** `AssistantOverrides` (core, Task 1) is consumed by the gateway (Task 4) and the workflow (Task 9). `VoiceOutcome` (core, Task 2) flows core → `recordVoiceCallReport` (Task 7) → `lead.voiceOutcome` (Task 5). `shouldPlaceVoiceCall` input shape (Task 3) matches what the workflow loads (Task 9). `bookLeadSlot` return union (Task 6) matches the webhook's `"ok" in r` dispatch (Task 8).

**Known soft spots to resolve at implementation time (flagged, not placeholders):**
- Vapi's exact webhook JSON envelope — parsed defensively (Task 8); real shape validated when Brett wires the live assistant (best-effort, like CompanyCam/QBO).
- `createLeadForTenant`'s required input (`leadIntakeObject`) — Task 8 step 5 note says to read it and satisfy the real required fields (phone-or-email; we pass `phone: msg.fromNumber`) instead of the cast placeholder.
- **apps/web has NO vitest project** (`vitest.workspace.ts = ["packages/*"]` — verified): a `.test.ts` under `apps/web/src` is silently never run (two such orphans already exist: `intake.test.ts`, `recommended-slots.test.ts`). Therefore the parser lives in `@savvy/core` (Task 8), `bookLeadSlot` in `@savvy/db` (Task 6), and the route is gated by a Playwright e2e (Task 8 step 7) — never a vitest test in apps/web.
- The `voiceFallback` test harness — Task 9 step 1 mirrors the sibling `lead-cadence.test.ts` harness exactly (read it first).
