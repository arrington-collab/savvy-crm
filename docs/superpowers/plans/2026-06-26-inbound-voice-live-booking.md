# Inbound Voice Live Booking (Riley) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the inbound AI receptionist (Riley) book the inspection live on the call — collect + confirm name/address/city/zip, recommend the territory rep, offer two today-first slots, book — by correlating the lead to the Vapi `call.id` (no `assistant-request` exists for the static pre-assigned assistant).

**Architecture:** Extend the existing public webhook `apps/web/src/app/api/voice/vapi/route.ts`. The mid-call tool dispatch resolves the lead as `metadata.leadId ?? leadByVoiceCallId(tenantId, call.id)`; a new `setCallDetails` tool creates-or-finds the inbound lead by `call.id`, assigns the zip-territory rep, and returns today-first slots from the merged shared engine. Outbound flow (which injects `metadata.leadId`) is untouched.

**Tech Stack:** TypeScript, Next.js route handler, Drizzle ORM (Postgres + RLS), Inngest (events), Vapi (voice), Vitest + Playwright, pnpm + Turborepo.

**Spec:** `docs/superpowers/specs/2026-06-26-inbound-voice-live-booking-design.md`.

## Global Constraints

- **Build off `origin/main`** (has #50 instant-assign service + #51 zip territory UI). This worktree is branched from it.
- **Import-extension rule (match the file you edit):** `packages/core/*`, `packages/db/src/**` SOURCE, `apps/web/*` → NO `.js`; only `packages/db` TEST files use `.js`. A `.js` in a db source file breaks the Turbopack e2e webServer.
- **Single instances:** drizzle ops from `@savvy/db`/`drizzle-orm` (db owns the instance), `z` from `@savvy/core`; within `packages/core` import `z` from `"./schemas"`.
- **Tenant isolation:** the webhook is a PUBLIC route with no Clerk session — it resolves `tenantId` from the dialed number via `tenantByPhone(msg.toNumber)`, then every DB read/write passes that `tenantId` explicitly through `withTenant`/the tenant-scoped readers. Never call the `intake-schedule.ts` server actions here (they use `getTenantId()` / Clerk).
- **Webhook posture:** never 500 — auth failure is a clean 401; any handler error is caught and returns a graceful tool result. Keep the existing `secretOk` (fail-closed in prod, allow in dev/test).
- **Inbound leads use `source: "inbound-call"`** (already the convention; rep-alert speed-to-lead skips it).
- **Outbound path unchanged:** when `metadata.leadId` is present, never use the call-id path.

---

## File Structure

| File | Responsibility | New/Modified |
|---|---|---|
| `packages/db/src/schema/crm.ts` (the `lead` table) | add `voiceCallId` column | Modify |
| `packages/db/drizzle/00NN_*.sql` | generated migration | Create (generated) |
| `packages/db/src/lifecycle/voice.ts` | `setLeadVoiceCallId` + `getLeadByVoiceCallId` | Modify (or create) |
| `packages/db/src/lifecycle/voice.test.ts` | integration test (round-trip + RLS) | Create (or modify) |
| `packages/db/src/index.ts` | export the two readers | Modify |
| `packages/core/src/phone.ts` (or a new `zip.ts`) | `isValidZip` | Modify/Create |
| `packages/core/src/*.test.ts` | `isValidZip` unit test | Modify/Create |
| `packages/core/src/index.ts` | export `isValidZip` if new file | Modify |
| `apps/web/src/app/api/voice/vapi/route.ts` | `setCallDetails` tool + inbound-aware `bookSlot`/`getRecommendedSlots` + end-of-call find-by-call-id | Modify |
| `apps/web/tests/e2e/voice-webhook.spec.ts` | e2e: setCallDetails→bookSlot inbound flow | Modify |
| `docs/.../VOICE-AGENT-SETUP.md` (or a deploy note) | the live Vapi PATCH payload | Modify (deploy step) |

Where `voice_call_id` is read/written through `lifecycle/voice.ts` (where `recordVoiceCallReport` already lives) to keep voice-call DB logic together.

---

### Task 1: `lead.voice_call_id` column + lead-by-call-id readers

**Files:**
- Modify: `packages/db/src/schema/crm.ts` (the `lead` table — confirm the table is there; if `lead` lives in another schema file, edit that one)
- Create (generated): `packages/db/drizzle/00NN_*.sql`
- Modify/Create: `packages/db/src/lifecycle/voice.ts`, `packages/db/src/lifecycle/voice.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Produces:
  - `lead.voiceCallId` — `text("voice_call_id")`, nullable; index `lead_voice_call_id_idx` on `(tenant_id, voice_call_id)`.
  - `setLeadVoiceCallId(tx: Tx, args: { tenantId: string; leadId: string; callId: string }): Promise<void>`
  - `getLeadByVoiceCallId(tenantId: string, callId: string): Promise<{ id: string; assignedUserId: string | null; propertyId: string | null } | null>` — RLS-scoped (opens its own `withTenant`).

- [ ] **Step 1: Add the column + index to the schema**

In the `lead` table definition (find it: `git grep -n "pgTable(\"lead\"" packages/db/src/schema`), add after an existing nullable text column:
```typescript
  voiceCallId: text("voice_call_id"),
```
And in the table's index/extras array (where other `index(...)` calls are), add:
```typescript
  index("lead_voice_call_id_idx").on(t.tenantId, t.voiceCallId),
```
Confirm `text` and `index` are already imported in that file (other columns/indexes use them).

- [ ] **Step 2: Generate + inspect the migration**

Run: `pnpm --filter @savvy/db db:generate`
Open the new `packages/db/drizzle/00NN_*.sql`. Confirm it is exactly `ALTER TABLE "lead" ADD COLUMN "voice_call_id" text;` + the `CREATE INDEX … lead_voice_call_id_idx …`. If drizzle tries to alter anything else, stop and report.

- [ ] **Step 3: Apply locally**

Run: `pnpm db:up && pnpm --filter @savvy/db db:migrate`
Then: `docker exec savvy_db psql -U postgres -d savvy -c '\d "lead"' | grep voice_call_id` → expect `voice_call_id | text`.

- [ ] **Step 4: Write the failing integration test**

In `packages/db/src/lifecycle/voice.test.ts` (mirror an existing `packages/db/src/lifecycle/*.test.ts` for seeding + `.js` imports), add:
```typescript
import { describe, it, expect } from "vitest";
import { withTenant } from "../tenant.js";
import { adminDb, tenant, customer, property, lead } from "../index.js";
import { setLeadVoiceCallId, getLeadByVoiceCallId } from "./voice.js";

async function mkTenant(name: string) {
  const [t] = await adminDb.insert(tenant).values({ name, publicKey: `k-${name}-${Date.now()}`, clerkOrgId: `o-${name}-${Date.now()}` }).returning();
  return t!.id;
}
async function mkLead(tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Caller", phone: "+16025550111" }).returning({ id: customer.id });
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "1 Main St" }).returning({ id: property.id });
    const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "inbound-call" }).returning({ id: lead.id });
    return l!.id;
  });
}

describe("lead voice-call-id correlation", () => {
  it("round-trips the call id and returns the lead", async () => {
    const tid = await mkTenant("vc-rt");
    const leadId = await mkLead(tid);
    await withTenant(tid, (tx) => setLeadVoiceCallId(tx, { tenantId: tid, leadId, callId: "vapi-call-1" }));
    const found = await getLeadByVoiceCallId(tid, "vapi-call-1");
    expect(found?.id).toBe(leadId);
  });
  it("returns null for an unknown call id", async () => {
    const tid = await mkTenant("vc-none");
    expect(await getLeadByVoiceCallId(tid, "nope")).toBeNull();
  });
  it("does not find another tenant's call id (RLS)", async () => {
    const t1 = await mkTenant("vc-iso1");
    const t2 = await mkTenant("vc-iso2");
    const leadId = await mkLead(t2);
    await withTenant(t2, (tx) => setLeadVoiceCallId(tx, { tenantId: t2, leadId, callId: "shared-id" }));
    expect(await getLeadByVoiceCallId(t1, "shared-id")).toBeNull();
  });
});
```
(Adjust the `customer`/`property`/`lead` insert columns to match the real NOT-NULL columns — read a sibling lifecycle test that seeds these.)

Run: `pnpm --filter @savvy/db test src/lifecycle/voice.test.ts` → FAIL (not exported).

- [ ] **Step 5: Implement the readers**

In `packages/db/src/lifecycle/voice.ts` (db source = NO `.js`):
```typescript
import { withTenant, type Tx } from "../tenant";
import { lead } from "../schema";
import { and, eq } from "drizzle-orm";

export async function setLeadVoiceCallId(tx: Tx, args: { tenantId: string; leadId: string; callId: string }): Promise<void> {
  await tx.update(lead).set({ voiceCallId: args.callId }).where(and(eq(lead.tenantId, args.tenantId), eq(lead.id, args.leadId)));
}

export async function getLeadByVoiceCallId(
  tenantId: string,
  callId: string,
): Promise<{ id: string; assignedUserId: string | null; propertyId: string | null } | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: lead.id, assignedUserId: lead.assignedUserId, propertyId: lead.propertyId })
      .from(lead)
      .where(and(eq(lead.tenantId, tenantId), eq(lead.voiceCallId, callId)));
    return row ?? null;
  });
}
```
(If `voice.ts` already imports some of these, merge — don't duplicate imports. Confirm `Tx` is exported from `../tenant`; if not, mirror how other lifecycle files type the tx param.)

- [ ] **Step 6: Export + run + commit**

Add to `packages/db/src/index.ts`: extend the existing `from "./lifecycle/voice"` export (NO `.js` — db source re-exports are extension-less; verify by matching the sibling lines) with `setLeadVoiceCallId, getLeadByVoiceCallId`.
Run: `pnpm --filter @savvy/db test src/lifecycle/voice.test.ts` → PASS; `pnpm --filter @savvy/db typecheck`.
```bash
git add packages/db/src/schema packages/db/drizzle packages/db/src/lifecycle/voice.ts packages/db/src/lifecycle/voice.test.ts packages/db/src/index.ts
git commit -m "feat(db): lead.voice_call_id + lead-by-call-id readers (inbound voice correlation)"
```

---

### Task 2: `isValidZip` core helper

**Files:**
- Modify: `packages/core/src/phone.ts` (co-locate with `normalizePhone`) or create `packages/core/src/zip.ts`; export from `packages/core/src/index.ts` if new.
- Test: the matching `*.test.ts`.

**Interfaces:**
- Produces: `isValidZip(raw: string | null | undefined): boolean` — true only for a US 5-digit ZIP (`/^\d{5}$/` after trim).

- [ ] **Step 1: Failing test**
```typescript
import { isValidZip } from "./phone"; // or "./zip"
describe("isValidZip", () => {
  it("accepts a 5-digit zip", () => { expect(isValidZip("85203")).toBe(true); expect(isValidZip(" 85203 ")).toBe(true); });
  it("rejects wrong length / non-numeric / empty", () => {
    for (const v of ["8520", "852033", "8520a", "", null, undefined]) expect(isValidZip(v)).toBe(false);
  });
});
```
Run the focused test → FAIL.

- [ ] **Step 2: Implement**
```typescript
/** True only for a US 5-digit ZIP (zip drives territory assignment). */
export function isValidZip(raw: string | null | undefined): boolean {
  return typeof raw === "string" && /^\d{5}$/.test(raw.trim());
}
```
- [ ] **Step 3: Run → PASS; export if new file; typecheck; commit**
```bash
git add packages/core/src
git commit -m "feat(core): isValidZip 5-digit validator for voice zip capture"
```

---

### Task 3: Webhook — `setCallDetails` tool + inbound-aware booking

**Files:**
- Modify: `apps/web/src/app/api/voice/vapi/route.ts`
- Modify: `apps/web/tests/e2e/voice-webhook.spec.ts`

**Interfaces:**
- Consumes: `tenantByPhone`, `createLeadForTenant` (`@/lib/intake`); `recommendAssignee`, `setLeadOwner`, `markLeadContacted`, `withTenant`, `bookLeadSlot`, `getLeadByVoiceCallId`, `setLeadVoiceCallId` (`@savvy/db`); `slotsForRep` (`@/lib/recommended-slots`); `isValidZip`, `parseVapiMessage`, `toolResult` (`@savvy/core`); `inngest` (`@savvy/agents`).
- Produces: the webhook books inbound calls live. Outbound (with `metadata.leadId`) unchanged.

- [ ] **Step 1: Restructure the tool-call dispatch**

Replace the tool-call block (current lines ~39–73) with the version below. Add the new imports at the top (merge with existing import lines):
```typescript
import { recommendAssignee, setLeadOwner, markLeadContacted, withTenant, bookLeadSlot, getLeadByVoiceCallId, setLeadVoiceCallId, recordVoiceCallReport, createBookingLink } from "@savvy/db";
import { isValidZip, /* …existing… */ parseVapiMessage, toolResult } from "@savvy/core";
import { getRecommendedSlots, slotsForRep } from "@/lib/recommended-slots";
```
Dispatch:
```typescript
  if (msg.type === "tool-calls" || msg.type === "function-call") {
    const tc = msg.toolCalls[0];
    if (!tc) return NextResponse.json(toolResult("", { error: "no tool call" }));

    // Outbound injects tenantId+leadId in metadata; inbound resolves tenant by the dialed number.
    const tenantId = msg.metadata.tenantId ?? (msg.toNumber ? (await tenantByPhone(msg.toNumber))?.id ?? null : null);

    // --- setCallDetails: capture address+zip, create/find the call's lead, assign rep, offer slots
    if (tc.name === "setCallDetails") {
      if (!tenantId) return NextResponse.json(toolResult(tc.id, { saved: false, message: "I'll have a specialist call you right back." }));
      const zip = String(tc.args.zip ?? "").trim();
      if (!isValidZip(zip)) return NextResponse.json(toolResult(tc.id, { needZip: true, message: "Please ask the caller to confirm their 5-digit ZIP code." }));
      const name = String(tc.args.name ?? "Inbound caller");
      const address = String(tc.args.address ?? "").trim();
      const city = String(tc.args.city ?? "").trim();
      try {
        let existing = msg.callId ? await getLeadByVoiceCallId(tenantId, msg.callId) : null;
        let leadId = existing?.id;
        if (!leadId) {
          leadId = await createLeadForTenant(tenantId, {
            name, phone: msg.fromNumber ?? undefined, address: address.length >= 3 ? address : "Unknown",
            source: "inbound-call", city: city || undefined, zip,
          });
          if (msg.callId) await withTenant(tenantId, (tx) => setLeadVoiceCallId(tx, { tenantId, leadId: leadId!, callId: msg.callId! }));
        }
        const repId = await recommendAssignee(tenantId, { zip, city: city || null, state: null });
        if (!repId) return NextResponse.json(toolResult(tc.id, { saved: true, slots: [], message: "I'll have a specialist call you right back." }));
        await withTenant(tenantId, (tx) => setLeadOwner(tx, { tenantId, leadId: leadId!, userId: repId }));
        const { slots } = await slotsForRep({ tenantId, repId, todayFirst: true, limit: 2 });
        return NextResponse.json(toolResult(tc.id, { saved: true, slots }));
      } catch (e) {
        console.error("setCallDetails failed", e);
        return NextResponse.json(toolResult(tc.id, { saved: false, message: "I'll have a specialist call you right back." }));
      }
    }

    // --- getRecommendedSlots / bookSlot: resolve leadId (outbound metadata, else by call.id)
    const leadId = msg.metadata.leadId ?? (tenantId && msg.callId ? (await getLeadByVoiceCallId(tenantId, msg.callId))?.id ?? null : null);
    if (!leadId) return NextResponse.json(toolResult(tc.id, { error: "no lead context", message: "Let's get your address and ZIP first." }));

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
        try { await withTenant(r.tenantId, (tx) => markLeadContacted(tx, { tenantId: r.tenantId, leadId })); } catch (e) { console.error(e); }
        try { await inngest.send({ name: "appointment/booked", data: { appointmentId: r.appointmentId, tenantId: r.tenantId } }); } catch (e) { console.error(e); }
        return NextResponse.json(toolResult(tc.id, { booked: true }));
      }
      const message = r.error === "slot_taken" ? "That time was just taken — offer another." : "Could not book — offer to have a rep follow up.";
      return NextResponse.json(toolResult(tc.id, { booked: false, message }));
    }
    return NextResponse.json(toolResult(tc.id, { error: "unknown tool" }));
  }
