# Email on Leads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture and display a customer email on leads, requiring phone **or** email (phone becomes optional), across the in-app New Lead form and the public `/api/leads` endpoint.

**Architecture:** One shared schema change drives every surface. `leadIntakeSchema` (`@savvy/core`) gets an optional, validated `email`, makes `phone` optional, and an object-level refinement requiring phone-or-email. The un-refined object and the refinement are exported separately so the `/api/leads` route can still `.extend()` it. `createLeadForTenant` writes `customer.email`; the lead-detail Contact card renders a `mailto:` link; the lead-intake Inngest workflow skips the welcome SMS when there's no phone. No DB migration — `customer.email` already exists.

**Tech Stack:** TypeScript, Zod v3, Drizzle ORM, Next.js (App Router) server actions, Inngest, Vitest (unit), Playwright (e2e), pnpm + Turborepo.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `packages/core/src/schemas.ts` | modify | Optional `phone` + `email`, refinement, export `leadIntakeObject` / `hasContactMethod` / `contactMethodIssue` |
| `packages/core/src/schemas.test.ts` | modify | Unit cases: phone-only, email-only, neither, bad email, lowercase/trim, blank-omitted, object is extendable |
| `apps/web/src/app/api/leads/route.ts` | modify | Rebuild `bodySchema` from `leadIntakeObject.extend(...).refine(...)` (ZodEffects has no `.extend`) |
| `apps/web/src/lib/intake.ts` | modify | Insert `customer.email` + null-safe `phone` |
| `apps/web/src/app/(app)/leads/new/NewLeadForm.tsx` | modify | Email input, phone no longer hard-required, client phone-or-email guard |
| `apps/web/src/lib/leads-queries.ts` | modify | `email` in `getLeadDetail` select + `LeadDetail` type |
| `apps/web/src/app/(app)/leads/[id]/page.tsx` | modify | Render email as `mailto:` link in Contact card |
| `packages/agents/src/functions/lead-intake.ts` | modify | Skip `send-sms` step when `ctx.phone` is empty |
| `apps/web/tests/e2e/leads.spec.ts` | modify | E2E: create email-only lead → detail shows `mailto:` |

**Local gates** (run from repo root `~/Sites/savvy-mapfeature`):
- `pnpm --filter @savvy/core test` — pure unit tests, reliable locally
- `pnpm --filter @savvy/core typecheck` and `pnpm typecheck` — catches the `.extend` ripple
- `pnpm lint`
- DB/e2e integration is gated by **CI** (local Postgres is unreliable in this env).

---

### Task 1: Schema — optional phone + email + refinement (core)

**Files:**
- Modify: `packages/core/src/schemas.ts`
- Test: `packages/core/src/schemas.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the body of `packages/core/src/schemas.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { leadIntakeSchema, leadIntakeObject } from "./schemas";

