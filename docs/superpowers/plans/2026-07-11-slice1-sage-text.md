# Slice 1 — Sage by Text (reply-to-act) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline, this session). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a verified owner run the exception queue from their phone — a numbered digest SMS where replying "1" resolves an exception exactly as the Today card's primary action would, with a confirm round-trip on money, idempotent replays, free-text → cited Sage answers, and a red-path-tested "no actions from unverified numbers" invariant.

**Architecture:** Pure `@savvy/core` logic (command parse, numbered-digest formatting, confirm gate) is TDD'd with zero DB. A new `sage` schema (migration 0074) persists (a) per-send numbered mappings so an inbound "1" resolves deterministically + supersedes, and (b) a `sage_remote_action` evidence log powering the `sage.remote_actions` invariant. A verified-owner short-circuit at the top of `handleInboundSms` routes commands to `handleSageCommand`, which dispatches to the EXISTING action handlers (`sendEstimateAction`, `sendInvoiceAction`, `completeManualTask`, `setCreditRequestSent`). Voice is a separate follow-up PR (1b) — NOT in this plan.

**Tech Stack:** Next.js route handlers, Drizzle + Postgres RLS, `@savvy/core` (vitest), `@savvy/ai` gateway (free-text Sage reuse), Twilio inbound/outbound via existing `getTenantSms`.