```

- [ ] **Step 2: End-of-call — find by call.id before creating**

In the `end-of-call-report` block, before the `createLeadForTenant` fallback, look up the lead the tool-calls already made:
```typescript
    if (!leadId && msg.toNumber) {
      const t = await tenantByPhone(msg.toNumber);
      if (t) {
        tenantId = t.id;
        const existing = msg.callId ? await getLeadByVoiceCallId(t.id, msg.callId) : null;
        if (existing) {
          leadId = existing.id;
        } else if (msg.fromNumber) {
          try { leadId = await createLeadForTenant(t.id, { name: "Inbound caller", phone: msg.fromNumber, address: "Unknown", source: "inbound-call" }); }
          catch (e) { console.error("inbound lead-from-call failed", e); }
        }
      }
    }
```
(Leave the rest — `recordVoiceCallReport`, no-answer SMS — unchanged.)

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @savvy/web typecheck`. Expected clean. (`tc.args` is `Record<string, unknown>`; `String(... ?? "")` coercions are intentional.)

- [ ] **Step 4: e2e — inbound setCallDetails → bookSlot**

Add to `apps/web/tests/e2e/voice-webhook.spec.ts` (keep the existing auth tests). Use the e2e tenant; set its `inboundPhone`; seed two reps + a zip territory rule; POST Vapi tool-call payloads with the `x-vapi-secret` header (`test-vapi-secret`). Helper to post:
```typescript
const SECRET = "test-vapi-secret";
function toolCallBody(callId: string, toNumber: string, fromNumber: string, name: string, args: Record<string, unknown>) {
  return { message: { type: "tool-calls", call: { id: callId, phoneNumber: { number: toNumber }, customer: { number: fromNumber }, metadata: {} },
    toolCalls: [{ id: "tc1", function: { name, arguments: JSON.stringify(args) } }] } };
}
```
Test body: set `tenant.inboundPhone` (adminDb update) to a unique number; seed reps + rule (zip 85203 → repB) like `quick-book.spec.ts`; POST `setCallDetails` ({name, address, city:"Mesa", zip:"85203"}) → expect 200 + the JSON result has `results[0].result.slots.length >= 1`; assert (poll) a `lead` row with `voiceCallId === callId`, assigned to repB; then POST `bookSlot` with that slot's `startsAt`/`endsAt` → expect `results[0].result.booked === true`; assert a `scheduled` `appointment` exists. (Confirm the exact response JSON shape from `toolResult` — `{ results: [{ toolCallId, result }] }`.)