describe("leadIntakeSchema", () => {
  const base = { name: "Jane", address: "1 Main St, Mesa AZ" };
  const withPhone = { ...base, phone: "(480) 555-1234" };

  it("normalizes phone to E.164 on parse", () => {
    const r = leadIntakeSchema.parse(withPhone);
    expect(r.phone).toBe("+14805551234");
  });
  it("rejects an unparseable phone", () => {
    expect(leadIntakeSchema.safeParse({ ...withPhone, phone: "555" }).success).toBe(false);
  });
  it("defaults source to web and leaves optional fields undefined", () => {
    const r = leadIntakeSchema.parse(withPhone);
    expect(r.source).toBe("web");
    expect(r.city).toBeUndefined();
    expect(r.roofType).toBeUndefined();
  });
  it("accepts the structured optional fields", () => {
    const r = leadIntakeSchema.parse({
      ...withPhone, city: "Mesa", state: "AZ", zip: "85201", county: "Maricopa",
      lat: 33.4, lng: -111.8, roofType: "tile", yearBuilt: 2004,
    });
    expect(r.state).toBe("AZ");
    expect(r.roofType).toBe("tile");
    expect(r.yearBuilt).toBe(2004);
  });
  it("rejects an out-of-range yearBuilt", () => {
    expect(leadIntakeSchema.safeParse({ ...withPhone, yearBuilt: 1500 }).success).toBe(false);
  });

  // --- email-on-leads ---
  it("accepts a phone-only lead", () => {
    expect(leadIntakeSchema.safeParse(withPhone).success).toBe(true);
  });
  it("accepts an email-only lead (no phone)", () => {
    const r = leadIntakeSchema.parse({ ...base, email: "jane@example.com" });
    expect(r.email).toBe("jane@example.com");
    expect(r.phone).toBeUndefined();
  });
  it("rejects a lead with neither phone nor email", () => {
    const res = leadIntakeSchema.safeParse(base);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues[0]?.message).toBe("Add a phone or email");
  });
  it("rejects a malformed email", () => {
    expect(leadIntakeSchema.safeParse({ ...base, email: "not-an-email" }).success).toBe(false);
  });
  it("lowercases and trims the email", () => {
    const r = leadIntakeSchema.parse({ ...base, email: "  Jane@Example.COM  " });
    expect(r.email).toBe("jane@example.com");
  });
  it("treats a blank email as omitted (not a validation error) when phone is present", () => {
    const r = leadIntakeSchema.parse({ ...withPhone, email: "   " });
    expect(r.email).toBeUndefined();
  });
  it("exposes an extendable object schema (for /api/leads composition)", () => {
    const extended = leadIntakeObject.extend({ key: z.string() } as never);
    expect(typeof (leadIntakeObject as { extend?: unknown }).extend).toBe("function");
    expect(extended).toBeTruthy();
  });
});

import { z } from "./schemas";
```

> Note: the final `import { z } from "./schemas"` line is needed for the `z.string()` reference in the last test; keep it at the bottom (ESM hoists imports, so position is cosmetic).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @savvy/core test`
Expected: FAIL — `leadIntakeObject` is not exported; email-only / neither / lowercase cases fail.

- [ ] **Step 3: Implement the schema change**

Replace the entire contents of `packages/core/src/schemas.ts` with:

```ts
import { z } from "zod";
import { normalizePhone } from "./phone";

// Re-export zod so cross-package consumers (the Next.js app) use THIS package's
// single zod instance — extending leadIntakeSchema with the app's own zod would
// produce a duplicate-instance type mismatch (same pattern as @savvy/db operators).
export { z };

// phone: optional now (was required). Normalizes to E.164 when present; blank -> undefined.
const phoneOptional = z
  .string()
  .trim()
  .optional()
  .transform((v, ctx) => {
    if (!v) return undefined;
    const n = normalizePhone(v);
    if (!n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid phone number" });
      return z.NEVER;
    }
    return n;
  });

// email: optional, trimmed + lowercased, format-validated; blank -> undefined.
// preprocess normalizes first so an empty string isn't treated as an invalid email.
const emailOptional = z.preprocess(
  (v) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : undefined),
  z.string().email("Enter a valid email").optional(),
);

const roofType = z.enum(["asphalt_shingle", "tile", "metal", "flat_foam", "other"]);

// The plain object (no refinement). A refined schema is a ZodEffects and loses
// `.extend()`, which /api/leads needs to add its `key`. Export the object so
// consumers can extend it, then re-apply the refinement themselves.
export const leadIntakeObject = z.object({
  name: z.string().min(1).max(120),
  phone: phoneOptional,
  email: emailOptional,
  address: z.string().min(3).max(240),
  source: z.string().min(1).max(60).default("web"),
  // optional structured address (Google Places) + optional roof/year
  city: z.string().max(120).optional(),
  state: z.string().max(40).optional(),
  zip: z.string().max(12).optional(),
  county: z.string().max(120).optional(),
  line1: z.string().max(200).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  roofType: roofType.optional(),
  yearBuilt: z.number().int().min(1850).max(new Date().getFullYear()).optional(),
});

// Require at least one contact method. Exported so consumers that .extend()
// leadIntakeObject (e.g. /api/leads) can re-apply the same rule.
export const hasContactMethod = (d: { phone?: string; email?: string }): boolean =>
  Boolean(d.phone || d.email);

export const contactMethodIssue: { message: string; path: (string | number)[] } = {
  message: "Add a phone or email",
  path: ["phone"],
};

export const leadIntakeSchema = leadIntakeObject.refine(hasContactMethod, contactMethodIssue);
export type LeadIntakeInput = z.infer<typeof leadIntakeSchema>;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @savvy/core test`
Expected: PASS (all `leadIntakeSchema` cases green).

