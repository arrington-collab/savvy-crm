# Leads Slice 3 — Source Taxonomy + Referral Fees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace free-text `lead.source` with a structured enum + `source_detail` jsonb, and pay a referrer via a `referral_payment` money event when a referred lead's job collects its first payment.

**Architecture:** Pure taxonomy + config helpers land in `@savvy/core` first (zero-DB unit tests). One migration (0072) adds `lead.source_detail`, the `referral_payment` table, and a legacy data-mapping UPDATE. The referral payable reuses the `commission` idempotency pattern (`unique(tenant,job)` = first-payment + once-per-job guard) fired from an `invoice/paid` Inngest function. Manual lead creation requires a structured source; machine paths set a machine source programmatically.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres + RLS), Inngest, Next.js server actions, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-09-leads-slice3-source-taxonomy-referral-fees-design.md`

## Global Constraints

- **Migration is 0072** — pin at implementation. This branch is off `origin/main` (0069); **rebase onto `main` after Slice 2 / PR #172 (migrations 0070–0071) merges**, THEN `pnpm db:generate` (journal at 0071 → yields 0072). Never generate against 0069.
- **Test command is root `pnpm test <pattern>`** (vitest run). Packages have NO per-package `test` script. Typecheck: `pnpm --filter <pkg> typecheck`. DB runs in docker (`pnpm db:up`; shared across worktrees — never `pnpm db:reset`).
- **`lead.source` stays `text`** (app-enforced against `LEAD_SOURCE_VALUES`) — NO pgEnum.
- **`LEAD_SOURCE_VALUES`** = `["referral","insurance_agent","ads","realtor","partner","other","web","inbound_call","canvass","direct_mail"]`. **Machine sources** = `["web","inbound_call","canvass","direct_mail"]` (exempt from the required-source rule and the evidence check).
- **`AD_PLATFORM_VALUES`** = `["google_lsa","google_ads","meta","nextdoor","other"]`.
- **Referral payable idempotency:** `referral_payment` `unique(tenant_id, job_id)` + `onConflictDoNothing` → exactly once per job (on the first paid invoice).
- **Tenant isolation** on every table + query (`tenant_id` + `tenantIsolation()`; queries in `withTenant`). Grants auto-inherit.
- **First payment** = the job's first `invoice/paid` event (no partial-payment tracking).
- Machine paths keep setting sources programmatically; `canvass.ts` currently `.omit({source})`.
- TDD red-first; commit each task; DB test imports use `.js` suffix (`import { adminDb, ... } from "../src/index.js"`; helpers from `"./helpers.js"`).

---

### Task 1: Core taxonomy — `LEAD_SOURCE_VALUES` + `source_detail` schema

**Files:**
- Modify: `packages/core/src/lead-sources.ts` (add the enum + detail schema; keep `DEFAULT_LEAD_SOURCES`/`mergeLeadSources` for the picker)
- Create: `packages/core/src/lead-sources.test.ts`

**Interfaces:**
- Produces: `LEAD_SOURCE_VALUES`, `MACHINE_LEAD_SOURCES`, `AD_PLATFORM_VALUES`, `type LeadSourceValue`, `leadSourceDetailSchema(source)` returning the right zod schema, `isMachineSource(s)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/lead-sources.test.ts
import { describe, it, expect } from "vitest";
import { LEAD_SOURCE_VALUES, MACHINE_LEAD_SOURCES, AD_PLATFORM_VALUES, isMachineSource, leadSourceDetailSchema } from "./lead-sources";

describe("lead source taxonomy", () => {
  it("has the 6 human + 4 machine members", () => {
    expect(LEAD_SOURCE_VALUES).toEqual(["referral","insurance_agent","ads","realtor","partner","other","web","inbound_call","canvass","direct_mail"]);
    expect(MACHINE_LEAD_SOURCES).toEqual(["web","inbound_call","canvass","direct_mail"]);
    expect(AD_PLATFORM_VALUES).toContain("google_lsa");
  });
  it("classifies machine vs human sources", () => {
    expect(isMachineSource("web")).toBe(true);
    expect(isMachineSource("referral")).toBe(false);
  });
});