Run: `pnpm db:up && cd apps/web && npx tsx tests/e2e/create-tenant.ts && export TEST_TENANT_ID=$(node -e "console.log(require('/tmp/savvy-e2e-tenant.json').id)") && ./node_modules/.bin/playwright test tests/e2e/voice-webhook.spec.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/app/api/voice/vapi/route.ts apps/web/tests/e2e/voice-webhook.spec.ts
git commit -m "feat(web): inbound voice live booking — setCallDetails tool + call-id lead correlation"
```

---

### Task 4: Final verification

- [ ] **Step 1: Full suite + typecheck + lint**
```bash
pnpm db:up && pnpm --filter @savvy/db db:migrate
pnpm test && pnpm typecheck && pnpm lint
```
Expected: green (lint may show the pre-existing `pipeline.spec.ts` warning only).

- [ ] **Step 2: Turbopack boot (e2e parity)** — already covered by the voice-webhook e2e booting `next dev`; confirm it's green.

---

## Deploy (operator)

1. Merge → apply the migration to prod Neon: `DATABASE_ADMIN_URL=<neon admin> DATABASE_URL=<neon> pnpm --filter @savvy/db db:migrate` (applies `lead.voice_call_id`).
2. `vercel --prod --scope advosy` from an `origin/main`-equiv worktree with `.vercel` copied.
3. **PATCH live Riley** (`VAPI_ASSISTANT_ID`) via the Vapi API (curl, not urllib) — add the tool + extend the system prompt. Tool:
```json
{ "type": "function", "function": {
  "name": "setCallDetails",
  "description": "Save the caller's name and property address BEFORE offering appointment times. Call this first, once you have read back and confirmed the street address, city, and 5-digit ZIP code. Returns up to two appointment times to offer.",
  "parameters": { "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Caller's full name" },
      "address": { "type": "string", "description": "Street address" },
      "city": { "type": "string", "description": "City" },
      "zip": { "type": "string", "description": "5-digit ZIP code, confirmed with the caller" }
    }, "required": ["zip"] } } }
```
Prompt addition: *"Before offering any appointment times, collect and read back the caller's name, street address, city, and 5-digit ZIP code to confirm, then call setCallDetails. If it replies needZip, ask the caller to repeat their ZIP. Only offer the times setCallDetails returns; then call bookSlot with the chosen time."*
4. Verify via GET that `setCallDetails` is in `model.tools` and the prompt mentions the ZIP. Place a real inbound test call.