- [ ] **Step 5: Verify the new exports flow through the package barrel**

Run: `grep -n "schemas" packages/core/src/index.ts`
Expected: a re-export line (e.g. `export * from "./schemas";`). If it instead names individual symbols, add `leadIntakeObject`, `hasContactMethod`, `contactMethodIssue` to the export list. Then:
Run: `pnpm --filter @savvy/core typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/schemas.ts packages/core/src/schemas.test.ts packages/core/src/index.ts
git commit -m "feat(core): optional phone+email on leadIntakeSchema with phone-or-email refinement"
```

---

### Task 2: Fix the `/api/leads` route to compose from the un-refined object

**Files:**
- Modify: `apps/web/src/app/api/leads/route.ts`

- [ ] **Step 1: Confirm the break exists**

Run: `pnpm --filter @savvy/web typecheck` (or `pnpm typecheck`)
Expected: FAIL — `Property 'extend' does not exist on type 'ZodEffects<...>'` at `route.ts` (because `leadIntakeSchema` is now refined). This confirms the ripple; we fix it next.

- [ ] **Step 2: Update the route to extend the object then refine**

In `apps/web/src/app/api/leads/route.ts`, change the import line:

```ts
import { leadIntakeObject, hasContactMethod, contactMethodIssue, z } from "@savvy/core";
```

and replace the `bodySchema` definition:

```ts
const bodySchema = leadIntakeObject
  .extend({ key: z.string().min(1) })
  .refine(hasContactMethod, contactMethodIssue);
```

Leave the rest of the handler unchanged (`const { key, ...input } = parsed.data;` still works — `input` now carries optional `phone`/`email`).

- [ ] **Step 3: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: PASS (no `.extend` error).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/api/leads/route.ts
git commit -m "fix(api): rebuild /api/leads bodySchema from leadIntakeObject (refined schema has no .extend)"
```

---

### Task 3: Persist email in `createLeadForTenant`

**Files:**
- Modify: `apps/web/src/lib/intake.ts:21`

- [ ] **Step 1: Update the customer insert**

In `createLeadForTenant`, change the customer insert line (currently `phone: input.phone` only) to:

```ts
    const [c] = await tx
      .insert(customer)
      .values({ tenantId, name: input.name, phone: input.phone ?? null, email: input.email ?? null })
      .returning();
