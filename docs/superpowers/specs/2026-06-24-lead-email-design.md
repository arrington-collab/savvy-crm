# Email on leads — design

**Date:** 2026-06-24
**Status:** Approved (design)

## Goal

Capture and display a customer **email** on leads, so leads created in-app or via the public `/api/leads` endpoint can carry an email for future email outreach (drip/campaigns). Require **at least one** contact method — phone **or** email — instead of always requiring phone.

## Context

- The `customer` table **already has** `email text` and `email_opt_out boolean default false` columns — no migration needed.
- `leadIntakeSchema` (`@savvy/core/schemas.ts`) currently requires `phone` and has no `email`. It feeds **both** the in-app `NewLeadForm` and the public `/api/leads` route.
- `createLeadForTenant` inserts `customer { name, phone }` only.
- The lead detail Contact card shows phone but not email.
- The lead-intake Inngest workflow sends a welcome SMS using the customer's phone.

## Approach

A single shared-schema change drives every surface. Make `email` an optional, validated field; make `phone` optional; add an object-level refinement requiring phone-or-email.

Rejected alternatives:
- **Email required**: blocks door-knock/canvassing leads that only have a phone.
- **In-app form only**: website/embed leads (via `/api/leads`) would still miss email — defeats the "important for the future" intent.

## Components

### 1. Schema — `packages/core/src/schemas.ts`

```ts
// phone: optional now (was required). Normalizes to E.164 when present; empty -> undefined.
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

// email: optional, trimmed + lowercased, format-validated; empty/blank -> undefined.
// preprocess normalizes first so an empty string isn't treated as an invalid email.
const emailOptional = z.preprocess(
  (v) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : undefined),
  z.string().email("Enter a valid email").optional(),
);

export const leadIntakeSchema = z
  .object({
    name: z.string().min(1).max(120),
    phone: phoneOptional,
    email: emailOptional,
    address: z.string().min(3).max(240),
    source: z.string().min(1).max(60).default("web"),
    // …existing optional structured-address + roof/year fields unchanged…
  })
  .refine((d) => Boolean(d.phone || d.email), {
    message: "Add a phone or email",
    path: ["phone"],
  });
```

Notes:
- The existing required `phone` field (a `z.string().transform`) is replaced by `phoneOptional`. All other fields are unchanged.
- `email` max length is bounded by `.email()` (RFC) — no extra `.max()` needed, but keep ≤254 implicitly.
- `LeadIntakeInput` type now has `phone?: string` and `email?: string`.

### 2. New Lead form — `apps/web/src/app/(app)/leads/new/NewLeadForm.tsx`

- Add an **Email** `<Input type="email">` below Phone, with `email`/`setEmail` state.
- Remove the hard `required` attribute on Phone.
- Client-side guard before submit: require `name` + `address` + (`phone` || `email`); if neither contact method, show an inline error ("Add a phone or email") and don't submit. (Server re-validates via the schema refinement — client check is UX only.)
- Include `email` in the submitted payload (empty string omitted by the schema).

### 3. Intake — `apps/web/src/lib/intake.ts`

In `createLeadForTenant`, set email on the customer insert:

```ts
const [c] = await tx
  .insert(customer)
  .values({ tenantId, name: input.name, phone: input.phone ?? null, email: input.email ?? null })
  .returning();
```

`/api/leads` needs no change — it already parses `leadIntakeSchema` (now including email + phone-or-email).

### 4. Display — lead detail Contact card (`apps/web/src/app/(app)/leads/[id]/page.tsx` + `getLeadDetail`)

- Add `email: customer.email` to the `getLeadDetail` select + `LeadDetail` type.
- In the Contact card, render the email as a `mailto:` link below the phone when present:
  `{detail.email && <a href={`mailto:${detail.email}`} …>{detail.email}</a>}`

### 5. Ripple — welcome SMS skip for email-only leads — `packages/agents/src/functions/lead-intake.ts`

The `send-sms` step uses `ctx.phone`. With phone now optional, guard it: **if there is no phone, skip the SMS step entirely** (no send, no communication row, no error). The `load-lead` step already returns `phone` (now possibly `""`/null) — branch on it:

```ts
await step.run("send-sms", async () => {
  if (!ctx.phone) return { skipped: "no-phone" };
  // …existing send + communication insert…
});
```

This keeps the workflow green for email-only leads (scoring/enrichment/assignment still run).

## Data flow

Lead created (in-app form or `/api/leads`) → `leadIntakeSchema` validates (phone-or-email) → `createLeadForTenant` writes `customer.email` → lead detail shows the email (mailto) → the email is now available to the existing drip/Gmail/Resend infra for future campaigns (not wired here).

## Error handling

- Neither phone nor email → schema refinement fails with "Add a phone or email" (client guard mirrors this for UX).
- Malformed email → "Enter a valid email".
- Email-only lead → welcome SMS skipped, rest of the pipeline runs normally.

## Testing

- **Unit (vitest, `packages/core/src/schemas.test.ts`)**: phone-only parses; email-only parses; neither → fails; bad email → fails; email is lowercased/trimmed; empty email string → omitted (not a validation error).
- **e2e (Playwright)**: create a lead with an email and **no** phone → succeeds, lands on the detail page, and the email renders as a `mailto:` link. (Existing phone-based lead e2e stays green since phone-only is still valid.)

## Out of scope (YAGNI)

No consent checkbox at capture (`email_opt_out` + the existing unsubscribe infra cover opt-outs); email not added to the leads list (detail only); no drip/campaign wiring (the future feature this enables); no backfill of email onto existing phone-only leads.