describe("leadSourceDetailSchema", () => {
  it("referral requires referrer_name; accepts optional fee cents", () => {
    expect(leadSourceDetailSchema("referral").safeParse({ referrer_name: "Jo", referral_fee_cents: 5000 }).success).toBe(true);
    expect(leadSourceDetailSchema("referral").safeParse({}).success).toBe(false);
  });
  it("ads requires a known platform", () => {
    expect(leadSourceDetailSchema("ads").safeParse({ platform: "meta" }).success).toBe(true);
    expect(leadSourceDetailSchema("ads").safeParse({ platform: "tiktok" }).success).toBe(false);
  });
  it("insurance_agent requires agency; realtor requires name; partner requires name", () => {
    expect(leadSourceDetailSchema("insurance_agent").safeParse({ agency: "Acme" }).success).toBe(true);
    expect(leadSourceDetailSchema("realtor").safeParse({ name: "Sue" }).success).toBe(true);
    expect(leadSourceDetailSchema("partner").safeParse({ name: "P" }).success).toBe(true);
  });
  it("other allows note/custom label and empty; machine sources take no detail (null ok)", () => {
    expect(leadSourceDetailSchema("other").safeParse({ note: "yard sign" }).success).toBe(true);
    expect(leadSourceDetailSchema("other").safeParse({ custom_label: "Home Show" }).success).toBe(true);
    expect(leadSourceDetailSchema("web").safeParse(null).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lead-sources`
Expected: FAIL — exports not defined.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/core/src/lead-sources.ts` (keep the existing `DEFAULT_LEAD_SOURCES`/`mergeLeadSources`):

```ts
import { z } from "zod";

export const LEAD_SOURCE_VALUES = [
  "referral", "insurance_agent", "ads", "realtor", "partner", "other",
  "web", "inbound_call", "canvass", "direct_mail",
] as const;
export type LeadSourceValue = (typeof LEAD_SOURCE_VALUES)[number];

export const MACHINE_LEAD_SOURCES = ["web", "inbound_call", "canvass", "direct_mail"] as const;
export const AD_PLATFORM_VALUES = ["google_lsa", "google_ads", "meta", "nextdoor", "other"] as const;

export function isMachineSource(s: string): boolean {
  return (MACHINE_LEAD_SOURCES as readonly string[]).includes(s);
}

const referralDetail = z.object({ referrer_name: z.string().min(1), referrer_contact: z.string().optional(), referral_fee_cents: z.number().int().min(0).optional() });
const insuranceAgentDetail = z.object({ agency: z.string().min(1), agent_name: z.string().optional() });
const adsDetail = z.object({ platform: z.enum(AD_PLATFORM_VALUES) });
const realtorDetail = z.object({ name: z.string().min(1), brokerage: z.string().optional() });
const partnerDetail = z.object({ name: z.string().min(1) });
const otherDetail = z.object({ note: z.string().optional(), custom_source_key: z.string().optional(), custom_label: z.string().optional() });
const emptyDetail = z.null().or(z.object({}).strict());

/** The zod schema for a source's `source_detail`, given the chosen source. */
export function leadSourceDetailSchema(source: string) {
  switch (source) {
    case "referral": return referralDetail;
    case "insurance_agent": return insuranceAgentDetail;
    case "ads": return adsDetail;
    case "realtor": return realtorDetail;
    case "partner": return partnerDetail;
    case "other": return otherDetail;
    default: return emptyDetail; // machine sources
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lead-sources && pnpm --filter @savvy/core typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/lead-sources.ts packages/core/src/lead-sources.test.ts
git commit -m "feat(core): structured lead source taxonomy + source_detail schema"
```

---

### Task 2: Core referral config + approval decision

**Files:**
- Create: `packages/core/src/referral.ts`
- Create: `packages/core/src/referral.test.ts`
- Modify: `packages/core/src/index.ts` (barrel exports for `./referral`; `./lead-sources` is already exported — verify)

**Interfaces:**
- Produces: `parseReferralConfig(raw): { approvalThresholdCents: number | null }`; `referralFeeRequiresApproval(feeCents, cfg): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/referral.test.ts
import { describe, it, expect } from "vitest";
import { parseReferralConfig, referralFeeRequiresApproval } from "./referral";

describe("referral config", () => {
  it("defaults threshold to null (no gating)", () => {
    expect(parseReferralConfig(undefined).approvalThresholdCents).toBeNull();
    expect(parseReferralConfig({ approvalThresholdCents: 25000 }).approvalThresholdCents).toBe(25000);
  });
});
describe("referralFeeRequiresApproval", () => {
  const cfg = (t: number | null) => ({ approvalThresholdCents: t });
  it("no threshold → never requires approval (auto-approve)", () => {
    expect(referralFeeRequiresApproval(999999, cfg(null))).toBe(false);
  });
  it("over threshold requires approval; at/under does not", () => {
    expect(referralFeeRequiresApproval(30000, cfg(25000))).toBe(true);
    expect(referralFeeRequiresApproval(25000, cfg(25000))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test referral`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/referral.ts
import { z } from "zod";

const referralSchema = z.object({
  // Referral fees at or below this auto-approve; above requires a human approval card.
  // null (default) = no gating — auto-approve every referral fee.
  approvalThresholdCents: z.number().int().min(0).nullable().default(null),
});
export type ReferralConfig = z.infer<typeof referralSchema>;

export function parseReferralConfig(raw: unknown): ReferralConfig {
  return referralSchema.parse(raw ?? {});
}

export function referralFeeRequiresApproval(feeCents: number, cfg: ReferralConfig): boolean {
  return cfg.approvalThresholdCents !== null && feeCents > cfg.approvalThresholdCents;
}
```

Add to `packages/core/src/index.ts` (after the `./lead-sources` export, or add it if missing):
```ts
export * from "./referral";
```
Verify `export * from "./lead-sources";` exists in the barrel (it should — `LeadSourceSelect` imports from `@savvy/core`); if not, add it.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test referral && pnpm --filter @savvy/core typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/referral.ts packages/core/src/referral.test.ts packages/core/src/index.ts
git commit -m "feat(core): referral fee config + approval-threshold decision"
```

---

### Task 3: Intake schema — required structured source + detail

**Files:**
- Modify: `packages/core/src/schemas.ts` (leadIntakeObject `source` → enum required, add `sourceDetail`; refine)
- Create: `packages/core/src/lead-intake-source.test.ts`

**Interfaces:**
- Consumes: `LEAD_SOURCE_VALUES`, `leadSourceDetailSchema` (Task 1).
- Produces: `leadIntakeObject.source` is `z.enum(LEAD_SOURCE_VALUES)` (required); `leadIntakeObject.sourceDetail` optional jsonb-ish; `leadIntakeSchema` refined so the detail matches the source. `LeadIntakeInput` now carries `source: LeadSourceValue` and `sourceDetail?: unknown`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/lead-intake-source.test.ts
import { describe, it, expect } from "vitest";
import { leadIntakeSchema } from "./schemas";

const base = { name: "Jo", phone: "4805551234", address: "1 Test St, Mesa AZ" };

describe("leadIntakeSchema — structured source", () => {
  it("rejects a missing source (no longer defaults to web)", () => {
    expect(leadIntakeSchema.safeParse({ ...base }).success).toBe(false);
  });
  it("rejects an unknown source", () => {
    expect(leadIntakeSchema.safeParse({ ...base, source: "tiktok" }).success).toBe(false);
  });
  it("accepts a referral with matching detail", () => {
    expect(leadIntakeSchema.safeParse({ ...base, source: "referral", sourceDetail: { referrer_name: "Sue", referral_fee_cents: 10000 } }).success).toBe(true);
  });
  it("rejects a referral whose detail is missing referrer_name", () => {
    expect(leadIntakeSchema.safeParse({ ...base, source: "referral", sourceDetail: {} }).success).toBe(false);
  });
  it("accepts a machine source with no detail", () => {
    expect(leadIntakeSchema.safeParse({ ...base, source: "web" }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test lead-intake-source`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `packages/core/src/schemas.ts`:
1. Import at top: `import { LEAD_SOURCE_VALUES, leadSourceDetailSchema } from "./lead-sources";`
2. Replace the `source` field in `leadIntakeObject` (currently `source: z.string().min(1).max(60).default("web"),`) with:
```ts
  source: z.enum(LEAD_SOURCE_VALUES),
  sourceDetail: z.unknown().optional(),
```
3. Extend the refinement. The current `leadIntakeSchema = leadIntakeObject.refine(hasContactMethod, contactMethodIssue);` — chain a second refine that validates the detail against the source:
```ts
export const leadIntakeSchema = leadIntakeObject
  .refine(hasContactMethod, contactMethodIssue)
  .refine(
    (d) => leadSourceDetailSchema(d.source).safeParse(d.sourceDetail ?? (d.source === "other" ? {} : null)).success,
    { message: "Fill in the required details for this source", path: ["sourceDetail"] },
  );
```

- [ ] **Step 4: Run to verify it passes; check consumers**

Run: `pnpm test lead-intake-source && pnpm --filter @savvy/core typecheck`
Expected: PASS. If `LeadIntakeInput` consumers break (source is now a union, not string), note them for Task 8 — do NOT fix web callers here.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/schemas.ts packages/core/src/lead-intake-source.test.ts
git commit -m "feat(core): manual lead intake requires a structured source + matching detail"
```

---

### Task 4: Migration 0072 — `source_detail`, `referral_payment`, legacy mapping

**Files:**
- Modify: `packages/db/src/schema/crm.ts` (add `sourceDetail` to `lead`)
- Modify: `packages/db/src/schema/finance.ts` (add `referralPayment` table)
- Create (generated): `packages/db/drizzle/0072_*.sql` — then HAND-EDIT to append the legacy data UPDATE
- Create: `packages/db/tests/lead-source-migration.test.ts`

**Interfaces:**
- Produces: `lead.sourceDetail` (jsonb, nullable); `referralPayment` table `{ id, tenantId, jobId, leadId, payeeName, amountCents, status, createdAt }` with `unique(tenantId, jobId)`.

- [ ] **Step 1: Write the failing test** (columns/table + zero-orphan mapping)

```ts
// packages/db/tests/lead-source-migration.test.ts
import { describe, it, expect } from "vitest";
import { adminDb, lead, referralPayment, eq, sql } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";
import { LEAD_SOURCE_VALUES } from "@savvy/core";

describe("Slice 3 schema + legacy mapping", () => {
  it("round-trips source + source_detail", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);
    await adminDb.update(lead).set({ source: "referral", sourceDetail: { referrer_name: "Sue" } }).where(eq(lead.id, leadId));
    const [l] = await adminDb.select().from(lead).where(eq(lead.id, leadId));
    expect(l!.source).toBe("referral");
    expect((l!.sourceDetail as { referrer_name: string }).referrer_name).toBe("Sue");
  });

  it("leaves zero lead.source values outside the enum after migration", async () => {
    const rows = await adminDb.execute<{ n: number }>(
      sql`select count(*)::int as n from lead where source is not null and source <> all(${sql.raw(`array[${LEAD_SOURCE_VALUES.map((v)=>`'${v}'`).join(",")}]`)})`);
    expect(rows.rows[0]!.n).toBe(0);
  });

  it("referral_payment enforces one row per (tenant, job)", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);
    // minimal job row for the FK — reuse a helper if one exists, else insert via adminDb
    const jobId = (await import("./helpers.js") as any).makeJob ? (await (await import("./helpers.js") as any).makeJob(tenantId)).jobId : null;
    if (!jobId) return; // if no job helper, covered by Task 5's integration test
    await adminDb.insert(referralPayment).values({ tenantId, jobId, leadId, payeeName: "Sue", amountCents: 10000, status: "approved" });
    await adminDb.insert(referralPayment).values({ tenantId, jobId, leadId, payeeName: "Sue", amountCents: 10000, status: "approved" }).onConflictDoNothing();
    const all = await adminDb.select().from(referralPayment).where(eq(referralPayment.jobId, jobId));
    expect(all).toHaveLength(1);
  });
});
```
(Check `packages/db/tests/helpers.ts` for a job helper; if `makeJob`/`makeJobWithProperty` exists use it directly instead of the dynamic-import guard.)

- [ ] **Step 2: Add schema, generate, hand-edit the migration**

`crm.ts` — add to `lead` (after `source: text("source"),`):
```ts
  sourceDetail: jsonb("source_detail"),
```
(ensure `jsonb` is in the drizzle import — it is, used by `scoreFeatures`.)

`finance.ts` — add after `commission`:
```ts
export const referralPayment = pgTable("referral_payment", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  leadId: uuid("lead_id").notNull().references(() => lead.id),
  payeeName: text("payee_name").notNull(),
  amountCents: integer("amount_cents").notNull(),
  status: text("status").notNull().default("pending"), // pending | approved | paid
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("referral_payment_tenant_job_uniq").on(t.tenantId, t.jobId),
  tenantIsolation(),
]);
```
(Confirm `lead` is imported in finance.ts — add `import { lead } from "./crm";` if absent; `job` is already imported.)

Generate: `pnpm db:generate` → creates `0072_*.sql`. Then **hand-append** the legacy data mapping to that SQL file (drizzle won't generate data UPDATEs):
```sql
-- Slice 3: map every legacy lead.source to the structured enum (zero orphans).
UPDATE "lead" SET source = 'web'            WHERE source IN ('web','website','seed','e2e','test') OR source IS NULL;
UPDATE "lead" SET source = 'canvass'        WHERE source IN ('door-knocking','door_knock','storm_canvass');
UPDATE "lead" SET source = 'inbound_call'   WHERE source = 'inbound-call';
UPDATE "lead" SET source = 'inbound_call', source_detail = '{"note":"after-hours voicemail"}'::jsonb WHERE source = 'after-hours-voicemail';
UPDATE "lead" SET source = 'ads', source_detail = '{"platform":"google_ads"}'::jsonb WHERE source = 'google';
UPDATE "lead" SET source = 'ads', source_detail = '{"platform":"meta"}'::jsonb       WHERE source = 'facebook';
UPDATE "lead" SET source = 'insurance_agent' WHERE source = 'carrier';
UPDATE "lead" SET source = 'other', source_detail = '{"note":"yard sign"}'::jsonb      WHERE source = 'yard_sign';
UPDATE "lead" SET source = 'other', source_detail = '{"note":"repeat customer"}'::jsonb WHERE source = 'repeat';
-- referral, other, and the machine set (canvass/inbound_call/direct_mail) already match; leave as-is.
-- Catch-all: any remaining unknown value → other with the original label preserved.
UPDATE "lead" SET source_detail = jsonb_build_object('custom_label', source), source = 'other'
  WHERE source <> ALL (ARRAY['referral','insurance_agent','ads','realtor','partner','other','web','inbound_call','canvass','direct_mail']);
```

- [ ] **Step 3: Run test RED (before migrate), then apply**

Run `pnpm db:up` (if not running). `pnpm test lead-source-migration` → FAIL (column/table missing). Then `pnpm db:migrate`.

- [ ] **Step 4: Run test to verify PASS**

Run: `pnpm test lead-source-migration && pnpm --filter @savvy/db typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/crm.ts packages/db/src/schema/finance.ts packages/db/drizzle/ packages/db/tests/lead-source-migration.test.ts
git commit -m "feat(db): migration 0072 — lead.source_detail + referral_payment + legacy source mapping"
```

---

### Task 5: `recordReferralPayment` — payable + threshold approval card

**Files:**
- Create: `packages/db/src/lifecycle/referral-payment.ts`
- Modify: the db barrel `packages/db/src/index.ts` (export the new functions, like the other lifecycle exports)
- Create: `packages/db/tests/referral-payment.test.ts`

**Interfaces:**
- Consumes: `referralPayment` (Task 4), `parseReferralConfig`/`referralFeeRequiresApproval` (Task 2).
- Produces: `recordReferralPayment(input: { tenantId: string; invoiceId: string }): Promise<{ created: boolean; status?: string }>` and the exported const `REFERRAL_FEE_APPROVAL_TASK_KEY = "finance.referral_fee_approval"`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/referral-payment.test.ts
import { describe, it, expect } from "vitest";
import { withTenant, adminDb, recordReferralPayment, referralPayment, lead, tenant, eq } from "../src/index.js";
import { makeTenant, makeJobWithLeadReferral } from "./helpers.js"; // see note

// NOTE: no such helper exists yet. Build the fixture inline in the test using adminDb:
// a customer+property+lead(source=referral, sourceDetail.referrer_name+referral_fee_cents),
// a job(leadId), an invoice(jobId), a payment. Model the inserts on
// packages/db/tests/finance.test.ts (grep it for the invoice/payment insert shape).

describe("recordReferralPayment", () => {
  it("creates one approved payable for a referral job under threshold, idempotently", async () => {
    const { tenantId, invoiceId, jobId } = await seedReferralJob({ feeCents: 10000, thresholdCents: null });
    const r1 = await recordReferralPayment({ tenantId, invoiceId });
    const r2 = await recordReferralPayment({ tenantId, invoiceId }); // repeat invoice/paid
    const rows = await adminDb.select().from(referralPayment).where(eq(referralPayment.jobId, jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("approved");
    expect(rows[0]!.amountCents).toBe(10000);
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
  });

  it("over threshold → pending + approval card", async () => {
    const { tenantId, invoiceId, jobId } = await seedReferralJob({ feeCents: 30000, thresholdCents: 25000 });
    await recordReferralPayment({ tenantId, invoiceId });
    const [row] = await adminDb.select().from(referralPayment).where(eq(referralPayment.jobId, jobId));
    expect(row!.status).toBe("pending");
    // approval card exists (job_checklist_item key = REFERRAL_FEE_APPROVAL_TASK_KEY) — assert via adminDb select on jobChecklistItem
  });

  it("no payable for a non-referral job", async () => {
    const { tenantId, invoiceId, jobId } = await seedReferralJob({ feeCents: 0, source: "web" });
    await recordReferralPayment({ tenantId, invoiceId });
    const rows = await adminDb.select().from(referralPayment).where(eq(referralPayment.jobId, jobId));
    expect(rows).toHaveLength(0);
  });
});
```
Implement a local `seedReferralJob({feeCents, thresholdCents, source})` helper in the test file: insert customer/property/lead (source, sourceDetail with referrer_name + referral_fee_cents), job (leadId, assignedUserId optional), invoice (jobId, amountDue, amountPaid=amountDue, status paid), payment; set `tenant.settings.referral.approvalThresholdCents = thresholdCents` via `adminDb.update(tenant)`. Model inserts on `packages/db/tests/finance.test.ts`.

- [ ] **Step 2: Run RED**

Run: `pnpm test referral-payment` → FAIL (recordReferralPayment not exported).

- [ ] **Step 3: Implement** (model on `packages/db/src/lifecycle/commission.ts` `recordCommission`)

```ts
// packages/db/src/lifecycle/referral-payment.ts
import { withTenant } from "../tenant";
import { invoice, referralPayment } from "../schema/finance";
import { lead } from "../schema/crm";
import { job } from "../schema/jobs";
import { jobChecklistItem } from "../schema/jobs"; // confirm the export name/path for the checklist item table
import { tenant } from "../schema/tenancy";
import { and, eq } from "drizzle-orm";
import { parseReferralConfig, referralFeeRequiresApproval } from "@savvy/core";

export const REFERRAL_FEE_APPROVAL_TASK_KEY = "finance.referral_fee_approval";

export async function recordReferralPayment(input: { tenantId: string; invoiceId: string }): Promise<{ created: boolean; status?: string }> {
  return withTenant(input.tenantId, async (tx) => {
    const [inv] = await tx.select().from(invoice).where(eq(invoice.id, input.invoiceId));
    if (!inv) return { created: false };
    const [j] = await tx.select().from(job).where(eq(job.id, inv.jobId));
    if (!j?.leadId) return { created: false };
    const [l] = await tx.select().from(lead).where(eq(lead.id, j.leadId));
    if (!l || l.source !== "referral") return { created: false };
    const detail = (l.sourceDetail ?? {}) as { referrer_name?: string; referral_fee_cents?: number };
    const feeCents = detail.referral_fee_cents ?? 0;
    if (feeCents <= 0 || !detail.referrer_name) return { created: false };

    // Idempotency: one referral_payment per (tenant, job).
    const existing = await tx.select({ id: referralPayment.id }).from(referralPayment)
      .where(and(eq(referralPayment.tenantId, input.tenantId), eq(referralPayment.jobId, j.id)));
    if (existing.length > 0) return { created: false, status: "exists" };

    const [t] = await tx.select().from(tenant).where(eq(tenant.id, input.tenantId));
    const cfg = parseReferralConfig((t?.settings as { referral?: unknown })?.referral);
    const requiresApproval = referralFeeRequiresApproval(feeCents, cfg);
    const status = requiresApproval ? "pending" : "approved";

    const inserted = await tx.insert(referralPayment).values({
      tenantId: input.tenantId, jobId: j.id, leadId: l.id,
      payeeName: detail.referrer_name, amountCents: feeCents, status,
    }).onConflictDoNothing().returning({ id: referralPayment.id });
    if (inserted.length === 0) return { created: false, status: "exists" };

    if (requiresApproval) {
      // Approval card — depreciation-style job_checklist_item, idempotent on (jobId, key).
      await tx.insert(jobChecklistItem).values({
        tenantId: input.tenantId, jobId: j.id, key: REFERRAL_FEE_APPROVAL_TASK_KEY,
        title: `Approve referral fee ($${(feeCents / 100).toFixed(2)}) to ${detail.referrer_name}`, status: "pending",
      }).onConflictDoNothing();
    }
    return { created: true, status };
  });
}
```
Notes: open `packages/db/src/lifecycle/depreciation-recovery.ts` for the exact `jobChecklistItem` insert shape (column names, the `(jobId,key)` conflict target) and match it. Export `recordReferralPayment` + `REFERRAL_FEE_APPROVAL_TASK_KEY` from `packages/db/src/index.ts` next to the other lifecycle exports.

- [ ] **Step 4: Run to verify PASS**

Run: `pnpm test referral-payment && pnpm --filter @savvy/db typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/referral-payment.ts packages/db/src/index.ts packages/db/tests/referral-payment.test.ts
git commit -m "feat(db): recordReferralPayment — idempotent payable + threshold approval card"
```

---

### Task 6: Inngest — referral fee on `invoice/paid`

**Files:**
- Create: `packages/agents/src/functions/referral-fee.ts` (model on `packages/agents/src/functions/commission.ts`)
- Modify: register the function where Inngest functions are collected (grep `commissionOnPaid` in `packages/agents/src` to find the registry array/export and add `referralFeeOnPaid` alongside)
- Create: `packages/agents/src/referral-fee.test.ts`

**Interfaces:**
- Consumes: `recordReferralPayment` (Task 5).

- [ ] **Step 1: Write the failing test** (integration — model DB setup on `packages/agents/src/enrichment.test.ts` for tenant/lead/job seeding)

```ts
// packages/agents/src/referral-fee.test.ts
import { describe, it, expect } from "vitest";
import { adminDb, referralPayment, eq } from "@savvy/db";
import { referralFeeOnPaid } from "./functions/referral-fee";
// Seed a referral job + paid invoice (as in referral-payment.test.ts), then invoke the fn's handler
// with event.data = { tenantId, invoiceId }. Assert one approved referral_payment row exists.
```

Note: Inngest functions are tested by calling the underlying helper the handler wraps. Since the handler just calls `recordReferralPayment`, the strongest test is: invoke `referralFeeOnPaid` via its exported handler (or, if awkward to invoke directly, add a thin exported `handleReferralFeePaid({tenantId, invoiceId})` that both the Inngest fn and the test call — mirror how other agents tests exercise their functions; grep `packages/agents/src/*.test.ts` for the pattern).

- [ ] **Step 2: Run RED** → FAIL.

- [ ] **Step 3: Implement** (mirror `commission.ts`)

```ts
// packages/agents/src/functions/referral-fee.ts
import { recordReferralPayment } from "@savvy/db";
import { inngest } from "../client";

export const referralFeeOnPaid = inngest.createFunction(
  { id: "referral-fee-on-paid", concurrency: { limit: 5 } },
  { event: "invoice/paid" },
  async ({ event, step }) => {
    const { tenantId, invoiceId } = event.data;
    const result = await step.run("record-referral-payment", async () =>
      recordReferralPayment({ tenantId, invoiceId }),
    );
    return { referral: result };
  },
);
```
Register `referralFeeOnPaid` in the Inngest functions array (same place `commissionOnPaid` is registered).

- [ ] **Step 4: Run PASS**

Run: `pnpm test referral-fee && pnpm --filter @savvy/agents typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/functions/referral-fee.ts packages/agents/src/referral-fee.test.ts packages/agents/src/*.ts
git commit -m "feat(agents): referral fee fires on invoice/paid (first payment)"
```

---

### Task 7: Attribution + CAC queries

**Files:**
- Create: `packages/db/src/lifecycle/lead-source-analytics.ts`
- Modify: `packages/db/src/index.ts` (barrel export)
- Create: `packages/db/tests/lead-source-analytics.test.ts`

**Interfaces:**
- Produces: `leadSourceSummary(tenantId): Promise<{ source: string; leadCount: number }[]>`; `referredRevenueByPerson(tenantId): Promise<{ name: string; source: string; jobCount: number; revenueCents: number }[]>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/lead-source-analytics.test.ts
import { describe, it, expect } from "vitest";
import { leadSourceSummary, referredRevenueByPerson } from "../src/index.js";
import { makeTenant } from "./helpers.js";
// Seed: 2 leads source=web, 1 lead source=referral with sourceDetail.referrer_name="Sue"
// whose job collected $500 revenue. Assert summary counts by source and Sue's referred revenue.
describe("lead source analytics", () => {
  it("leadSourceSummary counts leads by source", async () => {
    const { tenantId } = await makeTenant();
    // ...seed via adminDb...
    const rows = await leadSourceSummary(tenantId);
    expect(rows.find((r) => r.source === "web")?.leadCount).toBeGreaterThanOrEqual(2);
  });
  it("referredRevenueByPerson groups by referrer name", async () => {
    const { tenantId } = await makeTenant();
    // ...seed a referral lead + paid job...
    const rows = await referredRevenueByPerson(tenantId);
    expect(rows.some((r) => r.name === "Sue")).toBe(true);
  });
});
```

- [ ] **Step 2: Run RED** → FAIL.

- [ ] **Step 3: Implement** (tenant-scoped queries via `withTenant`; use `sql` aggregates like `commission.ts` does)

```ts
// packages/db/src/lifecycle/lead-source-analytics.ts
import { withTenant } from "../tenant";
import { lead } from "../schema/crm";
import { job } from "../schema/jobs";
import { invoice } from "../schema/finance";
import { eq, sql } from "drizzle-orm";

export async function leadSourceSummary(tenantId: string) {
  return withTenant(tenantId, async (tx) =>
    tx.select({ source: lead.source, leadCount: sql<number>`count(*)::int` })
      .from(lead).groupBy(lead.source));
}

export async function referredRevenueByPerson(tenantId: string) {
  return withTenant(tenantId, async (tx) =>
    tx.select({
      name: sql<string>`coalesce(lead.source_detail->>'referrer_name', lead.source_detail->>'agent_name', lead.source_detail->>'name')`,
      source: lead.source,
      jobCount: sql<number>`count(distinct ${job.id})::int`,
      revenueCents: sql<number>`coalesce(sum(${invoice.amountPaid}),0)::int`,
    })
      .from(lead)
      .innerJoin(job, eq(job.leadId, lead.id))
      .leftJoin(invoice, eq(invoice.jobId, job.id))
      .where(sql`lead.source in ('referral','insurance_agent','realtor','partner')`)
      .groupBy(sql`1, ${lead.source}`));
}
```
(Confirm the `lead.source_detail->>'...'` column reference compiles under drizzle's `sql` — if drizzle needs the mapped column, use `${lead.sourceDetail}` inside the `sql` template. Adjust to what typechecks.)

- [ ] **Step 4: Run PASS** → `pnpm test lead-source-analytics && pnpm --filter @savvy/db typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/lead-source-analytics.ts packages/db/src/index.ts packages/db/tests/lead-source-analytics.test.ts
git commit -m "feat(db): lead source summary + referred-revenue-by-person queries"
```

---

### Task 8: Wire creation — persist source_detail + fix machine callers

**Files:**
- Modify: `apps/web/src/lib/intake.ts:73-75` (insert `sourceDetail`)
- Modify: `apps/web/src/lib/lead-actions.ts:9-22` (`createLead` already parses `leadIntakeSchema` — pass `sourceDetail` through)
- Modify machine-source callers to valid enum values: `api/canvass/contract/route.ts:70` (`door-knocking`→`canvass`), `api/twilio/inbound/route.ts:30` (`inbound-call`→`inbound_call`), `api/twilio/voice/route.ts:45` (`after-hours-voicemail`→`inbound_call`), `api/voice/vapi/route.ts:109,206` (`inbound-call`→`inbound_call`), `lib/intake-schedule.ts:54`, `intake/[key]/page.tsx:24` (`web` — already valid), `packages/db/.../canvass.ts:9` (sets `canvass` explicitly since it omits source)
- Create: `apps/web/src/lib/intake.test.ts` OR extend an existing intake test — assert createLeadForTenant persists sourceDetail

**Interfaces:**
- Consumes: `leadIntakeSchema` (Task 3), `lead.sourceDetail` (Task 4).

- [ ] **Step 1: Write the failing test** — create a referral lead via `createLeadForTenant` and assert the stored `lead.source_detail.referrer_name`. (Model on any existing `intake`/lead db test; seed a tenant.)

- [ ] **Step 2: Run RED** → FAIL (sourceDetail not persisted).

- [ ] **Step 3: Implement**
- `intake.ts:73` lead insert: add `sourceDetail: (input as { sourceDetail?: unknown }).sourceDetail ?? null,`.
- `LeadIntakeInput` already carries `sourceDetail` from Task 3; `createLead` passes the parsed data straight to `createLeadForTenant`, so no change beyond ensuring the field flows.
- Machine callers: replace the hyphenated string literals with the valid enum members listed above. For paths that build `LeadIntakeInput` and pass it to `createLeadForTenant`, ensure `source` is a valid enum member and no `sourceDetail` is required (machine sources take none).
- `canvass.ts:9` `leadIntakeObject.omit({ source: true })` — after omit, the canvass creation must set `source: "canvass"` explicitly on its insert/call.

- [ ] **Step 4: Run PASS** — the new test + `pnpm --filter @savvy/web typecheck` + `pnpm --filter @savvy/db typecheck`. Grep for any remaining hyphenated source literal: `grep -rn '"door-knocking"\|"inbound-call"\|"after-hours-voicemail"' apps packages` → expect zero.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/intake.ts apps/web/src/lib/lead-actions.ts apps/web/src/app/api packages/db/src apps/web/src/lib/intake-schedule.ts "apps/web/src/app/(public)/intake/[key]/page.tsx"
git commit -m "feat(web): persist source_detail; machine lead paths use structured enum sources"
```

---

### Task 9: Web picker — conditional source-detail fields

**Files:**
- Modify: `apps/web/src/app/(app)/leads/new/NewLeadForm.tsx` (per-source conditional fields; pass `sourceDetail`)
- Modify: `apps/web/src/components/LeadSourceSelect.tsx` (list `LEAD_SOURCE_VALUES` human members + tenant customs; custom → `other`+`custom_label`)
- Test: `apps/web/tests/e2e/lead-source-taxonomy.spec.ts`

- [ ] **Step 1: Write the failing e2e** — go to `/leads/new`, select `referral`, assert a `referrer-name`/`referral-fee` field appears, fill name + fee + contact, submit, then assert the created lead persisted `source=referral` with the fee in `source_detail` (read via adminDb, or assert on the lead detail page). Follow `apps/web/tests/e2e/lead-capture.spec.ts` for the new-lead flow.

- [ ] **Step 2: Run RED** → FAIL.

- [ ] **Step 3: Implement** — in `NewLeadForm`, add `sourceDetail` state; when `source` changes, render that source's fields (referral: referrer_name [required], referrer_contact, referral_fee_dollars→cents; insurance_agent: agency [req], agent_name; ads: platform select from `AD_PLATFORM_VALUES`; realtor: name [req], brokerage; partner: name [req]; other: note). Pass `sourceDetail` in the `createLead({...})` call. `LeadSourceSelect` renders the human enum members (referral, insurance_agent, ads, realtor, partner, other) plus tenant customs from `initialCustomSources`; selecting a custom sets `source="other"` and stashes `custom_label` in sourceDetail. Machine sources are NOT offered in the manual picker.

- [ ] **Step 4: Run PASS** — e2e (create-tenant recipe from Slice 2) + `pnpm --filter @savvy/web typecheck`.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(app)/leads/new/NewLeadForm.tsx" apps/web/src/components/LeadSourceSelect.tsx apps/web/tests/e2e/lead-source-taxonomy.spec.ts
git commit -m "feat(web): new-lead picker asks conditional source-detail fields"
```

---

### Task 10: Referral-fee approval action

**Files:**
- Create: `apps/web/src/lib/referral-actions.ts` (`approveReferralPayment(jobId)` → set `referral_payment.status='approved'`, resolve the approval card)
- Test: `apps/web/tests/e2e/referral-approval.spec.ts` OR a db test on the action's core
- (Surface the pending referral payment + approve button wherever finance approval cards render — grep for where `DEPRECIATION_APPROVAL_TASK_KEY` / approval cards are shown and add the referral card there.)

- [ ] **Step 1: Write the failing test** — seed a `pending` referral_payment + its approval card; call `approveReferralPayment(jobId)`; assert status flips to `approved` and the card resolves.

- [ ] **Step 2: Run RED** → FAIL.

- [ ] **Step 3: Implement** — server action resolving tenant via `getTenantId()`, `withTenant` update `referral_payment` status → `approved` where `(tenant, job)`; mark the `job_checklist_item` (key `finance.referral_fee_approval`) done (match how depreciation's approval card is resolved). Revalidate the finance/approvals path.

- [ ] **Step 4: Run PASS** + typecheck.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/referral-actions.ts apps/web/tests/e2e/referral-approval.spec.ts
git commit -m "feat(web): approve an over-threshold referral fee"
```

---

### Task 11: Evidence — `lead.source_taxonomy` check + binding

**Files:**
- Modify: `packages/core/src/verification/checks.ts` (add the `lead.source_taxonomy` check)
- Modify: `packages/db/seeds/master-task-list.ts` (`CHECK_BINDINGS` entry)
- Modify: `packages/db/tests/master-task-list.test.ts` (add the bound-pair assertion)
- Create/extend: an evidence test asserting the invariant (model on `packages/db/tests/won-on-convert-evidence.test.ts`)

**Interfaces:**
- Consumes: `LEAD_SOURCE_VALUES`, `MACHINE_LEAD_SOURCES` (Task 1).

- [ ] **Step 1: Write the failing test** — a manually-created lead (non-machine source path) whose `source` is null/unknown FAILS `lead.source_taxonomy`; a machine-sourced lead (`web`/`inbound_call`/`canvass`/`direct_mail`) PASSES (exempt). Also add the `master-task-list.test.ts` assertion for the new bound pair.

- [ ] **Step 2: Run RED** → FAIL.

- [ ] **Step 3: Implement** — add `lead.source_taxonomy` to `evidenceChecks` (follow the existing `lead.*` `invariant(...)` shape: the check queries for manually-sourced leads with `source` not in `LEAD_SOURCE_VALUES` or null, excluding `MACHINE_LEAD_SOURCES`, and passes when none). Grep `packages/db/src/seed-data/task-lifecycle.json` for the "Referral tracking & source attribution" / "Lead source" registry task id (candidates 3 or 31) and add `<id>: "lead.source_taxonomy"` to `CHECK_BINDINGS`; add the matching `expect(byId(<id>).checkKey).toBe("lead.source_taxonomy")` in `master-task-list.test.ts`.

- [ ] **Step 4: Run PASS** — `pnpm test master-task-list verification-checks source-taxonomy && pnpm --filter @savvy/db typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/verification/checks.ts packages/db/seeds/master-task-list.ts packages/db/tests/
git commit -m "feat(evidence): lead.source_taxonomy invariant + binding"
```

---

## Final verification (before PR)

- [ ] `pnpm typecheck && pnpm lint && pnpm test` (full — semantic-merge safety).
- [ ] Grep no hyphenated legacy source literals remain in code (Task 8).
- [ ] Confirm exactly one new `CHECK_BINDINGS` entry (Task 11) and its assertion.
- [ ] Open PR; `gh pr checks <n> --watch`.

## Deploy + prove it (post-merge, owner-gated)

1. Apply migration 0072 to prod Supabase via MCP `apply_migration` + manual `__drizzle_migrations` ledger row (pooler can't DDL; the legacy data UPDATE runs inside the migration).
2. Verify: `select count(*) from lead where source is not null and source <> all (array[...])` = 0; spot-check remapped `source_detail`.
3. Live-check as a signed-in Bloom user: create a manual referral lead with a fee; confirm conditional fields; simulate a job first payment and confirm the referral_payment row + (over-threshold) approval card.
4. PR description: migration 0072, `lead.source_taxonomy` bound, the legacy mapping table, live-verify output.

## Self-Review (completed by plan author)

- **Spec coverage:** taxonomy schema (T1,T4) ✓; referral config (T2) ✓; required source (T3,T9) ✓; legacy migration zero-orphans (T4) ✓; referral payable + threshold card + idempotency (T5) ✓; invoice/paid trigger (T6) ✓; attribution + CAC (T7) ✓; creation wiring + machine callers (T8) ✓; picker conditional fields + custom→other (T9) ✓; approval action (T10) ✓; evidence check + binding (T11) ✓. Red-paths: zero-orphans (T4), payable idempotency + over-threshold card (T5), source_taxonomy invariant (T11).
- **Placeholder scan:** deferred specifics are "copy sibling X" anchors with exact file paths (jobChecklistItem shape in T5, Inngest registry in T6, registry task id in T11, e2e auth in T9) — not open TODOs.
- **Type consistency:** `LEAD_SOURCE_VALUES`/`MACHINE_LEAD_SOURCES`/`AD_PLATFORM_VALUES` consistent T1→T3→T7→T11; `recordReferralPayment({tenantId,invoiceId})` identical T5/T6; `referralPayment` columns match T4 schema and T5 inserts; `REFERRAL_FEE_APPROVAL_TASK_KEY` consistent T5/T10.