---

## Self-Review (completed by plan author)

- **Spec coverage:** call-id correlation → Task 1 (column + readers) + Task 3 (dispatch). zip-confirm/validate → Task 2 + `setCallDetails`. recommend+assign+slots → `setCallDetails`. inbound book → `bookSlot` branch. end-of-call no-duplicate → Task 3 Step 2. live Riley tool+prompt → Deploy §3. Non-goals (specific-time voice, geocoding, outbound changes) → untouched.
- **Placeholder scan:** none. Test seeds say "match the real NOT-NULL columns / confirm the response shape" — these are read-an-existing-sibling instructions, the correct way to match established test fixtures, not placeholders for logic.
- **Type consistency:** `getLeadByVoiceCallId(tenantId, callId)` and `setLeadVoiceCallId(tx, {tenantId,leadId,callId})` match between Task 1 and their Task 3 call sites. `recommendAssignee(tenantId,{zip,city,state})`, `slotsForRep({tenantId,repId,todayFirst,limit})`, `bookLeadSlot({leadId,startsAt,endsAt})→{appointmentId,jobId,tenantId}|{error}`, `markLeadContacted(tx,{tenantId,leadId})` all match the merged engine signatures.
- **Webhook posture:** every new handler path is wrapped so a failure returns a graceful `toolResult`, never a 500; auth unchanged.
