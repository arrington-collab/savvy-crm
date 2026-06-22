# Per-tenant Gmail Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each tenant send Savvy's outbound email from their own Gmail/Google Workspace account (OAuth via Nango), falling back to the shared Resend sender when a tenant hasn't connected Gmail.

**Architecture:** A `makeGmailEmail({connectionId})` adapter implements the existing `EmailSender` interface by POSTing an RFC822/base64url message through `nangoProxy` (Gmail API `messages/send`) — mirrors the `gcal` Nango per-connection pattern. A sync `getEmailSender({gmailConnectionId})` resolver returns the Gmail sender when a connection exists, else `resendEmail`. The three email consumers load the tenant's `gmailConnectionId` from `tenant.settings.email` (`parseEmailConfig`) and resolve their sender per-tenant. A "Connect Gmail" settings action stores the Nango connection id (verified via `getNangoConnection`, IDOR-safe) in `tenant.settings.email`.

**Tech Stack:** TypeScript, `@savvy/core` (zod config, vitest), `@savvy/integrations` (vitest), `@savvy/agents` (Inngest consumers), Next.js settings action + client button (apps/web), Nango (`google-mail` OAuth). No schema migration (reuses `tenant.settings` jsonb).

**Spec:** `docs/superpowers/specs/2026-06-22-gmail-email-design.md`

**Gate (repo root):**
```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Docker `savvy_db` running + migrated. **apps/web is Playwright-only** (no vitest there).

---

## File Structure

| File | Responsibility | Task |
|------|----------------|------|
| `packages/core/src/email-config.ts` | `parseEmailConfig` (zod, `{gmailConnectionId?}`) | 1 |
| `packages/core/src/email-config.test.ts` | unit | 1 |
| `packages/core/src/index.ts` | export `parseEmailConfig`, `EmailConfig` | 1 |
| `packages/integrations/src/email.ts` | add `makeGmailEmail` + `getEmailSender` | 2 |
| `packages/integrations/src/email.test.ts` | unit: gmail send shape, resolver | 2 |
| `packages/integrations/src/index.ts` | export `makeGmailEmail`, `getEmailSender` | 2 |
| `packages/agents/src/functions/{appointment-reminders,dunning,drip}.ts` | resolve per-tenant email sender | 3 |
| `apps/web/src/lib/email-actions.ts` | `saveGmailConnection` (IDOR-checked settings write) | 4 |
| `apps/web/src/app/(app)/settings/email/page.tsx` + `ConnectGmailButton.tsx` | Connect Gmail UI | 4 |
| `.env.example`, `.env.production.example` | `NANGO_GMAIL_INTEGRATION_ID` | 5 |

---

## Task 1: `parseEmailConfig` (`@savvy/core`)

**Files:** Create `packages/core/src/email-config.ts`, `packages/core/src/email-config.test.ts`; modify `packages/core/src/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/email-config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseEmailConfig } from "./email-config";

