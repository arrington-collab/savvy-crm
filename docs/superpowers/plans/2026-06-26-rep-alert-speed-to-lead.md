# Rep Alert + 1-Minute Speed-to-Lead — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a non-call lead arrives, text the assigned rep "call now" with a tap-to-call link to the homeowner; if the rep doesn't react within 1 minute, the existing AI voice-fallback calls the homeowner.

**Architecture:** Extend the existing `lead-speed-to-lead` Inngest workflow with a best-effort rep-alert first step and shorten the first-touch SLA to 1 minute. Add a `user.phone` column and a pure `buildRepAlertSms` helper. Reuse the existing `sms` gateway, `lead/contacted` cancel, and `voice-fallback` AI-call handoff unchanged.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres + RLS), Inngest, Vitest, pnpm + Turborepo.

**Spec:** `docs/superpowers/specs/2026-06-26-rep-alert-speed-to-lead-design.md`

## Global Constraints

- **Build off the LATEST `origin/main`** (after PRs #47 and #48 merge). The `user.phone` migration must be generated against that base so it gets the correct next number (PRs #47/#48 each add a `0021…`; this one should land as the next free number — generate it, don't hand-pick).
- **Import-extension rule:** `packages/core/*` and `packages/db/src/schema/*` and `apps/web/*` use NO `.js` extension on relative imports; `packages/db/src/lifecycle/*` source files ALSO use NO `.js` (only `packages/db` **test** files use `.js`). Match the file you edit. *(A `.js` in a db source file breaks the Turbopack e2e webServer while passing `next build` — a real CI failure on this project.)*
- **Single zod instance:** within `packages/core` import `z` from `"./schemas"`.
- **Tenant isolation:** all lead/user/customer/property reads in the workflow go through `withTenant` (RLS). `user.phone` is a column on the existing tenant-scoped `user` table — no new RLS.
- **Best-effort SMS:** a rep-alert send failure must never fail the workflow (try/catch, record and continue).
- **Scope:** rep alert fires only for non-call leads (`lead.source !== "inbound-call"`).

---

## File Structure

| File | Responsibility | New/Modified |
|---|---|---|
| `packages/db/src/schema/tenancy.ts` | add `phone` column to `user` | Modify |
| `packages/db/drizzle/00NN_*.sql` | generated migration for `user.phone` | Create (generated) |
| `packages/core/src/lead-followup.ts` | `buildRepAlertSms` + first-touch SLA default 3→1 | Modify |
| `packages/core/src/lead-followup.test.ts` | tests for `buildRepAlertSms` | Modify (or create) |
| `packages/agents/src/functions/lead-speed-to-lead.ts` | rep-alert step | Modify |
| `packages/agents/src/functions/lead-speed-to-lead.test.ts` | workflow test (rep alert paths) | Modify (or create) |
| `apps/web/src/lib/team-actions.ts` (or the rep-profile action file) | save rep phone | Modify |
| the team-settings + rep-profile pages | phone input field | Modify |

---

### Task 1: Add `user.phone` column + migration

**Files:**
- Modify: `packages/db/src/schema/tenancy.ts` (the `user` table)
- Create (generated): `packages/db/drizzle/00NN_*.sql`

**Interfaces:**
- Produces: `user.phone` — `text("phone")`, nullable. Drizzle column name `phone`.

- [ ] **Step 1: Add the column to the schema**

In `packages/db/src/schema/tenancy.ts`, add to the `user` table definition (after `email`, before `role` — placement is cosmetic):

```typescript
  phone: text("phone"),
```

Confirm `text` is already imported in that file (it is — `email` uses it).

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @savvy/db db:generate`
Expected: a new `packages/db/drizzle/00NN_*.sql` containing `ALTER TABLE "user" ADD COLUMN "phone" text;` and an updated `drizzle/meta/_journal.json` + snapshot.

- [ ] **Step 3: Inspect the generated SQL**

Open the new `.sql`. Confirm it is exactly the `ADD COLUMN "phone" text;` (no unexpected drops/renames). If drizzle tries to alter unrelated things, stop and report.

- [ ] **Step 4: Apply locally + verify**

Run: `pnpm db:up && pnpm --filter @savvy/db db:migrate`
Then: `docker exec savvy_db psql -U postgres -d savvy -c "\d \"user\"" | grep phone`
Expected: `phone | text` row present.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/tenancy.ts packages/db/drizzle
git commit -m "feat(db): add user.phone column"
```

---

### Task 2: `buildRepAlertSms` helper + 1-minute first-touch SLA

**Files:**
- Modify: `packages/core/src/lead-followup.ts`
- Test: `packages/core/src/lead-followup.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `buildRepAlertSms(v: { name: string; city?: string | null; leadPhone: string }): string`
  - `SpeedToLeadConfig.firstTouchSlaMin` default is now **1** (was 3).

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/lead-followup.test.ts` (match the file's existing vitest import style — `test`/`expect` or `describe`/`it`):

```typescript
import { buildRepAlertSms, parseSpeedToLeadConfig } from "./lead-followup";

describe("buildRepAlertSms", () => {
  it("includes the first name, city, and a tel: tap-to-call link", () => {
    const body = buildRepAlertSms({ name: "Dale Homeowner", city: "Mesa", leadPhone: "+16025550142" });
    expect(body).toContain("Dale");
    expect(body).not.toContain("Homeowner"); // first name only
    expect(body).toContain("Mesa");
    expect(body).toContain("tel:+16025550142");
    expect(body).toMatch(/speed to lead/i);
  });
  it("omits the city clause when city is null", () => {
    const body = buildRepAlertSms({ name: "Dale", city: null, leadPhone: "+16025550142" });
    expect(body).not.toContain(" in ");
    expect(body).toContain("tel:+16025550142");
  });
});

describe("parseSpeedToLeadConfig", () => {
  it("defaults the first-touch SLA to 1 minute", () => {
    expect(parseSpeedToLeadConfig(undefined).firstTouchSlaMin).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/core test src/lead-followup.test.ts`
Expected: FAIL — `buildRepAlertSms` not exported; SLA default still 3.

- [ ] **Step 3: Implement the helper + change the default**

In `packages/core/src/lead-followup.ts`, change the first-touch default from `3` to `1`:

```typescript
  firstTouchSlaMin: z.number().positive().default(1),
```

(Leave `escalateMin` at `10`.) Then add the helper (place it near the other exported helpers in the file):

```typescript
/** SMS to the assigned rep on a fresh non-call lead. `leadPhone` becomes a tap-to-call
 *  link to the homeowner. First name only; city clause only when known. One segment. */
export function buildRepAlertSms(v: { name: string; city?: string | null; leadPhone: string }): string {
  const first = v.name.trim().split(/\s+/)[0] || "a new lead";
  const where = v.city ? ` in ${v.city}` : "";
  return `New lead: ${first}${where} — call now, speed to lead matters. Tap to call: tel:${v.leadPhone}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @savvy/core test src/lead-followup.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @savvy/core typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/lead-followup.ts packages/core/src/lead-followup.test.ts
git commit -m "feat(core): buildRepAlertSms + 1-minute first-touch SLA default"
```

---

### Task 3: Rep-alert step in `lead-speed-to-lead`

**Files:**
- Modify: `packages/agents/src/functions/lead-speed-to-lead.ts`
- Test: `packages/agents/src/functions/lead-speed-to-lead.test.ts`

**Interfaces:**
- Consumes: `buildRepAlertSms` (Task 2), `user.phone` (Task 1), the `sms` gateway + `smsFrom` from `@savvy/integrations`.
- Produces: the workflow now sends a rep-alert SMS as its first step for non-call leads with an assigned rep that has a phone, before the (now 1-minute) first-touch wait.

- [ ] **Step 1: Write the failing test**

Add to `packages/agents/src/functions/lead-speed-to-lead.test.ts`. The rep-alert logic is extracted into a pure, injectable helper `runRepAlert` (so it's testable without booting Inngest — mirror how other agents tests test extracted helpers). Test it directly:

```typescript
import { describe, it, expect, vi } from "vitest";
import { runRepAlert } from "./lead-speed-to-lead";

const sender = () => {
  const calls: { to: string; body: string }[] = [];
  return { sendSms: vi.fn(async (m: { to: string; from: string; body: string }) => { calls.push({ to: m.to, body: m.body }); return { sid: "x" }; }), calls };
};

describe("runRepAlert", () => {
  it("texts the rep with a tel: link for a non-call lead with a rep phone", async () => {
    const s = sender();
    const r = await runRepAlert(
      { source: "web", ownerPhone: "+16025550001", customerName: "Dale Homeowner", customerPhone: "+16025550142", city: "Mesa" },
      s as never,
    );
    expect(r).toBe("sent");
    expect(s.sendSms).toHaveBeenCalledTimes(1);
    expect(s.calls[0]!.to).toBe("+16025550001");
    expect(s.calls[0]!.body).toContain("tel:+16025550142");
    expect(s.calls[0]!.body).toContain("Dale");
  });
  it("skips inbound-call leads", async () => {
    const s = sender();
    const r = await runRepAlert({ source: "inbound-call", ownerPhone: "+16025550001", customerName: "Dale", customerPhone: "+16025550142", city: null }, s as never);
    expect(r).toBe("skip-inbound");
    expect(s.sendSms).not.toHaveBeenCalled();
  });
  it("skips when the rep has no phone", async () => {
    const s = sender();
    const r = await runRepAlert({ source: "web", ownerPhone: null, customerName: "Dale", customerPhone: "+16025550142", city: null }, s as never);
    expect(r).toBe("skip-no-rep-phone");
    expect(s.sendSms).not.toHaveBeenCalled();
  });
  it("skips when there is no customer phone to dial", async () => {
    const s = sender();
    const r = await runRepAlert({ source: "web", ownerPhone: "+16025550001", customerName: "Dale", customerPhone: null, city: null }, s as never);
    expect(r).toBe("skip-no-lead-phone");
    expect(s.sendSms).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @savvy/agents test src/functions/lead-speed-to-lead.test.ts`
Expected: FAIL — `runRepAlert` not exported.

- [ ] **Step 3: Implement `runRepAlert` + wire it as the workflow's first step**

In `packages/agents/src/functions/lead-speed-to-lead.ts`:

Add imports (note: `customer`, `property`, `user` from `@savvy/db`; `buildRepAlertSms` from `@savvy/core`; `sms`, `smsFrom`, `SmsSender` from `@savvy/integrations`):

```typescript
import { adminDb, withTenant, lead, tenant, customer, property, user, eq, getAssignmentCandidates, setLeadOwner, recordAgentRun } from "@savvy/db";
import { parseSpeedToLeadConfig, pickReassignee, buildRepAlertSms } from "@savvy/core";
import { sms, smsFrom, type SmsSender } from "@savvy/integrations";
import { inngest } from "../client";
```

Add the pure, injectable helper (exported for the test) ABOVE `leadSpeedToLead`:

```typescript
export type RepAlertCtx = {
  source: string | null;
  ownerPhone: string | null;
  customerName: string | null;
  customerPhone: string | null;
  city: string | null;
};

/** Best-effort: text the assigned rep a tap-to-call alert. Returns a reason string.
 *  Pure except for the injected SMS sender (defaults to the real gateway). */
export async function runRepAlert(ctx: RepAlertCtx, sender: SmsSender = sms): Promise<string> {
  if (ctx.source === "inbound-call") return "skip-inbound";
  if (!ctx.ownerPhone) return "skip-no-rep-phone";
  if (!ctx.customerPhone) return "skip-no-lead-phone";
  const body = buildRepAlertSms({ name: ctx.customerName ?? "a new lead", city: ctx.city, leadPhone: ctx.customerPhone });
  try {
    await sender.sendSms({ to: ctx.ownerPhone, from: smsFrom(), body });
    return "sent";
  } catch {
    return "send-failed";
  }
}
```

Add a new FIRST step inside the function body, immediately after `const cfg = await step.run("load-sla", ...)` and BEFORE `await step.sleep("first-touch-sla", ...)`:

```typescript
    await step.run("alert-rep", async () => {
      const ctx = await withTenant(tenantId, async (tx) => {
        const [row] = await tx
          .select({
            source: lead.source,
            ownerPhone: user.phone,
            customerName: customer.name,
            customerPhone: customer.phone,
            city: property.city,
          })
          .from(lead)
          .leftJoin(user, eq(lead.assignedUserId, user.id))
          .leftJoin(customer, eq(lead.customerId, customer.id))
          .leftJoin(property, eq(lead.propertyId, property.id))
          .where(eq(lead.id, leadId));
        return row ?? null;
      });
      const reason = ctx ? await runRepAlert(ctx) : "no-lead";
      await recordAgentRun({ tenantId, agent: "comms", taskKey: "lead.rep.alert", status: reason === "sent" ? "ok" : "skipped", error: reason === "sent" ? null : reason });
      return { reason };
    });
```

The rest of the function (the now-1-minute `first-touch-sla` sleep, overdue emit, escalate, reassign) is unchanged — the 1-minute timing comes from Task 2's default.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @savvy/agents test src/functions/lead-speed-to-lead.test.ts`
Expected: PASS (4 `runRepAlert` cases).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @savvy/agents typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/functions/lead-speed-to-lead.ts packages/agents/src/functions/lead-speed-to-lead.test.ts
git commit -m "feat(agents): rep-alert SMS step before the 1-minute speed-to-lead escalation"
```

---

### Task 4: Rep-phone UI (self-service profile + admin team settings)

**Files:**
- Modify: the rep-profile settings page + its server action, and the admin team-settings member form + its server action.

**Interfaces:**
- Consumes: `user.phone` (Task 1), `normalizePhone` from `@savvy/core`.
- Produces: reps/admins can save a phone number to `user.phone`.

- [ ] **Step 1: Locate the existing patterns**

Find the rep-profile settings page and the admin team-settings page + their server actions:

Run: `git grep -l "team" apps/web/src/app/\(app\)/settings && git grep -rln "saveProfile\|updateUser\|team-actions\|isOrgAdmin" apps/web/src/lib`
Read the team-settings member form + its server action to mirror the exact form/action pattern (field rendering, `useActionState`/form, zod validation, `isOrgAdmin()` gate).

- [ ] **Step 2: Add `phone` to the user-update server action(s)**

In the relevant server action (e.g. `apps/web/src/lib/team-actions.ts`), accept `phone`, normalize it, and persist. Use the existing tenant-scoped update pattern in that file (do NOT introduce a new db helper if one exists). Concretely, the zod + normalize:

```typescript
import { normalizePhone } from "@savvy/core";
// in the action's schema:
phone: z.string().optional(),
// before the update:
const phone = parsed.phone ? normalizePhone(parsed.phone) : null;
// include `phone` in the `.set({ ... })` of the existing user update (admin path must keep its isOrgAdmin() gate)
```

- [ ] **Step 3: Add the phone input to both forms**

Add a `<label>Phone</label><input name="phone" type="tel" defaultValue={user.phone ?? ""} />` (matching the existing fields' markup/styling in each form). Rep self-service form updates the current user; admin team form updates the selected member (admin-gated).

- [ ] **Step 4: Typecheck + lint + manual check**

Run: `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint`
Expected: clean. Then load `/settings` locally, set a phone, confirm it persists (`docker exec savvy_db psql -U postgres -d savvy -c "select name, phone from \"user\" where phone is not null;"`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): rep phone number field in profile + team settings"
```

---

## Final verification

- [ ] **Run the full suite + typecheck + lint**

```bash
pnpm db:up && pnpm --filter @savvy/db db:migrate
pnpm test
pnpm typecheck
pnpm lint
```
Expected: all green.

- [ ] **Boot the app (Turbopack e2e parity)**

```bash
cd apps/web && ./node_modules/.bin/next dev -p 3007
```
Hit `/settings` — confirm no module-not-found (guards the `.js`-import CI failure class).

---

## Self-Review (completed by plan author)

- **Spec coverage:** rep-alert step → Task 3; 1-min SLA → Task 2; `user.phone` → Task 1; rep-phone UI → Task 4; SMS builder + tel: link → Task 2/3; non-call gating + no-phone/no-rep/no-lead-phone paths → `runRepAlert` (Task 3 tests); homeowner SMS unchanged (untouched intake); AI-call handoff unchanged (existing `voice-fallback`, not in scope). Quiet-hours: rep alert sends anytime (per spec §3), AI call already guarded — no task needed.
- **Placeholder scan:** none. Task 4 references existing patterns by path + provides the concrete zod/normalize/field, which is the correct way to extend established UI rather than reprinting a whole page.
- **Type consistency:** `RepAlertCtx` fields (`source/ownerPhone/customerName/customerPhone/city`) match the workflow query select and the `runRepAlert` tests; `buildRepAlertSms({name, city?, leadPhone})` signature matches its callers in Task 2 test and Task 3.