```

(`phone` is now optional → coalesce to `null`; add `email`.)

- [ ] **Step 2: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: PASS. If it fails on `email` not existing on the customer insert type, stop — the spec assumes `customer.email` already exists; confirm with `grep -n "email" packages/db/src/schema/*.ts`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/intake.ts
git commit -m "feat(intake): persist customer.email when creating a lead"
```

---

### Task 4: New Lead form — email input + phone-or-email guard

**Files:**
- Modify: `apps/web/src/app/(app)/leads/new/NewLeadForm.tsx`

- [ ] **Step 1: Add email + form-error state**

After the `phone` state line (`const [phone, setPhone] = useState("");`) add:

```ts
  const [email, setEmail] = useState("");
  const [formError, setFormError] = useState("");
```

- [ ] **Step 2: Add the client-side guard + email to the payload**

Replace the `submit` function body's `start(async () => {` block's first lines so the guard runs before the action call:

```ts
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!phone.trim() && !email.trim()) {
      setFormError("Add a phone or email");
      return;
    }
    setFormError("");
    start(async () => {
      const res = await createLead({
        name, phone, email, address, source,
        line1: parts.line1, city: parts.city, state: parts.state, zip: parts.zip,
        county: parts.county, lat: parts.lat, lng: parts.lng,
        roofType: roofType || undefined,
        yearBuilt: yearBuilt ? Number(yearBuilt) : undefined,
      });
      if ("error" in res) { toast.error(res.error); return; }
      toast.success("Lead created");
      router.push(`/leads/${res.leadId}`);
    });
  }
```

- [ ] **Step 3: Drop hard-required on phone, add the Email input + error text**

Replace the Phone field block:

```tsx
        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone</Label>
          <Input id="phone" name="phone" value={phone} onChange={(e) => onPhoneChange(e.target.value)}
                 placeholder="(480) 555-1234" required />
        </div>
```

with (note: no `required`, and a new Email field + inline error):

```tsx
        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone</Label>
          <Input id="phone" name="phone" value={phone} onChange={(e) => onPhoneChange(e.target.value)}
                 placeholder="(480) 555-1234" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" value={email}
                 onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
        </div>
        {formError && (
          <p className="text-sm text-destructive" data-testid="new-lead-error">{formError}</p>
        )}
```

- [ ] **Step 4: Verify typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(app)/leads/new/NewLeadForm.tsx"
git commit -m "feat(leads): add Email field + phone-or-email guard to New Lead form"
```

---

### Task 5: Surface email in `getLeadDetail`

**Files:**
- Modify: `apps/web/src/lib/leads-queries.ts`

- [ ] **Step 1: Add `email` to the `LeadDetail` type**

In the `LeadDetail` type, add after `phone: string | null;`:

```ts
  email: string | null;
```

- [ ] **Step 2: Add `email` to the select**

In `getLeadDetail`'s `.select({ ... })`, add after `phone: customer.phone,`:

```ts
        email: customer.email,
```

- [ ] **Step 3: Add `email` to the returned object**

In the `return { ... }` of `getLeadDetail`, add after `phone: row.phone,`:

```ts
      email: row.email,
```

- [ ] **Step 4: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/leads-queries.ts
git commit -m "feat(leads): include customer email in getLeadDetail"
```

---

### Task 6: Render email as a `mailto:` link on the Contact card

**Files:**
- Modify: `apps/web/src/app/(app)/leads/[id]/page.tsx`

- [ ] **Step 1: Add the mailto line below the phone line**

In the Contact `<Card>`, find the phone line:

```tsx
          <p className="mono mt-1 text-xs" style={{ color: "var(--text-muted)" }} data-testid="lead-phone">{detail.phone ?? "no phone"}</p>
```

Add directly **after** it:

```tsx
          {detail.email && (
            <p className="mono mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
              <a href={`mailto:${detail.email}`} data-testid="lead-email" className="underline underline-offset-2">
                {detail.email}
              </a>
            </p>
          )}
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(app)/leads/[id]/page.tsx"
git commit -m "feat(leads): show customer email as a mailto link on the Contact card"
```

---

### Task 7: Skip welcome SMS for email-only leads (Inngest ripple)

**Files:**
- Modify: `packages/agents/src/functions/lead-intake.ts:239`

- [ ] **Step 1: Guard the `send-sms` step**

In `leadIntake`, change the start of the `send-sms` step. Current first line:

```ts
    await step.run("send-sms", async () => {
      const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
```

Insert the guard as the very first line inside the callback:

```ts
    await step.run("send-sms", async () => {
      // Email-only leads have no phone — skip the welcome SMS (no send, no comm row).
      if (!ctx.phone) return { skipped: "no-phone" };
      const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
```

(`ctx.phone` is `c!.phone ?? ""` from the `load-lead` step, so an email-only lead yields `""` → falsy → skip. Scoring/enrichment/assignment steps still run.)

- [ ] **Step 2: Verify typecheck + agents tests**

Run: `pnpm --filter @savvy/agents typecheck && pnpm --filter @savvy/agents test`
Expected: PASS (existing SMS tests use a phone, so the guard doesn't trip them). If there is no `test` script on `@savvy/agents`, run `pnpm typecheck` instead and note it.

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/functions/lead-intake.ts
git commit -m "feat(agents): skip welcome SMS for email-only leads in lead-intake"
```

---

### Task 8: E2E — create an email-only lead and see the mailto link

**Files:**
- Modify: `apps/web/tests/e2e/leads.spec.ts`

- [ ] **Step 1: Add the email-only e2e test**

Append this test to the end of `apps/web/tests/e2e/leads.spec.ts`:

```ts
test("leads: create an email-only lead (no phone) shows a mailto link", async ({ page }) => {
  await page.goto("/leads/new");
  await page.fill('input[name="name"]', "Emailing Ed");
  await page.fill('input[name="email"]', "ed@example.com");
  await page.fill('input[name="address"]', "9 Email Way, Mesa AZ");
  await page.getByTestId("new-lead-submit").click();
  await page.waitForURL(/\/leads\/[0-9a-f-]+$/);
  await expect(page.getByTestId("lead-detail")).toBeVisible();

  const link = page.getByTestId("lead-email");
  await expect(link).toHaveText("ed@example.com");
  await expect(link).toHaveAttribute("href", "mailto:ed@example.com");
  // Phone-only is still valid: the existing "create via form + assign owner" test covers it.
});
```

- [ ] **Step 2: Run the e2e locally if the harness is available, else rely on CI**

Run (best-effort): `pnpm --filter @savvy/web exec playwright test tests/e2e/leads.spec.ts`
Expected: PASS. If local Postgres/Clerk/dev-server aren't available in this env, **skip** and let CI run it (note this in the task report). Do not block on a local DB failure.

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/e2e/leads.spec.ts
git commit -m "test(e2e): email-only lead creation renders a mailto link"
```

---

### Task 9: Full gate, push, PR, CI

**Files:** none (verification + integration)

- [ ] **Step 1: Run the full local gate**

```bash
pnpm --filter @savvy/core test
pnpm typecheck
pnpm lint
```
Expected: all PASS. Fix any failure before continuing.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feat/lead-email
```

- [ ] **Step 3: Open the PR against main**

```bash
gh pr create --base main --title "Email on leads (phone-or-email)" --body "$(cat <<'EOF'
## Summary
- Capture + display a customer **email** on leads; require **phone OR email** (phone now optional).
- Shared `leadIntakeSchema` drives the in-app New Lead form AND the public `/api/leads` endpoint.
- `createLeadForTenant` writes `customer.email`; lead-detail Contact card renders a `mailto:` link.
- Ripple fixes: `/api/leads` rebuilt from the un-refined `leadIntakeObject` (a refined schema has no `.extend()`); lead-intake Inngest workflow skips the welcome SMS for email-only leads.
- No migration — `customer.email` already exists.

## Tests
- `@savvy/core` unit: phone-only, email-only, neither (rejected), bad email, lowercase/trim, blank-omitted, object-extendable.
- E2E: create an email-only lead → detail shows a `mailto:` link.

## Out of scope
No consent checkbox, no leads-list email column, no drip/campaign wiring, no backfill.
EOF
)"
```

- [ ] **Step 4: Watch CI**

```bash
gh pr checks --watch
```
Expected: all checks green. If red, **fix-forward** (new commit on `feat/lead-email`), push, re-watch. Do not merge.

- [ ] **Step 5: Report back**

Summarize the PR number, CI status, and the spec ripple that was caught (`.extend` on a refined schema). **Do not merge until Brett says so.**

---

## Self-Review

**Spec coverage:**
- Schema (email optional, phone optional, phone-or-email refine) → Task 1. ✅
- `leadIntakeSchema` feeds in-app form + `/api/leads` → Tasks 1, 2, 4. ✅ (Plan corrects the spec's "no change to `/api/leads`" — the `.extend` break is handled in Task 2.)
- `createLeadForTenant` writes email → Task 3. ✅
- Lead detail Contact card mailto + `getLeadDetail` select/type → Tasks 5, 6. ✅
- Inngest `send-sms` skip when no phone → Task 7. ✅
- Tests: schema unit (phone-only/email-only/neither/bad/lowercase/blank) + 1 e2e email-only → Tasks 1, 8. ✅
- Out of scope items (consent, list column, drip, backfill) → not implemented, noted in PR body. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✅

**Type consistency:** `leadIntakeObject`, `hasContactMethod`, `contactMethodIssue` defined in Task 1 are the exact symbols imported in Task 2. `LeadDetail.email` (Task 5) matches the `detail.email` reference (Task 6). `email` in the form payload (Task 4) matches the schema field (Task 1) and the `createLeadForTenant` insert (Task 3). ✅