describe("parseEmailConfig", () => {
  it("defaults to an empty config", () => {
    expect(parseEmailConfig(undefined)).toEqual({});
    expect(parseEmailConfig({})).toEqual({});
    expect(parseEmailConfig(null)).toEqual({});
  });
  it("reads gmailConnectionId when present", () => {
    expect(parseEmailConfig({ gmailConnectionId: "conn_123" })).toEqual({ gmailConnectionId: "conn_123" });
  });
  it("ignores unknown keys and wrong types", () => {
    expect(parseEmailConfig({ gmailConnectionId: 42, other: "x" })).toEqual({});
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @savvy/core test -- email-config`
Expected: FAIL — `./email-config` not found.

- [ ] **Step 3: Implement** — Create `packages/core/src/email-config.ts` (mirror `parseSchedulingConfig` in `scheduling.ts` — it imports `z` from `./schemas`):
```ts
import { z } from "./schemas";

export type EmailConfig = { gmailConnectionId?: string };

const schema = z.object({
  gmailConnectionId: z.string().optional(),
});

/** Parse tenant.settings.email. Unknown keys/wrong types are dropped; defaults to {}. */
export function parseEmailConfig(raw: unknown): EmailConfig {
  const p = schema.safeParse(raw ?? {});
  if (!p.success) return {};
  return p.data.gmailConnectionId ? { gmailConnectionId: p.data.gmailConnectionId } : {};
}
```
(If the project's zod is configured to strip unknown keys by default, `other: "x"` is dropped automatically; the explicit return guarantees `{}` when no valid `gmailConnectionId`. The `gmailConnectionId: 42` case fails `z.string()` → `safeParse` still succeeds with the field dropped only if `.optional()` allows absence — to be safe the test expects `{}`, which the explicit return delivers because a non-string `gmailConnectionId` makes `p.success === false` → `{}`.)

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @savvy/core test -- email-config`
Expected: PASS (3 tests).

- [ ] **Step 5: Export + commit**

In `packages/core/src/index.ts`, add: `export { parseEmailConfig, type EmailConfig } from "./email-config";`
```bash
git add packages/core/src/email-config.ts packages/core/src/email-config.test.ts packages/core/src/index.ts
git commit -m "feat(core): parseEmailConfig (tenant.settings.email -> {gmailConnectionId})"
```

---

## Task 2: `makeGmailEmail` adapter + `getEmailSender` resolver (`@savvy/integrations`)

**Files:** Modify `packages/integrations/src/email.ts`, `packages/integrations/src/email.test.ts`, `packages/integrations/src/index.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/integrations/src/email.test.ts`:
```ts
import { makeGmailEmail, getEmailSender } from "./email";
import { resendEmail } from "./email";

describe("makeGmailEmail", () => {
  it("sends an RFC822/base64url message via the Nango proxy and returns {id}", async () => {
    const calls: any[] = [];
    const proxy = async (o: any) => { calls.push(o); return { id: "msg-1" }; };
    const g = makeGmailEmail({ connectionId: "c1", proxyImpl: proxy as never });
    const res = await g.sendEmail({ to: "a@b.com", from: "me@x.com", subject: "Hi", html: "<p>x</p>" });
    expect(res).toEqual({ id: "msg-1" });
    expect(calls[0].connectionId).toBe("c1");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].endpoint).toBe("/gmail/v1/users/me/messages/send");
    const decoded = Buffer.from(calls[0].body.raw, "base64url").toString("utf8");
    expect(decoded).toContain("To: a@b.com");
    expect(decoded).toContain("Subject: Hi");
    expect(decoded).toContain("<p>x</p>");
  });
});

describe("getEmailSender", () => {
  it("returns the Resend sender when no gmail connection", () => {
    expect(getEmailSender({})).toBe(resendEmail);
    expect(getEmailSender({ gmailConnectionId: null })).toBe(resendEmail);
  });
  it("returns a non-Resend (Gmail) sender when a connection is present", () => {
    expect(getEmailSender({ gmailConnectionId: "c1" })).not.toBe(resendEmail);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `pnpm --filter @savvy/integrations test -- email`
Expected: FAIL — `makeGmailEmail`/`getEmailSender` not exported.

- [ ] **Step 3: Implement** — Append to `packages/integrations/src/email.ts` (it already defines `EmailSender`, `makeResendEmail`, `resendEmail`). Add the `nangoProxy` import at the top of the file (`import { nangoProxy } from "./nango";`):
```ts
type NangoProxy = typeof nangoProxy;

/** Per-tenant Gmail sender via Nango's google-mail connection. `proxyImpl` is
 *  injectable for tests; defaults to the real nangoProxy. Gmail sends from the
 *  authorized account regardless of the From header. */
export function makeGmailEmail(cfg: { connectionId: string; integrationId?: string; proxyImpl?: NangoProxy }): EmailSender {
  const proxy = cfg.proxyImpl ?? nangoProxy;
  const integrationId = cfg.integrationId ?? process.env.NANGO_GMAIL_INTEGRATION_ID ?? "google-mail";
  return {
    async sendEmail({ to, from, subject, html }) {
      const raw = Buffer.from(
        [
          `To: ${to}`,
          `From: ${from}`,
          `Subject: ${subject}`,
          "MIME-Version: 1.0",
          'Content-Type: text/html; charset="UTF-8"',
          "",
          html,
        ].join("\r\n"),
      ).toString("base64url");
      const res = await proxy({
        connectionId: cfg.connectionId,
        integrationId,
        method: "POST",
        endpoint: "/gmail/v1/users/me/messages/send",
        body: { raw },
      });
      return { id: (res as { id: string }).id };
    },
  };
}

/** Resolve the email sender for a tenant: Gmail when connected, else shared Resend. */
export function getEmailSender(o: { gmailConnectionId?: string | null }): EmailSender {
  return o.gmailConnectionId ? makeGmailEmail({ connectionId: o.gmailConnectionId }) : resendEmail;
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `pnpm --filter @savvy/integrations test -- email`
Expected: PASS (existing Resend tests + 3 new).

- [ ] **Step 5: Export + commit**

In `packages/integrations/src/index.ts`, extend the email export line to:
```ts
export { resendEmail, makeResendEmail, makeGmailEmail, getEmailSender, type EmailSender } from "./email";
```
```bash
git add packages/integrations/src/email.ts packages/integrations/src/email.test.ts packages/integrations/src/index.ts
git commit -m "feat(integrations): makeGmailEmail (Nango google-mail) + getEmailSender resolver"
```

---

## Task 3: Resolve per-tenant email sender in the three consumers

**Files:** Modify `packages/agents/src/functions/appointment-reminders.ts`, `dunning.ts`, `drip.ts`.

**Pattern for all three:** each function already runs in tenant context and loads the tenant row / `tenant.settings`. Derive the connection id once and resolve the sender at the send site:
```ts
import { getEmailSender } from "@savvy/integrations";
import { parseEmailConfig } from "@savvy/core";
// where the tenant row `t` (with `.settings`) is loaded:
const gmailConnectionId = parseEmailConfig((t?.settings as { email?: unknown } | undefined)?.email).gmailConnectionId;
// at the send site, replace `resendEmail.sendEmail(...)` with:
await getEmailSender({ gmailConnectionId }).sendEmail(...);
```
`gmailConnectionId` is a plain string — safe to carry across Inngest `step.run` boundaries (JSON-serializable) if you load it in a setup step and reference it later.

- [ ] **Step 1: `appointment-reminders.ts`** — READ the file. It loads `t` and builds a `ctx` (it already pulls `settings: (t?.settings as {scheduling?:unknown})?.scheduling`). Add `gmailConnectionId: parseEmailConfig((t?.settings as { email?: unknown })?.email).gmailConnectionId ?? null` to that `ctx` object (so it survives step serialization). At the email branch, change `await resendEmail.sendEmail({ to, from: process.env.EMAIL_FROM ?? "noreply@example.com", subject: "Appointment reminder", html: body })` to `await getEmailSender({ gmailConnectionId: ctx.gmailConnectionId }).sendEmail({ ...same args... })`. Add the imports (`getEmailSender` from `@savvy/integrations`, `parseEmailConfig` from `@savvy/core`). Keep `resendEmail` import only if still referenced elsewhere; otherwise remove it.

- [ ] **Step 2: `dunning.ts`** — READ the file. It loads `t` and does `parseFinanceConfig((t?.settings as {finance?:unknown})?.finance)`. Compute `const gmailConnectionId = parseEmailConfig((t?.settings as { email?: unknown })?.email).gmailConnectionId ?? null;` in the same scope where `t` is available, and carry it to the email step (add to the step's serialized data if the send happens in a later `step.run`). Replace `await resendEmail.sendEmail({...})` with `await getEmailSender({ gmailConnectionId }).sendEmail({...})`. Add imports; drop the now-unused `resendEmail` import if nothing else uses it.

- [ ] **Step 3: `drip.ts`** — READ the file. `sendDripStep` receives `{ sms, email }` deps; the drip Inngest function constructs `{ sms, email: resendEmail }` at the call site (around line 181) after loading the tenant. Load the tenant settings there (if not already loaded, add a `withTenant` select of `tenant.settings`), compute `gmailConnectionId` via `parseEmailConfig`, and change the deps to `{ sms, email: getEmailSender({ gmailConnectionId }) }`. The `SendDeps`/`sendDripStep` signature is unchanged (still takes an `EmailSender`), so the unit tests that inject a mock `email` are unaffected. Add imports; drop `resendEmail` import if unused.

- [ ] **Step 4: Run the gate**

Run: `export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy && pnpm typecheck && pnpm lint && pnpm --filter @savvy/agents test`
Expected: PASS. (No tenant has a Gmail connection in tests → `getEmailSender` returns `resendEmail` → identical to today. Drip's injected-mock tests are unaffected because the deps shape is unchanged.)

- [ ] **Step 5: Verify no stray `resendEmail` direct calls remain unintentionally**

Run: `grep -rn "resendEmail" packages/agents/src`
Expected: only import lines that are still used (if any) — no direct `resendEmail.sendEmail(` calls remain in the three consumers (they now go through `getEmailSender`).

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/functions/appointment-reminders.ts packages/agents/src/functions/dunning.ts packages/agents/src/functions/drip.ts
git commit -m "feat(email): consumers resolve per-tenant sender (Gmail when connected, else Resend)"
```

---

## Task 4: Connect Gmail settings action + UI

**Files:** Create `apps/web/src/lib/email-actions.ts`, `apps/web/src/app/(app)/settings/email/page.tsx`, `apps/web/src/app/(app)/settings/email/ConnectGmailButton.tsx`.

- [ ] **Step 1: Implement the action** — Create `apps/web/src/lib/email-actions.ts`. Mirror `apps/web/src/lib/quickbooks-actions.ts` (read it), but store the connection id in `tenant.settings.email.gmailConnectionId` via read-modify-write (preserve sibling settings) and gate on `isOrgAdmin()`:
```ts
"use server";
import { adminDb, tenant, eq } from "@savvy/db";
import { getNangoConnection } from "@savvy/integrations";
import { getTenantId } from "./tenant";
import { isOrgAdmin } from "./authz";
import { revalidatePath } from "next/cache";

export async function saveGmailConnection(
  connectionId: string,
): Promise<{ ok: true } | { error: "missing_connection_id" | "forbidden" | "not_verified" }> {
  if (!connectionId) return { error: "missing_connection_id" as const };
  if (!(await isOrgAdmin())) return { error: "forbidden" as const };

  const tenantId = await getTenantId();
  const integrationId = process.env.NANGO_GMAIL_INTEGRATION_ID ?? "google-mail";
  const conn = await getNangoConnection({ connectionId, integrationId });
  // Fail closed: only persist if Nango confirms this connection belongs to this tenant's org.
  if (!conn || conn.organizationId !== tenantId) return { error: "not_verified" as const };

  // Read-modify-write tenant.settings so sibling keys (scheduling/finance/esign) survive.
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const settings = (t?.settings as Record<string, unknown>) ?? {};
  const email = { ...((settings.email as object) ?? {}), gmailConnectionId: connectionId };
  await adminDb.update(tenant).set({ settings: { ...settings, email } }).where(eq(tenant.id, tenantId));

  revalidatePath("/settings/email");
  return { ok: true as const };
}
```

- [ ] **Step 2: Implement the page + button** — Create `apps/web/src/app/(app)/settings/email/page.tsx` and `ConnectGmailButton.tsx` mirroring `apps/web/src/app/(app)/settings/quickbooks/page.tsx` + `ConnectQuickBooksButton.tsx` (read both). The page (server component) reads whether the tenant already has `settings.email.gmailConnectionId` (via `getTenantId` + a tenant-settings read in a small query, or reuse an existing settings-reading query helper) and renders `<ConnectGmailButton connected={...} .../>`. The button (client) uses the Nango frontend SDK the same way the QBO button does, calling `saveGmailConnection(connectionId)` in its success path with the `google-mail` integration id; show connected/disconnected + toast on success/error (reuse the QBO button's error-toast structure with Gmail-appropriate copy).

> **Implementer note:** match HOW `ConnectQuickBooksButton.tsx` invokes Nango (frontend SDK import, session/connect call, `onSuccess` → action). If the QBO button uses a server action to mint a Nango connect session token first, replicate that for Gmail. Keep the integration id = `process.env.NANGO_GMAIL_INTEGRATION_ID ?? "google-mail"` (server side) / the same key client side. Do not invent a new connect mechanism — copy the working one.

- [ ] **Step 3: Typecheck + lint**

Run: `export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/email-actions.ts "apps/web/src/app/(app)/settings/email/page.tsx" "apps/web/src/app/(app)/settings/email/ConnectGmailButton.tsx"
git commit -m "feat(web): Connect Gmail settings page + saveGmailConnection (IDOR-checked, admin-gated)"
```

---

## Task 5: env docs, gate, build, review, PR

- [ ] **Step 1: Document env** — Append to BOTH `.env.example` and `.env.production.example` (near the existing Nango block):
```
# Per-tenant Gmail send (Nango google-mail). Each tenant OAuths their own Google
# account; mail sends from that account. gmail.send is a restricted scope — the
# Google OAuth app runs in "testing mode" for the pilot (add test users); real
# multi-tenant prod needs Google verification + CASA.
NANGO_GMAIL_INTEGRATION_ID=google-mail
```

- [ ] **Step 2: Full gate**

```bash
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Expected: typecheck 7/7, lint 0, all unit/integration pass (incl. new `parseEmailConfig`, `makeGmailEmail`, `getEmailSender`).

- [ ] **Step 3: Production build**

```bash
rm -rf apps/web/.next && pnpm --filter @savvy/web build
```
Expected: compiles; `/settings/email` appears as a route.

- [ ] **Step 4: Commit env + push + PR**

```bash
git add .env.example .env.production.example
git commit -m "docs(email): NANGO_GMAIL_INTEGRATION_ID env"
git push -u origin feat/gmail-email
gh pr create --base main --title "Per-tenant Gmail email (Nango google-mail; Resend fallback)" --body "<summary + test plan>"
```

- [ ] **Step 5: Final whole-branch review** — `git diff main...feat/gmail-email`: confirm (a) `getEmailSender` falls back to Resend when unconnected (no behavior change today), (b) the consumers no longer call `resendEmail.sendEmail` directly, (c) `saveGmailConnection` verifies `conn.organizationId === tenantId` (IDOR) + is admin-gated, (d) settings write preserves sibling keys, (e) no secret logged, (f) Gmail send builds valid base64url RFC822.

- [ ] **Step 6: Watch CI, squash-merge**

```bash
gh pr checks <PR#> --watch
gh pr merge <PR#> --squash --delete-branch
```

---

## Self-Review (author)

**Spec coverage:** `getEmailSender` resolver (Task 2 ✅), `makeGmailEmail` via Nango (Task 2 ✅), `tenant.settings.email.gmailConnectionId` storage + `parseEmailConfig` (Tasks 1, 4 ✅), 3 consumers resolve per-tenant (Task 3 ✅), Connect-Gmail admin-gated IDOR-checked action + UI (Task 4 ✅), env doc (Task 5 ✅), no migration (✅), Resend fallback preserves today's behavior (Tasks 2–3 ✅).

**Placeholder scan:** PR body `<…>` (Task 5) is author-filled. The Task 4 button has an implementer-note to copy the working QBO Nango-connect mechanism rather than invent one — this is guidance, not a placeholder (the action + storage are fully specified; the connect-SDK wiring is "mirror the existing file" because its exact SDK calls are best read from the live QBO button).

**Type consistency:** `EmailSender` reused throughout; `makeGmailEmail`/`getEmailSender`/`parseEmailConfig`/`EmailConfig` names match across tasks + exports; `gmailConnectionId` key name consistent (core parse, integrations resolver, agents consumers, web action). `getEmailSender` is sync (caller does the async settings load).

**Decision noted:** connection id stored in `tenant.settings.email` jsonb (RMW) rather than a dedicated column like `qboConnectionId` — avoids a migration, consistent with `scheduling`/`finance`/`esign` settings. Gmail's `from` header is cosmetic (Gmail sends as the authorized account) — acceptable for the pilot per spec.