## Global Constraints (verbatim from spec + CLAUDE.md)
- Actions accepted ONLY from a phone number registered + verified on an org-admin (`owner`/`admin`) user. Verification = code sent to the number, once.
- Action set = the exception card's existing one-tap actions. NEVER arbitrary ops; never money movement beyond what the card could do.
- Money actions above the tenant threshold require a confirm round-trip.
- Idempotent: replaying "1" after resolution returns "already done at <time>"; numbered mappings expire when the digest is superseded.
- `Reply "1?"` (or unknown input) ⇒ detail, not action.
- Evidence: bind `sage.remote_actions` — every SMS action logs phone, user, exception id, confirmation state. Invariant: zero actions from unverified numbers (red-path test).
- All timestamps in tenant TZ. Tenant isolation + RLS on every new table. No secrets in repo. Tests + typecheck + lint per slice.
- v1 action set (owner-approved this session): `approve_estimate`, `send_invoice`, `complete_task`, `send_credit`. Other kinds appear in the readout but reply-N ⇒ detail + deep link.
- Migration number (this worktree's journal, next after `0073_large_crystal`): **0074**.

---

## File Structure

**New pure core (TDD, no DB):**
- `packages/core/src/sage/command.ts` — `parseSageCommand(body)` → discriminated `SageCommand`.
- `packages/core/src/sage/digest-text.ts` — `buildSageDigestText(items, {tz})`, `actionVerb`, `describeSageItem`.
- `packages/core/src/sage/confirm.ts` — `requiresConfirm(item, cfg)`, `confirmPrompt(item, {tz})`, `usdCents`.
- Types shared in `packages/core/src/sage/types.ts` — `SageActionKind`, `SageDigestItem`, `SageCommand`.
- Tests colocated: `command.test.ts`, `digest-text.test.ts`, `confirm.test.ts`.

**Evidence:**
- Modify `packages/core/src/verification/checks.ts` — add `"sage.remote_actions"` invariant (UNBOUND — not added to `CHECK_BINDINGS`).
- Modify `packages/core/src/verification/checks.test.ts` — red/green path.

**Schema + db (migration 0074):**
- Modify `packages/db/src/schema/tenancy.ts` — add `phoneVerifiedAt`, `phoneVerifyCode`, `phoneVerifyExpiresAt` to `user`.
- Create `packages/db/src/schema/sage.ts` — `sageDigest`, `sageRemoteAction` tables (tenant_id + `tenantIsolation()`).
- Modify `packages/db/src/schema/index.ts` (or wherever schema is barrelled) to export sage tables.
- Create `packages/db/src/lifecycle/sage.ts` — verification, digest persist/resolve, remote-action log, `loadSageActionables`.
- Modify `packages/db/src/index.ts` — export the new lifecycle fns + tables.
- Generated `packages/db/drizzle/0074_*.sql` via `pnpm db:generate`.

**Wiring (web):**
- Create `apps/web/src/lib/sage-remote.ts` — `handleSageCommand`, `dispatchSageAction`, `handlePhoneVerificationSms`.
- Modify `apps/web/src/lib/inbound-sms.ts` — verified-owner + verification short-circuit before customer match.
- Create `apps/web/src/lib/sage-verify-actions.ts` — `startSagePhoneVerification()` server action (owner triggers code send).
- Modify `packages/agents/src/ops-digest.ts` — append numbered actionable block + persist `sage_digest` mapping.
- Modify `packages/core/src/index.ts` — export `./sage/*`.

**Tests:**
- `packages/db/tests/sage.test.ts` — integration (verify flow, digest supersede, idempotency, RLS red-path) — CI (needs Postgres).
- `apps/web/tests/e2e/sage-remote.spec.ts` — inbound command round-trip incl. unverified-number red-path.

---

## Task order (each ends independently testable)

### Task 1 — `parseSageCommand` (pure)
**Files:** Create `packages/core/src/sage/types.ts`, `packages/core/src/sage/command.ts`, `packages/core/src/sage/command.test.ts`.
**Produces:**
```ts
export type SageActionKind = "approve_estimate" | "send_invoice" | "complete_task" | "send_credit";
export type SageCommand =
  | { type: "action"; n: number }
  | { type: "detail"; n: number }
  | { type: "confirm"; ok: boolean }
  | { type: "help" }
  | { type: "verify"; code: string }
  | { type: "freetext"; text: string };
export function parseSageCommand(body: string): SageCommand;
```
**Rules (tests):** `"1"`→action n=1; `" 2 "`→action n=2; `"12"`→action n=12; `"1?"`→detail n=1; `"YES"/"y"`→confirm ok=true; `"NO"/"n"`→confirm ok=false; `"HELP"/"SAGE"/"QUEUE"`→help; `"VERIFY 123456"` or a bare 6-digit `"123456"`→verify code; anything else→freetext (trimmed original). Case-insensitive; trims. A bare number > 0 with no `?`→action; with trailing `?`→detail.
Steps: write failing tests → run (fail) → implement → run (pass) → `pnpm --filter @savvy/core typecheck` → commit.

### Task 2 — numbered digest text (pure)
**Files:** Create `packages/core/src/sage/digest-text.ts`, `digest-text.test.ts`. Add `SageDigestItem` to `types.ts`.
**Produces:**
```ts
export type SageDigestItem = {
  kind: string;              // ExceptionKind | task-exception kind
  entityId: string;          // estimateId | invoiceId | taskId | creditId
  jobId: string | null;
  title: string; detail: string;
  action: SageActionKind | null;
  confirmAmountCents: number | null;
};
export function actionVerb(a: SageActionKind): string; // approve|send|complete|send credit request
export function buildSageDigestText(items: SageDigestItem[], opts: { tz: string }): { body: string; count: number };
export function describeSageItem(item: SageDigestItem, n: number): string;
```
**Rules (tests):** numbered lines `(1) <title> — <detail> — reply 1 to <verb>` for actionable; `(3) <title> — <detail> — reply 3 for detail` for `action:null`; header `Savvy: N to act`; empty list ⇒ `{ body: "", count: 0 }`; `describeSageItem` returns a one-line detail with the deep-link path.

### Task 3 — confirm gate (pure)
**Files:** Create `packages/core/src/sage/confirm.ts`, `confirm.test.ts`.
**Produces:**
```ts
export function usdCents(cents: number): string;                 // "$32,750"
export function requiresConfirm(item: SageDigestItem, cfg: { approvalThresholdCents: number | null }): boolean;
export function confirmPrompt(item: SageDigestItem, opts: { tz: string }): string;
```
**Rules (tests):** `requiresConfirm` true only for money actions (`approve_estimate`, `send_invoice`) when `confirmAmountCents != null && threshold != null && amount > threshold`; false for `complete_task`/`send_credit`; false when threshold null. `confirmPrompt` → `"Reply YES to approve $32,750 estimate to Kowalski"` (verb from action, amount from usdCents). Then export all of `./sage/*` from `packages/core/src/index.ts`; `pnpm --filter @savvy/core test && typecheck`; commit.

### Task 4 — `sage.remote_actions` invariant + red-path
**Files:** Modify `packages/core/src/verification/checks.ts` (+ `checks.test.ts`).
**Invariant:** `invariant("sage.remote_actions", "select id from sage_remote_action where tenant_id = $1 and verified = false and confirmation_state <> 'rejected'", { toRef: (r) => ({ type: "sage_remote_action", ref: String(r.id) }) })`. UNBOUND (do NOT touch `CHECK_BINDINGS`).
**Tests (fakeDb pattern):** registered; fail + `sage_remote_action` ref when a row returned; pass when none. `pnpm --filter @savvy/core test`; commit.

### Task 5 — schema + migration 0074
**Files:** Modify `packages/db/src/schema/tenancy.ts`; create `packages/db/src/schema/sage.ts`; barrel-export; `pnpm db:generate`.
**`user` adds:** `phoneVerifiedAt timestamptz`, `phoneVerifyCode text`, `phoneVerifyExpiresAt timestamptz`.
**`sage_digest`:** `id`, `tenantId uuid→tenant.id`, `userId uuid→user.id`, `items jsonb $type<(SageDigestItem & {n:number})[]>`, `supersededAt timestamptz null`, `createdAt`. Index `(tenantId,userId,createdAt)` + `tenantIsolation()`.
**`sage_remote_action`:** `id`, `tenantId`, `userId uuid null`, `phone text notNull`, `digestId uuid null`, `n int null`, `kind text notNull`, `exceptionRef text null`, `action text null`, `confirmationState text notNull` (`immediate|pending|confirmed|rejected`), `verified boolean notNull`, `result text null`, `resolvedAt timestamptz null`, `createdAt`. Index `(tenantId,createdAt)` + `tenantIsolation()`.
Verify generated SQL is `0074_*.sql`, contains both tables + 3 user columns + RLS policies. Commit schema + migration together.

### Task 6 — db lifecycle (`packages/db/src/lifecycle/sage.ts`)
**Produces (all `withTenant`-scoped, RLS):**
```ts
export async function userByPhone(tenantId: string, phone: string, opts?: { verifiedOnly?: boolean }): Promise<{ id: string; role: string; name: string } | null>;
export async function startPhoneVerification(tenantId: string, userId: string, code: string, expiresAt: Date): Promise<void>;
export async function confirmPhoneVerification(tenantId: string, phone: string, code: string, now: Date): Promise<{ userId: string } | null>;
export async function saveSageDigest(tenantId: string, userId: string, items: (SageDigestItem & { n: number })[]): Promise<string>; // supersedes prior active
export async function getActiveSageDigest(tenantId: string, userId: string): Promise<{ id: string; items: (SageDigestItem & { n: number })[] } | null>;
export async function recordSageRemoteAction(input: { tenantId; userId: string | null; phone: string; digestId?: string | null; n?: number | null; kind: string; exceptionRef?: string | null; action?: string | null; confirmationState: string; verified: boolean; result?: string | null; resolvedAt?: Date | null }): Promise<string>;
export async function findResolvedAction(tenantId: string, digestId: string, n: number): Promise<{ resolvedAt: Date; result: string | null } | null>;
export async function getPendingConfirm(tenantId: string, userId: string): Promise<{ id: string; digestId: string | null; n: number | null; action: string | null; exceptionRef: string | null; kind: string } | null>;
export async function resolvePendingConfirm(tenantId: string, id: string, state: "confirmed" | "rejected", result: string | null, now: Date): Promise<void>;
export async function loadSageActionables(tenantId: string): Promise<SageDigestItem[]>; // parked estimates, overdue invoices, open manual tasks, credits-to-review; ranked; cap 8
```
Export from `packages/db/src/index.ts`. Integration test `packages/db/tests/sage.test.ts` (CI Postgres): verify flow, digest supersede sets `supersededAt`, `findResolvedAction` idempotency, RLS cross-tenant read returns nothing.

### Task 7 — web command handler (`apps/web/src/lib/sage-remote.ts`)
**Produces:**
```ts
export async function handleSageCommand(tenantId: string, opts: { from: string; body: string; twilioSid?: string }): Promise<{ reply: string } | null>;
export async function dispatchSageAction(tenantId: string, item: SageDigestItem): Promise<{ ok: boolean; message: string }>;
```
**`handleSageCommand` flow:** parse → `verify` code handled first (`confirmPhoneVerification`); else `userByPhone(verifiedOnly:true)` → if null AND command is action/confirm/detail: `recordSageRemoteAction({verified:false, confirmationState:"rejected", result:"blocked_unverified", ...})` and return null (fall through, no queue disclosure); if null AND freetext/help → return null. If verified owner: `help`→readout via `loadSageActionables`+`buildSageDigestText`; `detail n`→`describeSageItem`; `action n`→ idempotency check (`findResolvedAction`)→ "already done at <tz time>", else `requiresConfirm`→ set pending (`recordSageRemoteAction confirmationState:"pending"`) + `confirmPrompt`, else execute+record `immediate`; `confirm`→ `getPendingConfirm`→ execute (YES) or reject (NO). Every executed/blocked path calls `recordSageRemoteAction`. `freetext`→ free-text Sage (Task 8).
**`dispatchSageAction`** maps `action`→ existing handler: `approve_estimate`→`sendEstimateAction(entityId, jobId)`; `send_invoice`→`sendInvoiceAction(entityId)`; `complete_task`→`completeManualTask(jobId, entityId, true)`; `send_credit`→`setCreditRequestSent(tenantId, entityId, {})`.
Reply sent by caller via `getTenantSms`.

### Task 8 — free-text Sage over SMS
**Files:** Modify `apps/web/src/lib/sage-remote.ts`.
Reuse `buildJobLedgerAnswers`/`buildTaskHealthAnswer` (`@savvy/core`). For v1: resolve a job/task from the free-text (simple entity match on recent open jobs by customer name) → fetch `LedgerLite[]` → return the top cited answer string. If no match → "Ask me about a job by name, or text HELP for your queue." (Keep tight; no open-ended LLM.)

### Task 9 — inbound wiring
**Files:** Modify `apps/web/src/lib/inbound-sms.ts`, `apps/web/src/app/api/twilio/inbound/route.ts`.
At the TOP of `handleInboundSms` (before customer match/early-return): `const sage = await handleSageCommand(tenantId, opts); if (sage) { /* send sage.reply via getTenantSms */ return { matched: true, stopped: null }; }`. Only falls through to customer logic when `handleSageCommand` returns null.

### Task 10 — numbered digest at send time
**Files:** Modify `packages/agents/src/ops-digest.ts`.
After existing digest body: `const actionables = await loadSageActionables(tenantId); if (actionables.length) { const numbered = actionables.map((it,i)=>({...it,n:i+1})); await saveSageDigest(tenantId, ownerUserId, numbered); body += "\n\nReply to act:\n" + buildSageDigestText(actionables, {tz}).body; }`. Owner user id already resolved for the send.

### Task 11 — verification trigger + settings surface
**Files:** Create `apps/web/src/lib/sage-verify-actions.ts` (`startSagePhoneVerification()`), minimal settings UI to trigger it. Generates 6-digit code (crypto), `startPhoneVerification`, texts code via `getTenantSms`. Owner replies the code → Task 7 verify path completes.

### Task 12 — e2e red-path + green-path
**Files:** `apps/web/tests/e2e/sage-remote.spec.ts`. Assert: unverified number texting "1" produces NO executed action (only a `rejected` remote-action row) and no reply; verified owner "1" on a seeded digest executes + a replay returns "already done". CI.

---

## Self-Review
- **Coverage:** digest numbering (T2,T10) · security/verified-only (T5,T6,T7,T9,T12) · confirm round-trip (T3,T7) · idempotency/supersede (T5,T6,T7) · free-text Sage (T8) · evidence binding + red-path (T4,T12). Voice = separate PR 1b (explicitly deferred). ✅
- **Types:** `SageDigestItem`/`SageActionKind`/`SageCommand` defined once in `types.ts`, consumed unchanged in T2/T3/T6/T7. ✅
- **Gotcha guard:** `sage.remote_actions` UNBOUND → no `master-task-list.test` array edit. ✅ `@savvy/core` has `noUncheckedIndexedAccess` → index access guarded. ✅
- **Migration:** single 0074 with 2 tables + 3 columns; RLS on both new tables (cross-tenant test stays green). ✅
