# Phase 7 — Measurement & Retail Estimate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Roofr measurement auto-generates a ~98%-complete retail estimate (deterministic price-book rules + AI upsells), the rep edits it, and the customer e-signs — which advances the job to *approved*.

**Architecture:** Five subsystems in waves: (0) schema/enums/settings/events; (A) pure generation engine in `@savvy/core`; (B) price book table + lazy per-tenant seeding + settings UI; (C) Roofr gateway + ordering workflow + estimate-generation workflow + estimate editor UI; (D) DocuSeal gateway + send workflow + webhook → stage advance. Roofr/DocuSeal are fake-first gateways (the QBO real+fake pattern) so everything is tested without live creds.

**Tech Stack:** TypeScript, pnpm/Turborepo, Drizzle (Postgres + RLS), Inngest, Vitest, Playwright, Next.js App Router, Vercel AI SDK via LiteLLM gateway (`@savvy/ai`), Nango (Roofr/DocuSeal transport).

**Spec:** `docs/superpowers/specs/2026-06-15-phase7-measurement-estimate-design.md`

---

## Conventions (read once, applies to every task)

- **Run one package's tests** from repo root: `pnpm test <file-pattern>`. Only `@savvy/core`, `@savvy/db`, `@savvy/agents`, `@savvy/integrations` have a `test` script.
- **DB env for db/agents tests + migrations** (start DB first: `docker compose up -d`):
  ```bash
  export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
  export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
  ```
- **Imports:** app/agent code imports tables + drizzle operators (`eq`, `and`, `sql`, `desc`…) from `@savvy/db`, and `z` + domain helpers from `@savvy/core` — never from `drizzle-orm`/`zod` directly. **No `.js` extensions** on internal relative imports in SOURCE; `@savvy/db` TEST files DO use `.js`.
- **Money is integer cents; rates/percentages are integer basis points** (1000 = 10%). Quantities may be fractional (squares); amounts round half-up to whole cents.
- **Static gate before every commit:** `pnpm typecheck && pnpm lint && pnpm test` (affected package at minimum).
- **All new tenant tables/columns get `tenantIsolation()` / `tenant_id`** and are covered by the RLS isolation test (Task 19).
- **AI only via `@savvy/ai`** (`complete`/`completeObject` by `capability`) — never a hard-coded model string.

## File Structure

| File | Responsibility | Wave |
|------|----------------|------|
| `packages/core/src/enums.ts` (mod) | `ESTIMATE_SOURCE`, `ESTIMATE_STATUS`, `PRICE_BOOK_CATEGORY`, `PRICE_BOOK_UNIT`, `MEASUREMENT_FIELD` tuples + types | 0 |
| `packages/core/src/estimate-settings.ts` (new) | `estimateSchema`/`EstimateConfig`/`parseEstimateConfig` (tax, waste, pitch tiers) | 0 |
| `packages/core/src/measurement.ts` (new) | `measurementAreasSchema`, `parsePitch`, `pitchTier` | A |
| `packages/core/src/estimate-engine.ts` (new) | `generateEstimateLineItems` (rules + waste + pitch surcharge) | A |
| `packages/core/src/estimate.ts` (new) | `computeEstimateTotals` | A |
| `packages/core/src/price-book.ts` (new) | `DEFAULT_PRICE_BOOK` catalog + `DefaultPriceBookItem` type | B |
| `packages/core/src/index.ts` (mod) | re-export the above | 0/A/B |
| `packages/db/src/schema/enums.ts` (mod) | `priceBookCategoryEnum`, `priceBookUnitEnum` | 0 |
| `packages/db/src/schema/pricing.ts` (new) | `priceBookItem` table | 0 |
| `packages/db/src/schema/finance.ts` (mod) | `estimate` column additions | 0 |
| `packages/db/src/schema/index.ts` (mod) | `export * from "./pricing"` | 0 |
| `packages/db/drizzle/00NN_*.sql` (gen) | migration | 0 |
| `packages/db/src/lifecycle/price-book.ts` (new) | `ensurePriceBook` (idempotent per-tenant seed) | B |
| `packages/db/src/lifecycle/estimate.ts` (new) | `createEstimateFromMeasurement`, `setEstimateStatus` | C |
| `packages/db/src/index.ts` (mod) | export the lifecycle helpers | B/C |
| `packages/db/src/seed.ts` (mod) | seed price book for demo tenants | B |
| `packages/integrations/src/roofr.ts` (new) | `RoofrGateway` real + `makeFakeRoofr` | C |
| `packages/integrations/src/docuseal.ts` (new) | `DocusealGateway` real + `makeFakeDocuseal` | D |
| `packages/integrations/src/index.ts` (mod) | re-export gateways | C/D |
| `packages/agents/src/client.ts` (mod) | 4 new events | 0 |
| `packages/agents/src/functions/roofr-order.ts` (new) | `roofrOrderMeasurement` | C |
| `packages/agents/src/functions/estimate-generate.ts` (new) | `generateEstimateOnMeasurement` (+ AI upsell) | C |
| `packages/agents/src/functions/estimate-sign.ts` (new) | `sendEstimateForSignature`, `estimateAcceptedAdvanceJob` | D |
| `packages/agents/src/index.ts` (mod) | register new functions | C/D |
| `apps/web/src/lib/price-book-queries.ts` (new) | list + update price book | B |
| `apps/web/src/lib/estimate-queries.ts` (new) | estimate + measurement reads | C |
| `apps/web/src/lib/estimate-actions.ts` (new) | order/generate/update/accept-upsell/send actions | C/D |
| `apps/web/src/app/(app)/settings/price-book/*` (new) | price book + estimate settings UI | B |
| `apps/web/src/app/(app)/jobs/[id]/page.tsx` (mod) | Estimates section | C |
| `apps/web/src/app/(app)/jobs/[id]/estimates/[estimateId]/*` (new) | estimate editor | C |
| `apps/web/src/app/api/docuseal/webhook/route.ts` (new) | webhook → emit `estimate/accepted` | D |
| `apps/web/tests/e2e/estimate.spec.ts` (new) | full-chain e2e | gate |
| `.env.example` (already has Roofr/DocuSeal) | confirm | gate |

---

# Wave 0 — Foundation

## Task 1: Core enums

**Files:**
- Modify: `packages/core/src/enums.ts`
- Test: `packages/core/src/enums.test.ts`

- [ ] **Step 1: Write the failing test** — append to `packages/core/src/enums.test.ts`:

```ts
import {
  ESTIMATE_SOURCE, ESTIMATE_STATUS, PRICE_BOOK_CATEGORY, PRICE_BOOK_UNIT, MEASUREMENT_FIELD,
} from "./enums";

test("phase 7 enums", () => {
  expect(ESTIMATE_SOURCE).toEqual(["roofr", "manual", "carrier"]);
  expect(ESTIMATE_STATUS).toEqual(["draft", "sent", "accepted"]);
  expect(PRICE_BOOK_CATEGORY).toEqual(["material", "labor", "accessory", "upgrade"]);
  expect(PRICE_BOOK_UNIT).toEqual(["square", "lf", "each", "flat"]);
  expect(MEASUREMENT_FIELD).toContain("squares");
  expect(MEASUREMENT_FIELD).toContain("ridgeLf");
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test enums` → FAIL (not exported).

- [ ] **Step 3: Implement** — append to `packages/core/src/enums.ts`:

```ts
export const ESTIMATE_SOURCE = ["roofr", "manual", "carrier"] as const;
export const ESTIMATE_STATUS = ["draft", "sent", "accepted"] as const;
export const PRICE_BOOK_CATEGORY = ["material", "labor", "accessory", "upgrade"] as const;
export const PRICE_BOOK_UNIT = ["square", "lf", "each", "flat"] as const;
export const MEASUREMENT_FIELD = [
  "squares", "ridgeLf", "hipLf", "valleyLf", "eaveLf", "rakeLf", "stepFlashingLf", "penetrationCount",
] as const;
export type EstimateSource = (typeof ESTIMATE_SOURCE)[number];
export type EstimateStatus = (typeof ESTIMATE_STATUS)[number];
export type PriceBookCategory = (typeof PRICE_BOOK_CATEGORY)[number];
export type PriceBookUnit = (typeof PRICE_BOOK_UNIT)[number];
export type MeasurementField = (typeof MEASUREMENT_FIELD)[number];
```

- [ ] **Step 4: Run, verify pass** — `pnpm test enums` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/enums.ts packages/core/src/enums.test.ts
git commit -m "feat(core): phase 7 enums (estimate/price-book/measurement)"
```

## Task 2: Estimate settings schema

**Files:**
- Create: `packages/core/src/estimate-settings.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/estimate-settings.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect } from "vitest";
import { parseEstimateConfig } from "./estimate-settings";

describe("parseEstimateConfig", () => {
  it("fills defaults", () => {
    const c = parseEstimateConfig(undefined);
    expect(c.taxRateBps).toBe(0);
    expect(c.defaultWastePct).toBe(1200); // 12%
    expect(c.steepPitchTiers.length).toBe(4);
    expect(c.steepPitchTiers[0]).toEqual({ minRise: 0, maxRise: 6, laborSurchargePct: 0, wasteBumpPct: 0 });
    expect(c.steepPitchTiers[3]).toEqual({ minRise: 13, maxRise: null, laborSurchargePct: 5000, wasteBumpPct: 0 });
  });
  it("merges partial overrides", () => {
    const c = parseEstimateConfig({ taxRateBps: 830, defaultWastePct: 1000 });
    expect(c.taxRateBps).toBe(830);
    expect(c.defaultWastePct).toBe(1000);
    expect(c.steepPitchTiers.length).toBe(4); // default tiers still applied
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test estimate-settings` → FAIL.

- [ ] **Step 3: Implement** `packages/core/src/estimate-settings.ts`:

```ts
import { z } from "zod";

const pitchTierSchema = z.object({
  minRise: z.number().int().min(0),
  maxRise: z.number().int().min(0).nullable(),
  laborSurchargePct: z.number().int().min(0), // bps on labor items
  wasteBumpPct: z.number().int().min(0),      // bps added to field-shingle waste
});

const DEFAULT_TIERS = [
  { minRise: 0, maxRise: 6, laborSurchargePct: 0, wasteBumpPct: 0 },
  { minRise: 7, maxRise: 9, laborSurchargePct: 2000, wasteBumpPct: 0 },
  { minRise: 10, maxRise: 12, laborSurchargePct: 3500, wasteBumpPct: 0 },
  { minRise: 13, maxRise: null, laborSurchargePct: 5000, wasteBumpPct: 0 },
];

const estimateSchema = z.object({
  taxRateBps: z.number().int().min(0).default(0),
  defaultWastePct: z.number().int().min(0).default(1200),
  steepPitchTiers: z.array(pitchTierSchema).default(DEFAULT_TIERS),
});

export type PitchTier = z.infer<typeof pitchTierSchema>;
export type EstimateConfig = z.infer<typeof estimateSchema>;

export function parseEstimateConfig(raw: unknown): EstimateConfig {
  return estimateSchema.parse(raw ?? {});
}
```

- [ ] **Step 4: Run, verify pass**, then add `export * from "./estimate-settings";` to `packages/core/src/index.ts`. `pnpm test estimate-settings` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/estimate-settings.ts packages/core/src/estimate-settings.test.ts packages/core/src/index.ts
git commit -m "feat(core): estimate settings (tax, waste, contractor pitch tiers)"
```

## Task 3: DB pgEnums for price book

**Files:**
- Modify: `packages/db/src/schema/enums.ts`

- [ ] **Step 1: Implement** — add to the existing `@savvy/core` import list `PRICE_BOOK_CATEGORY, PRICE_BOOK_UNIT`, then at the bottom:

```ts
export const priceBookCategoryEnum = pgEnum("price_book_category", PRICE_BOOK_CATEGORY);
export const priceBookUnitEnum = pgEnum("price_book_unit", PRICE_BOOK_UNIT);
```

> `estimate.source`/`estimate.status` stay `text` (matching the existing `estimate` table) — no pgEnum for them.

- [ ] **Step 2: Typecheck** — `pnpm typecheck` → PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/schema/enums.ts
git commit -m "feat(db): price book pgEnums"
```

## Task 4: `price_book_item` table + estimate columns + migration

**Files:**
- Create: `packages/db/src/schema/pricing.ts`
- Modify: `packages/db/src/schema/finance.ts`, `packages/db/src/schema/index.ts`
- Generate: `packages/db/drizzle/00NN_*.sql`
- Test: `packages/db/tests/pricing.test.ts`

- [ ] **Step 1: Create** `packages/db/src/schema/pricing.ts`:

```ts
import { pgTable, uuid, text, integer, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { priceBookCategoryEnum, priceBookUnitEnum } from "./enums";

export const priceBookItem = pgTable("price_book_item", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  key: text("key").notNull(),
  name: text("name").notNull(),
  category: priceBookCategoryEnum("category").notNull(),
  unit: priceBookUnitEnum("unit").notNull(),
  unitPriceCents: integer("unit_price_cents").notNull().default(0),
  sourceFields: jsonb("source_fields").$type<string[]>().default([]).notNull(),
  wasteApplies: boolean("waste_applies").notNull().default(false),
  packSize: integer("pack_size").notNull().default(1),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [
  index("price_book_tenant_idx").on(t.tenantId),
  uniqueIndex("price_book_tenant_key_uniq").on(t.tenantId, t.key),
  tenantIsolation(),
]);
```

- [ ] **Step 2: Extend `estimate`** in `packages/db/src/schema/finance.ts` — add these columns inside the `estimate` table definition (after `esxUrl`):

```ts
  measurementId: uuid("measurement_id"),
  wastePctUsed: integer("waste_pct_used"),
  pitchTierApplied: text("pitch_tier_applied"),
  upsellSuggestions: jsonb("upsell_suggestions").$type<unknown[]>().default([]).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  docusealSubmissionId: text("docuseal_submission_id"),
```

> `uuid`, `integer`, `text`, `jsonb`, `timestamp` are already imported in finance.ts. `measurementId` is a plain `uuid` (no FK) to avoid a cross-file circular import with ops.ts; the link is enforced in app logic.

- [ ] **Step 3: Export** — add `export * from "./pricing";` to `packages/db/src/schema/index.ts`.

- [ ] **Step 4: Generate + apply migration**

```bash
pnpm db:generate   # additive: new table + nullable columns → no rename prompts
pnpm db:migrate
```

- [ ] **Step 5: Write the failing test** `packages/db/tests/pricing.test.ts` (mirror `commission.test.ts` / use `helpers.ts`):

```ts
import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { priceBookItem } from "../src/schema/pricing.js";
import { makeTestTenant } from "./helpers.js"; // reuse the existing tenant helper

describe("price_book_item", () => {
  it("inserts and reads back, tenant-scoped", async () => {
    const { tenantId } = await makeTestTenant();
    const row = await withTenant(tenantId, async (tx) => {
      const [r] = await tx.insert(priceBookItem).values({
        tenantId, key: "field-shingles", name: "Field shingles", category: "material",
        unit: "square", unitPriceCents: 12000, sourceFields: ["squares"], wasteApplies: true,
      }).returning();
      return r;
    });
    expect(row.wasteApplies).toBe(true);
    expect(row.sourceFields).toEqual(["squares"]);
  });
});
```

> Inspect `packages/db/tests/helpers.ts` and reuse its tenant-creation export (adapt `makeTestTenant` to the real name/return).

- [ ] **Step 6: Run** — `pnpm test pricing` → PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema packages/db/drizzle packages/db/tests/pricing.test.ts
git commit -m "feat(db): price_book_item table + estimate columns + migration"
```

## Task 5: New Inngest events

**Files:**
- Modify: `packages/agents/src/client.ts`

- [ ] **Step 1: Add to the `Events` type** (mirror existing `invoice/*` entries):

```ts
  "roofr/order.requested": { data: { tenantId: string; jobId: string; propertyId: string } };
  "measurement/ready": { data: { tenantId: string; jobId: string; measurementId: string } };
  "estimate/send.requested": { data: { tenantId: string; estimateId: string } };
  "estimate/accepted": { data: { tenantId: string; estimateId: string } };
```

- [ ] **Step 2: Typecheck** — `pnpm typecheck` → PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/client.ts
git commit -m "feat(agents): phase 7 estimate/measurement events"
```

---

# Wave A — Generation engine (pure core)

## Task 6: Measurement schema + pitch helpers

**Files:**
- Create: `packages/core/src/measurement.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/measurement.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect } from "vitest";
import { measurementAreasSchema, parsePitch, pitchTier } from "./measurement";
import { parseEstimateConfig } from "./estimate-settings";

const TIERS = parseEstimateConfig(undefined).steepPitchTiers;

describe("measurement", () => {
  it("parses areas with defaults for missing numeric fields", () => {
    const a = measurementAreasSchema.parse({ squares: 24.5, predominantPitch: "8/12", eaveLf: 120 });
    expect(a.squares).toBe(24.5);
    expect(a.ridgeLf).toBe(0); // default
    expect(a.predominantPitch).toBe("8/12");
  });
  it("parsePitch reads the rise", () => {
    expect(parsePitch("8/12")).toBe(8);
    expect(parsePitch("12/12")).toBe(12);
    expect(parsePitch("flat")).toBe(0);
  });
  it("pitchTier selects by rise", () => {
    expect(pitchTier(4, TIERS).laborSurchargePct).toBe(0);
    expect(pitchTier(8, TIERS).laborSurchargePct).toBe(2000);
    expect(pitchTier(11, TIERS).laborSurchargePct).toBe(3500);
    expect(pitchTier(16, TIERS).laborSurchargePct).toBe(5000); // maxRise null = catch-all
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test measurement` → FAIL.

- [ ] **Step 3: Implement** `packages/core/src/measurement.ts`:

```ts
import { z } from "zod";
import type { PitchTier } from "./estimate-settings";

const num = () => z.number().min(0).default(0);

export const measurementAreasSchema = z.object({
  squares: num(),
  predominantPitch: z.string().default("0/12"),
  ridgeLf: num(),
  hipLf: num(),
  valleyLf: num(),
  eaveLf: num(),
  rakeLf: num(),
  stepFlashingLf: num(),
  penetrationCount: num(),
  facetCount: num(),
});
export type MeasurementAreas = z.infer<typeof measurementAreasSchema>;

/** Rise from an "X/12" pitch string; non-numeric (e.g. "flat") → 0. */
export function parsePitch(pitch: string): number {
  const m = /^(\d+)\s*\/\s*12$/.exec(pitch.trim());
  return m ? parseInt(m[1]!, 10) : 0;
}

/** First tier whose [minRise, maxRise] contains rise (maxRise null = catch-all). */
export function pitchTier(rise: number, tiers: PitchTier[]): PitchTier {
  const hit = tiers.find((t) => rise >= t.minRise && (t.maxRise === null || rise <= t.maxRise));
  return hit ?? { minRise: 0, maxRise: null, laborSurchargePct: 0, wasteBumpPct: 0 };
}
```

- [ ] **Step 4: Run, verify pass**, add `export * from "./measurement";` to `packages/core/src/index.ts`. `pnpm test measurement` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/measurement.ts packages/core/src/measurement.test.ts packages/core/src/index.ts
git commit -m "feat(core): measurement schema + pitch parsing/tiers"
```

## Task 7: `generateEstimateLineItems` engine

**Files:**
- Create: `packages/core/src/estimate-engine.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/estimate-engine.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect } from "vitest";
import { generateEstimateLineItems } from "./estimate-engine";
import { measurementAreasSchema } from "./measurement";
import { parseEstimateConfig } from "./estimate-settings";

const cfg = parseEstimateConfig(undefined); // waste 1200 bps, default tiers
const areas = measurementAreasSchema.parse({
  squares: 20, predominantPitch: "8/12", eaveLf: 100, rakeLf: 50, ridgeLf: 30, hipLf: 10, valleyLf: 0,
});
const book = [
  { key: "field-shingles", name: "Field shingles", category: "material" as const, unit: "square" as const, unitPriceCents: 10000, sourceFields: ["squares"], wasteApplies: true, packSize: 1, active: true },
  { key: "starter", name: "Starter", category: "accessory" as const, unit: "lf" as const, unitPriceCents: 200, sourceFields: ["eaveLf"], wasteApplies: false, packSize: 1, active: true },
  { key: "drip-edge", name: "Drip edge", category: "accessory" as const, unit: "lf" as const, unitPriceCents: 150, sourceFields: ["eaveLf", "rakeLf"], wasteApplies: false, packSize: 10, active: true },
  { key: "install", name: "Install labor", category: "labor" as const, unit: "square" as const, unitPriceCents: 8000, sourceFields: ["squares"], wasteApplies: false, packSize: 1, active: true },
  { key: "inactive", name: "Skip me", category: "material" as const, unit: "square" as const, unitPriceCents: 999, sourceFields: ["squares"], wasteApplies: false, packSize: 1, active: false },
];

describe("generateEstimateLineItems", () => {
  const out = generateEstimateLineItems({ areas, priceBook: book, defaultWastePct: cfg.defaultWastePct, pitchTiers: cfg.steepPitchTiers });
  const byKey = Object.fromEntries(out.lineItems.map((l) => [l.key, l]));

  it("waste applies ONLY to field shingles", () => {
    expect(byKey["field-shingles"].quantity).toBeCloseTo(22.4); // 20 * 1.12
    expect(byKey["starter"].quantity).toBe(100);                // no waste
  });
  it("drip edge rounds up to packSize (10ft sticks)", () => {
    expect(byKey["drip-edge"].quantity).toBe(150); // 100+50=150 already multiple of 10
  });
  it("pitch surcharge applies ONLY to labor (8/12 -> +20%)", () => {
    // install base = 20 * 8000 = 160000; +20% = 192000
    expect(byKey["install"].amountCents).toBe(192000);
    expect(byKey["install"].pitchSurchargePct).toBe(2000);
    expect(byKey["field-shingles"].pitchSurchargePct).toBeUndefined();
  });
  it("skips inactive items and reports the applied waste + tier", () => {
    expect(byKey["inactive"]).toBeUndefined();
    expect(out.wastePctUsed).toBe(1200);
    expect(out.pitchTierApplied).toBe("7-9");
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test estimate-engine` → FAIL.

- [ ] **Step 3: Implement** `packages/core/src/estimate-engine.ts`:

```ts
import type { MeasurementAreas } from "./measurement";
import { parsePitch, pitchTier } from "./measurement";
import type { PitchTier } from "./estimate-settings";
import type { PriceBookCategory, PriceBookUnit } from "./enums";

export interface EnginePriceBookItem {
  key: string;
  name: string;
  category: PriceBookCategory;
  unit: PriceBookUnit;
  unitPriceCents: number;
  sourceFields: string[];
  wasteApplies: boolean;
  packSize: number;
  active: boolean;
}

export interface EstimateLineItem {
  key: string;
  name: string;
  category: PriceBookCategory;
  unit: PriceBookUnit;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  wasteAppliedPct?: number;
  pitchSurchargePct?: number;
}

function roundUpToPack(qty: number, packSize: number): number {
  if (packSize <= 1) return qty;
  return Math.ceil(qty / packSize) * packSize;
}

function tierLabel(t: PitchTier): string {
  return t.maxRise === null ? `${t.minRise}+` : `${t.minRise}-${t.maxRise}`;
}

export function generateEstimateLineItems(input: {
  areas: MeasurementAreas;
  priceBook: EnginePriceBookItem[];
  defaultWastePct: number; // bps
  pitchTiers: PitchTier[];
}): { lineItems: EstimateLineItem[]; wastePctUsed: number; pitchTierApplied: string } {
  const rise = parsePitch(input.areas.predominantPitch);
  const tier = pitchTier(rise, input.pitchTiers);
  const wastePctUsed = input.defaultWastePct + tier.wasteBumpPct;
  const areas = input.areas as unknown as Record<string, number>;

  const lineItems: EstimateLineItem[] = [];
  for (const item of input.priceBook) {
    if (!item.active || item.sourceFields.length === 0) continue;
    let qty = item.sourceFields.reduce((s, f) => s + (areas[f] ?? 0), 0);
    if (qty <= 0) continue;

    let wasteAppliedPct: number | undefined;
    if (item.wasteApplies) {
      wasteAppliedPct = wastePctUsed;
      qty = qty * (1 + wastePctUsed / 10_000);
    }
    qty = roundUpToPack(qty, item.packSize);

    let amountCents = Math.round(qty * item.unitPriceCents);
    let pitchSurchargePct: number | undefined;
    if (item.category === "labor" && tier.laborSurchargePct > 0) {
      pitchSurchargePct = tier.laborSurchargePct;
      amountCents = Math.round(amountCents * (1 + tier.laborSurchargePct / 10_000));
    }

    lineItems.push({
      key: item.key, name: item.name, category: item.category, unit: item.unit,
      quantity: qty, unitPriceCents: item.unitPriceCents, amountCents, wasteAppliedPct, pitchSurchargePct,
    });
  }
  return { lineItems, wastePctUsed, pitchTierApplied: tierLabel(tier) };
}
```

- [ ] **Step 4: Run, verify pass**, add `export * from "./estimate-engine";` to `packages/core/src/index.ts`. `pnpm test estimate-engine` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/estimate-engine.ts packages/core/src/estimate-engine.test.ts packages/core/src/index.ts
git commit -m "feat(core): estimate engine (waste field-shingles only, labor pitch surcharge)"
```

## Task 8: `computeEstimateTotals`

**Files:**
- Create: `packages/core/src/estimate.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/estimate.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect } from "vitest";
import { computeEstimateTotals } from "./estimate";

describe("computeEstimateTotals", () => {
  it("sums line amounts and applies tax in bps", () => {
    const items = [{ amountCents: 100000 }, { amountCents: 52050 }];
    expect(computeEstimateTotals(items, 830)).toEqual({
      subtotalCents: 152050, taxCents: 12620, totalCents: 164670, // 152050 * 0.083 = 12620.15 -> 12620
    });
  });
  it("zero tax", () => {
    expect(computeEstimateTotals([{ amountCents: 5000 }], 0)).toEqual({ subtotalCents: 5000, taxCents: 0, totalCents: 5000 });
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test estimate.test` → FAIL.

- [ ] **Step 3: Implement** `packages/core/src/estimate.ts`:

```ts
export function computeEstimateTotals(
  lineItems: { amountCents: number }[],
  taxRateBps: number,
): { subtotalCents: number; taxCents: number; totalCents: number } {
  const subtotalCents = lineItems.reduce((s, l) => s + l.amountCents, 0);
  const taxCents = Math.round((subtotalCents * taxRateBps) / 10_000);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}
```

- [ ] **Step 4: Run, verify pass**, add `export * from "./estimate";` to `packages/core/src/index.ts`. `pnpm test estimate.test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/estimate.ts packages/core/src/estimate.test.ts packages/core/src/index.ts
git commit -m "feat(core): computeEstimateTotals"
```

---

# Wave B — Price book (catalog, seeding, UI)

## Task 9: Default catalog + `ensurePriceBook`

**Files:**
- Create: `packages/core/src/price-book.ts`, `packages/db/src/lifecycle/price-book.ts`
- Modify: `packages/core/src/index.ts`, `packages/db/src/index.ts`
- Test: `packages/db/tests/ensure-price-book.test.ts`

- [ ] **Step 1: Implement the catalog** `packages/core/src/price-book.ts`:

```ts
import type { PriceBookCategory, PriceBookUnit } from "./enums";

export interface DefaultPriceBookItem {
  key: string; name: string; category: PriceBookCategory; unit: PriceBookUnit;
  unitPriceCents: number; sourceFields: string[]; wasteApplies: boolean; packSize: number; sortOrder: number;
}

// Built-in defaults. Prices are placeholders the tenant edits. Waste ONLY on field shingles.
export const DEFAULT_PRICE_BOOK: DefaultPriceBookItem[] = [
  { key: "field-shingles", name: "Field shingles", category: "material", unit: "square", unitPriceCents: 12000, sourceFields: ["squares"], wasteApplies: true, packSize: 1, sortOrder: 10 },
  { key: "starter-strip", name: "Starter strip", category: "accessory", unit: "lf", unitPriceCents: 200, sourceFields: ["eaveLf"], wasteApplies: false, packSize: 1, sortOrder: 20 },
  { key: "hip-ridge-cap", name: "Hip & ridge cap", category: "accessory", unit: "lf", unitPriceCents: 400, sourceFields: ["ridgeLf", "hipLf"], wasteApplies: false, packSize: 1, sortOrder: 30 },
  { key: "drip-edge", name: "Drip edge", category: "accessory", unit: "lf", unitPriceCents: 150, sourceFields: ["eaveLf", "rakeLf"], wasteApplies: false, packSize: 10, sortOrder: 40 },
  { key: "underlayment", name: "Underlayment", category: "material", unit: "square", unitPriceCents: 1500, sourceFields: ["squares"], wasteApplies: false, packSize: 1, sortOrder: 50 },
  { key: "ice-water-shield", name: "Ice & water shield", category: "material", unit: "lf", unitPriceCents: 300, sourceFields: ["eaveLf", "valleyLf"], wasteApplies: false, packSize: 1, sortOrder: 60 },
  { key: "valley-metal", name: "Valley metal", category: "material", unit: "lf", unitPriceCents: 350, sourceFields: ["valleyLf"], wasteApplies: false, packSize: 1, sortOrder: 70 },
  { key: "step-flashing", name: "Step flashing", category: "material", unit: "lf", unitPriceCents: 250, sourceFields: ["stepFlashingLf"], wasteApplies: false, packSize: 1, sortOrder: 80 },
  { key: "pipe-boots", name: "Pipe boots", category: "accessory", unit: "each", unitPriceCents: 2500, sourceFields: ["penetrationCount"], wasteApplies: false, packSize: 1, sortOrder: 90 },
  { key: "tear-off", name: "Tear-off (labor)", category: "labor", unit: "square", unitPriceCents: 6000, sourceFields: ["squares"], wasteApplies: false, packSize: 1, sortOrder: 100 },
  { key: "install", name: "Install (labor)", category: "labor", unit: "square", unitPriceCents: 8000, sourceFields: ["squares"], wasteApplies: false, packSize: 1, sortOrder: 110 },
];
```

Add `export * from "./price-book";` to `packages/core/src/index.ts`.

- [ ] **Step 2: Write the failing test** `packages/db/tests/ensure-price-book.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ensurePriceBook } from "../src/lifecycle/price-book.js";
import { withTenant } from "../src/tenant.js";
import { priceBookItem } from "../src/schema/pricing.js";
import { makeTestTenant } from "./helpers.js";

describe("ensurePriceBook", () => {
  it("seeds defaults once, idempotent", async () => {
    const { tenantId } = await makeTestTenant();
    const a = await ensurePriceBook(tenantId);
    expect(a.seeded).toBeGreaterThan(5);
    const b = await ensurePriceBook(tenantId); // no-op
    expect(b.seeded).toBe(0);
    const rows = await withTenant(tenantId, (tx) => tx.select().from(priceBookItem));
    expect(rows.length).toBe(a.seeded);
    expect(rows.find((r) => r.key === "field-shingles")?.wasteApplies).toBe(true);
  });
});
```

- [ ] **Step 3: Implement** `packages/db/src/lifecycle/price-book.ts`:

```ts
import { withTenant } from "../tenant";
import { priceBookItem } from "../schema/pricing";
import { DEFAULT_PRICE_BOOK } from "@savvy/core";

/** Seeds the built-in catalog for a tenant the first time. Idempotent via onConflictDoNothing. */
export async function ensurePriceBook(tenantId: string): Promise<{ seeded: number }> {
  return withTenant(tenantId, async (tx) => {
    const existing = await tx.select({ id: priceBookItem.id }).from(priceBookItem).limit(1);
    if (existing.length > 0) return { seeded: 0 };
    const rows = DEFAULT_PRICE_BOOK.map((d) => ({ ...d, tenantId }));
    const inserted = await tx.insert(priceBookItem).values(rows).onConflictDoNothing().returning({ id: priceBookItem.id });
    return { seeded: inserted.length };
  });
}
```

Add `export { ensurePriceBook } from "./lifecycle/price-book";` to `packages/db/src/index.ts`.

- [ ] **Step 4: Run, verify pass** — `pnpm test ensure-price-book` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/price-book.ts packages/core/src/index.ts packages/db/src/lifecycle/price-book.ts packages/db/src/index.ts packages/db/tests/ensure-price-book.test.ts
git commit -m "feat: default price book catalog + idempotent per-tenant seeding"
```

## Task 10: Price book queries + update action

**Files:**
- Create: `apps/web/src/lib/price-book-queries.ts`
- Test: covered by Task 11 build + e2e (no unit test — thin data layer)

- [ ] **Step 1: Implement** `apps/web/src/lib/price-book-queries.ts` (mirror `commission-queries.ts` for the `server-only` + `getTenantId` + `withTenant` pattern):

```ts
import "server-only";
import { withTenant, ensurePriceBook, priceBookItem, eq, asc } from "@savvy/db";
import { getTenantId } from "./tenant";

export async function listPriceBook() {
  const tenantId = await getTenantId();
  await ensurePriceBook(tenantId); // lazy-seed on first open
  return withTenant(tenantId, (tx) =>
    tx.select().from(priceBookItem).orderBy(asc(priceBookItem.sortOrder)),
  );
}

export async function updatePriceBookItem(input: {
  id: string; unitPriceCents: number; wasteApplies: boolean; active: boolean; sourceFields: string[];
}) {
  "use server";
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx.update(priceBookItem)
      .set({ unitPriceCents: input.unitPriceCents, wasteApplies: input.wasteApplies, active: input.active, sourceFields: input.sourceFields })
      .where(eq(priceBookItem.id, input.id)),
  );
}
```

- [ ] **Step 2: Typecheck** — `pnpm --filter @savvy/web typecheck` → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/price-book-queries.ts
git commit -m "feat(web): price book queries + update action"
```

## Task 11: Price book + estimate settings UI

**Files:**
- Create: `apps/web/src/app/(app)/settings/price-book/page.tsx`, `PriceBookClient.tsx`
- Modify: `apps/web/src/app/(app)/layout.tsx` (nav link)

Mirror the existing settings page pattern (`settings/quickbooks/page.tsx`) for the `force-dynamic` server-component shape and `InvoicesClient.tsx` for the editable shadcn table + currency formatting.

- [ ] **Step 1: Page** `settings/price-book/page.tsx`:

```tsx
import { listPriceBook } from "@/lib/price-book-queries";
import { PriceBookClient } from "./PriceBookClient";

export const dynamic = "force-dynamic";

export default async function PriceBookPage() {
  const items = await listPriceBook();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Price Book</h1>
      <PriceBookClient items={items} />
    </div>
  );
}
```

- [ ] **Step 2: Client** `PriceBookClient.tsx` — a `"use client"` table listing each item (name, category, unit, source fields, **editable** unit price, **toggle** waste, **toggle** active), each row with a Save button calling `updatePriceBookItem`. Reuse the currency input + shadcn `Card`/`Button`/`Switch` from existing components. Each row `data-testid="price-book-row"` with `data-key={item.key}`. Format price with the `fmtUsd` helper copied from `CommissionsClient.tsx`.

- [ ] **Step 3: Nav** — add a `Price Book` link to `apps/web/src/app/(app)/layout.tsx` next to the existing settings links (match the existing markup).

- [ ] **Step 4: Build check** — `pnpm --filter @savvy/web typecheck` → PASS (`force-dynamic` keeps it out of prerender).

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(app)/settings/price-book" "apps/web/src/app/(app)/layout.tsx"
git commit -m "feat(web): price book settings UI"
```

---

# Wave C — Roofr ordering + estimate generation

## Task 12: `RoofrGateway` (real + fake)

**Files:**
- Create: `packages/integrations/src/roofr.ts`
- Modify: `packages/integrations/src/index.ts`
- Test: `packages/integrations/src/roofr.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect } from "vitest";
import { makeFakeRoofr } from "./roofr";

describe("makeFakeRoofr", () => {
  it("orders then returns a ready report with areas + pitch", async () => {
    const roofr = makeFakeRoofr();
    const { orderId } = await roofr.orderMeasurement({ address: "1 Main St" });
    expect(orderId).toMatch(/^roofr_ord_/);
    const rep = await roofr.getReport(orderId);
    expect(rep.ready).toBe(true);
    expect(rep.areas.squares).toBeGreaterThan(0);
    expect(rep.areas.predominantPitch).toMatch(/\/12$/);
    expect(rep.costCents).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test roofr` → FAIL.

- [ ] **Step 3: Implement** `packages/integrations/src/roofr.ts` (real impl mirrors `qbo.ts` nangoProxy usage; fake is deterministic):

```ts
import { nangoProxy } from "./nango";

export interface RoofrReport {
  ready: boolean;
  areas: {
    squares: number; predominantPitch: string; ridgeLf: number; hipLf: number; valleyLf: number;
    eaveLf: number; rakeLf: number; stepFlashingLf: number; penetrationCount: number; facetCount: number;
  };
  reportUrl: string;
  costCents: number; // Roofr cost + $3 markup
}

export interface RoofrGateway {
  orderMeasurement(o: { address: string }): Promise<{ orderId: string }>;
  getReport(orderId: string): Promise<RoofrReport>;
}

const ROOFR_INTEGRATION = () => process.env.NANGO_ROOFR_INTEGRATION_ID ?? "roofr";
const MARKUP_CENTS = 300;

export const nangoRoofr: RoofrGateway = {
  async orderMeasurement({ address }) {
    const res = await nangoProxy({ connectionId: "roofr", integrationId: ROOFR_INTEGRATION(), method: "POST", endpoint: "/orders", body: { address } });
    return { orderId: String((res as { id?: string }).id ?? "") };
  },
  async getReport(orderId) {
    const res = (await nangoProxy({ connectionId: "roofr", integrationId: ROOFR_INTEGRATION(), method: "GET", endpoint: `/orders/${orderId}` })) as Record<string, unknown>;
    const a = (res.measurements ?? {}) as Record<string, number>;
    return {
      ready: res.status === "complete",
      areas: {
        squares: a.squares ?? 0, predominantPitch: String(res.pitch ?? "0/12"),
        ridgeLf: a.ridge ?? 0, hipLf: a.hip ?? 0, valleyLf: a.valley ?? 0, eaveLf: a.eave ?? 0,
        rakeLf: a.rake ?? 0, stepFlashingLf: a.stepFlashing ?? 0, penetrationCount: a.penetrations ?? 0, facetCount: a.facets ?? 0,
      },
      reportUrl: String(res.reportUrl ?? ""),
      costCents: Math.round(Number(res.priceCents ?? 0)) + MARKUP_CENTS,
    };
  },
};

export function makeFakeRoofr(): RoofrGateway & { calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    async orderMeasurement() { const orderId = `roofr_ord_${++n}`; calls.push(`order:${orderId}`); return { orderId }; },
    async getReport(orderId) {
      calls.push(`report:${orderId}`);
      return {
        ready: true,
        areas: { squares: 24.5, predominantPitch: "7/12", ridgeLf: 40, hipLf: 20, valleyLf: 15, eaveLf: 120, rakeLf: 60, stepFlashingLf: 10, penetrationCount: 4, facetCount: 8 },
        reportUrl: `https://roofr.test/reports/${orderId}`,
        costCents: 2500 + 300,
      };
    },
  };
}
```

Add `export { nangoRoofr, makeFakeRoofr, type RoofrGateway, type RoofrReport } from "./roofr";` to `packages/integrations/src/index.ts`.

- [ ] **Step 4: Run, verify pass** — `pnpm test roofr` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/integrations/src/roofr.ts packages/integrations/src/index.ts packages/integrations/src/roofr.test.ts
git commit -m "feat(integrations): RoofrGateway (real via nango + fake, +\$3 markup)"
```

## Task 13: `createEstimateFromMeasurement` lifecycle

**Files:**
- Create: `packages/db/src/lifecycle/estimate.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/tests/create-estimate.test.ts`

- [ ] **Step 1: Write the failing test** (mirror `helpers.ts`; create tenant + job + a measurement row):

```ts
import { describe, it, expect } from "vitest";
import { createEstimateFromMeasurement, setEstimateStatus } from "../src/lifecycle/estimate.js";
import { withTenant } from "../src/tenant.js";
import { estimate } from "../src/schema/finance.js";
import { measurement } from "../src/schema/ops.js";
import { eq } from "drizzle-orm";
import { makeTestTenant, makeJob } from "./helpers.js"; // adapt to real helper names

describe("createEstimateFromMeasurement", () => {
  it("generates a draft estimate from a measurement using the tenant price book", async () => {
    const { tenantId } = await makeTestTenant();
    const jobId = await makeJob(tenantId); // helper that also creates a property
    const measurementId = await withTenant(tenantId, async (tx) => {
      const [m] = await tx.insert(measurement).values({
        tenantId, propertyId: (await tx.select().from(measurement).limit(0), undefined) ?? undefined,
        provider: "roofr", areas: { squares: 20, predominantPitch: "8/12", eaveLf: 100, rakeLf: 50 },
      } as never).returning();
      return m.id;
    });
    const est = await createEstimateFromMeasurement({ tenantId, jobId, measurementId });
    expect(est?.status).toBe("draft");
    expect(est?.source).toBe("roofr");
    expect((est?.total ?? 0)).toBeGreaterThan(0);

    await setEstimateStatus({ tenantId, estimateId: est!.id, status: "accepted" });
    const [after] = await withTenant(tenantId, (tx) => tx.select().from(estimate).where(eq(estimate.id, est!.id)));
    expect(after.status).toBe("accepted");
    expect(after.acceptedAt).not.toBeNull();
  });
});
```

> Adapt the measurement insert to the real `property` setup in `helpers.ts` (a measurement needs a `propertyId`). Keep the helper additions in `helpers.ts` if missing (`makeJob` returning a job with a property).

- [ ] **Step 2: Run, verify fail** — `pnpm test create-estimate` → FAIL.

- [ ] **Step 3: Implement** `packages/db/src/lifecycle/estimate.ts`:

```ts
import { withTenant } from "../tenant";
import { estimate } from "../schema/finance";
import { measurement } from "../schema/ops";
import { priceBookItem } from "../schema/pricing";
import { tenant } from "../schema/tenancy";
import { and, eq, sql } from "drizzle-orm";
import {
  parseEstimateConfig, measurementAreasSchema, generateEstimateLineItems, computeEstimateTotals,
  type EnginePriceBookItem,
} from "@savvy/core";

export async function createEstimateFromMeasurement(input: { tenantId: string; jobId: string; measurementId: string }) {
  return withTenant(input.tenantId, async (tx) => {
    const [m] = await tx.select().from(measurement).where(eq(measurement.id, input.measurementId));
    if (!m) return null;
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, input.tenantId));
    const cfg = parseEstimateConfig((t?.settings as { estimate?: unknown })?.estimate);

    const book = (await tx.select().from(priceBookItem).where(eq(priceBookItem.active, true))) as unknown as EnginePriceBookItem[];
    const areas = measurementAreasSchema.parse(m.areas);
    const { lineItems, wastePctUsed, pitchTierApplied } = generateEstimateLineItems({
      areas, priceBook: book, defaultWastePct: cfg.defaultWastePct, pitchTiers: cfg.steepPitchTiers,
    });
    const totals = computeEstimateTotals(lineItems, cfg.taxRateBps);

    const [row] = await tx.insert(estimate).values({
      tenantId: input.tenantId, jobId: input.jobId, source: "roofr", status: "draft",
      lineItems, subtotal: totals.subtotalCents, tax: totals.taxCents, total: totals.totalCents,
      measurementId: input.measurementId, wastePctUsed, pitchTierApplied,
    }).returning();
    return row;
  });
}

export async function setEstimateStatus(input: { tenantId: string; estimateId: string; status: "draft" | "sent" | "accepted"; docusealSubmissionId?: string }) {
  return withTenant(input.tenantId, async (tx) => {
    const set: Record<string, unknown> = { status: input.status };
    if (input.status === "sent") set.sentAt = sql`now()`;
    if (input.status === "accepted") set.acceptedAt = sql`now()`;
    if (input.docusealSubmissionId) set.docusealSubmissionId = input.docusealSubmissionId;
    const [row] = await tx.update(estimate).set(set).where(and(eq(estimate.tenantId, input.tenantId), eq(estimate.id, input.estimateId))).returning();
    return row;
  });
}
```

Add to `packages/db/src/index.ts`: `export { createEstimateFromMeasurement, setEstimateStatus } from "./lifecycle/estimate";`.

- [ ] **Step 4: Run, verify pass** — `pnpm test create-estimate` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/lifecycle/estimate.ts packages/db/src/index.ts packages/db/tests/create-estimate.test.ts packages/db/tests/helpers.ts
git commit -m "feat(db): create estimate from measurement + status transitions"
```

## Task 14: Roofr order workflow

**Files:**
- Create: `packages/agents/src/functions/roofr-order.ts`
- Modify: `packages/agents/src/index.ts`
- Test: `packages/agents/src/functions/roofr-order.test.ts`

Read `packages/agents/src/functions/qbo-sync.ts` first for the gateway-injection (optional param defaulting to the real gateway) + step pattern.

- [ ] **Step 1: Implement** `packages/agents/src/functions/roofr-order.ts`:

```ts
import { withTenant, eq, measurement, property } from "@savvy/db";
import type { RoofrGateway } from "@savvy/integrations";
import { nangoRoofr } from "@savvy/integrations";
import { inngest } from "../client";

export const roofrOrderMeasurement = inngest.createFunction(
  { id: "roofr-order-measurement", concurrency: { limit: 10 }, retries: 3 },
  { event: "roofr/order.requested" },
  async ({ event, step }) => {
    const { tenantId, jobId, propertyId } = event.data;
    const qbo = nangoRoofr; // gateway (named for clarity)

    const order = await step.run("order", async () =>
      withTenant(tenantId, async (tx) => {
        const [p] = await tx.select().from(property).where(eq(property.id, propertyId));
        return roofrOrder(qbo, p?.address ?? "");
      }),
    );

    // Poll up to ~5 attempts with backoff; fake returns ready immediately.
    let report = await step.run("report-0", () => qbo.getReport(order.orderId));
    for (let i = 1; i <= 4 && !report.ready; i++) {
      await step.sleep(`wait-${i}`, "30s");
      report = await step.run(`report-${i}`, () => qbo.getReport(order.orderId));
    }
    if (!report.ready) return { pending: true, orderId: order.orderId };

    const measurementId = await step.run("persist", async () =>
      withTenant(tenantId, async (tx) => {
        const [m] = await tx.insert(measurement).values({
          tenantId, propertyId, provider: "roofr", reportUrl: report.reportUrl,
          areas: report.areas, pitch: report.areas.predominantPitch, costCents: report.costCents,
        }).returning();
        return m.id;
      }),
    );
    await step.sendEvent("emit-ready", { name: "measurement/ready", data: { tenantId, jobId, measurementId } });
    return { measurementId };
  },
);

async function roofrOrder(g: RoofrGateway, address: string) {
  return g.orderMeasurement({ address });
}
```

> Verify `step.sendEvent` is the Inngest helper used elsewhere (check `drip.ts`/`qbo-sync.ts`); if the repo emits via `inngest.send` inside a `step.run` instead, match that.

- [ ] **Step 2: Test** `roofr-order.test.ts` — refactor the function to accept an optional gateway param (default `nangoRoofr`) like `qbo-sync.ts` does, then drive it with `makeFakeRoofr()` via the agents test harness (mirror `qbo-sync.test.ts`). Assert: a `measurement` row is created with `costCents` including the $3 markup, and `measurement/ready` is emitted.

- [ ] **Step 3: Register** `roofrOrderMeasurement` in `packages/agents/src/index.ts` (import, re-export, append to `functions`).

- [ ] **Step 4: Run** — `pnpm test roofr-order`; `pnpm typecheck && pnpm lint` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/functions/roofr-order.ts packages/agents/src/functions/roofr-order.test.ts packages/agents/src/index.ts
git commit -m "feat(agents): roofr order workflow -> persist measurement -> emit ready"
```

## Task 15: Estimate-generation workflow (+ AI upsell)

**Files:**
- Create: `packages/agents/src/functions/estimate-generate.ts`
- Modify: `packages/agents/src/index.ts`
- Test: `packages/agents/src/functions/estimate-generate.test.ts`

- [ ] **Step 1: Implement** `packages/agents/src/functions/estimate-generate.ts`:

```ts
import { withTenant, eq, createEstimateFromMeasurement, estimate, measurement, priceBookItem } from "@savvy/db";
import { completeObject } from "@savvy/ai";
import { z } from "@savvy/core";
import { inngest } from "../client";

const upsellSchema = z.object({
  suggestions: z.array(z.object({
    name: z.string(), reason: z.string(), unitPriceCents: z.number().int().min(0), quantity: z.number().min(0),
  })),
});

export const generateEstimateOnMeasurement = inngest.createFunction(
  { id: "generate-estimate-on-measurement", concurrency: { limit: 10 }, retries: 2 },
  { event: "measurement/ready" },
  async ({ event, step }) => {
    const { tenantId, jobId, measurementId } = event.data;

    const est = await step.run("generate", () => createEstimateFromMeasurement({ tenantId, jobId, measurementId }));
    if (!est) return { skipped: "no_measurement" };

    // AI upsells via the gateway capability — suggestions only, NOT added to totals.
    const upsells = await step.run("upsell", async () => {
      const [m] = await withTenant(tenantId, (tx) => tx.select().from(measurement).where(eq(measurement.id, measurementId)));
      const upgrades = await withTenant(tenantId, (tx) => tx.select().from(priceBookItem).where(eq(priceBookItem.category, "upgrade")));
      try {
        const { object } = await completeObject({
          capability: "reason",
          schema: upsellSchema,
          system: "You are a roofing sales assistant. Suggest 0-3 optional upgrade line items a rep could offer. Never include core roof items already estimated.",
          prompt: `Roof measurement: ${JSON.stringify(m?.areas)}. Available upgrade catalog: ${JSON.stringify(upgrades.map((u) => ({ name: u.name, unitPriceCents: u.unitPriceCents })))}.`,
        });
        return object.suggestions;
      } catch { return []; }
    });

    await step.run("save-upsells", () =>
      withTenant(tenantId, (tx) => tx.update(estimate).set({ upsellSuggestions: upsells }).where(eq(estimate.id, est.id))),
    );
    return { estimateId: est.id, upsells: upsells.length };
  },
);
```

> Confirm `z` is re-exported from `@savvy/core` (it should be — app code imports `z` from there per Conventions). If not, `import { z } from "zod";` and note the exception.

- [ ] **Step 2: Test** `estimate-generate.test.ts` — drive via the agents harness with a seeded tenant (price book + a measurement). Stub the AI by setting `LITELLM_BASE_URL` to the e2e ai-stub OR assert the `catch → []` path keeps the estimate valid. Assert an `estimate` row exists in `draft` with `total > 0`.

- [ ] **Step 3: Register** in `packages/agents/src/index.ts`.

- [ ] **Step 4: Run** — `pnpm test estimate-generate`; `pnpm typecheck && pnpm lint` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/functions/estimate-generate.ts packages/agents/src/functions/estimate-generate.test.ts packages/agents/src/index.ts
git commit -m "feat(agents): generate estimate on measurement + AI upsell suggestions"
```

## Task 16: Estimate queries + actions

**Files:**
- Create: `apps/web/src/lib/estimate-queries.ts`, `apps/web/src/lib/estimate-actions.ts`

- [ ] **Step 1: Queries** `estimate-queries.ts` (`server-only`, mirror `commission-queries.ts`):

```ts
import "server-only";
import { withTenant, estimate, measurement, eq, desc } from "@savvy/db";
import { getTenantId } from "./tenant";

export async function listEstimatesForJob(jobId: string) {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx.select().from(estimate).where(eq(estimate.jobId, jobId)).orderBy(desc(estimate.createdAt)),
  );
}

export async function getEstimate(estimateId: string) {
  const tenantId = await getTenantId();
  const [row] = await withTenant(tenantId, (tx) => tx.select().from(estimate).where(eq(estimate.id, estimateId)));
  return row ?? null;
}

export async function getMeasurementForJob(jobId: string) {
  const tenantId = await getTenantId();
  const [row] = await withTenant(tenantId, (tx) => tx.select().from(measurement).where(eq(measurement.id, jobId)).limit(1));
  return row ?? null;
}
```

- [ ] **Step 2: Actions** `estimate-actions.ts` (mirror `finance-actions.ts` for the `inngest.send` + `revalidatePath` shape):

```ts
"use server";
import { withTenant, estimate, eq, computeEstimateTotalsRow } from "@savvy/db"; // see note
import { computeEstimateTotals } from "@savvy/core";
import { inngest } from "@savvy/agents";
import { getTenantId } from "./tenant";
import { revalidatePath } from "next/cache";

export async function orderMeasurementAction(jobId: string, propertyId: string) {
  const tenantId = await getTenantId();
  try { await inngest.send({ name: "roofr/order.requested", data: { tenantId, jobId, propertyId } }); } catch (e) { console.error(e); }
  revalidatePath(`/jobs/${jobId}`);
}

export async function updateEstimateLineItemsAction(input: { estimateId: string; jobId: string; lineItems: { amountCents: number }[]; taxRateBps: number }) {
  const tenantId = await getTenantId();
  const totals = computeEstimateTotals(input.lineItems, input.taxRateBps);
  await withTenant(tenantId, (tx) => tx.update(estimate).set({ lineItems: input.lineItems, subtotal: totals.subtotalCents, tax: totals.taxCents, total: totals.totalCents }).where(eq(estimate.id, input.estimateId)));
  revalidatePath(`/jobs/${input.jobId}/estimates/${input.estimateId}`);
}

export async function sendEstimateAction(estimateId: string, jobId: string) {
  const tenantId = await getTenantId();
  try { await inngest.send({ name: "estimate/send.requested", data: { tenantId, estimateId } }); } catch (e) { console.error(e); }
  revalidatePath(`/jobs/${jobId}/estimates/${estimateId}`);
}
```

> Remove the bogus `computeEstimateTotalsRow` import — only `computeEstimateTotals` from `@savvy/core` is used. (Left here intentionally as the one thing to delete; engineer confirms imports compile.)

- [ ] **Step 3: Typecheck** — `pnpm --filter @savvy/web typecheck` → PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/estimate-queries.ts apps/web/src/lib/estimate-actions.ts
git commit -m "feat(web): estimate queries + order/update/send actions"
```

## Task 17: Estimates section on job + estimate editor page

**Files:**
- Modify: `apps/web/src/app/(app)/jobs/[id]/page.tsx`
- Create: `apps/web/src/app/(app)/jobs/[id]/estimates/[estimateId]/page.tsx`, `EstimateEditor.tsx`

- [ ] **Step 1: Job page section** — in `jobs/[id]/page.tsx`, add an **Estimates** card: an "Order measurement" button (calls `orderMeasurementAction(jobId, propertyId)`), the latest `measurement` summary if present, a "Generate estimate" button (only enabled when a measurement exists — calls a small action that `inngest.send`s `measurement/ready`, OR a server action calling `createEstimateFromMeasurement` directly for instant feedback), and a list of estimates (`listEstimatesForJob`) linking to the editor with a status badge. Mirror the existing job-detail card markup.

> Recommended: generate synchronously via a server action wrapping `createEstimateFromMeasurement` so the rep sees the estimate immediately; the AI upsell still runs async off `measurement/ready` when ordered through Roofr. Pick one and keep it consistent.

- [ ] **Step 2: Editor page** `jobs/[id]/estimates/[estimateId]/page.tsx` (`force-dynamic`): load `getEstimate` + tenant `estimate` settings; render `<EstimateEditor/>`.

- [ ] **Step 3: Editor client** `EstimateEditor.tsx` — editable line-item table (qty, unit price, amount), add/remove rows, a panel listing `upsellSuggestions` with an "Add" button that appends to line items, live totals via `computeEstimateTotals`, a "Save" button (`updateEstimateLineItemsAction`) and a "Send for signature" button (`sendEstimateAction`) with a status badge + sign link when `docusealSubmissionId` is set. `data-testid="estimate-editor"`, line rows `data-testid="estimate-line"`, total `data-testid="estimate-total"`.

- [ ] **Step 4: Build check** — `pnpm --filter @savvy/web typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(app)/jobs/[id]/page.tsx" "apps/web/src/app/(app)/jobs/[id]/estimates"
git commit -m "feat(web): estimates section + estimate editor"
```

---

# Wave D — E-sign

## Task 18: `DocusealGateway` (real + fake)

**Files:**
- Create: `packages/integrations/src/docuseal.ts`
- Modify: `packages/integrations/src/index.ts`
- Test: `packages/integrations/src/docuseal.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect } from "vitest";
import { makeFakeDocuseal } from "./docuseal";

describe("makeFakeDocuseal", () => {
  it("creates a submission and parses a completed event", async () => {
    const ds = makeFakeDocuseal();
    const { submissionId, signUrl } = await ds.createSubmission({ estimateId: "e1", signerEmail: "x@y.com", total: 500000 });
    expect(submissionId).toMatch(/^ds_sub_/);
    expect(signUrl).toContain(submissionId);
    const ev = ds.parseEvent({ event_type: "form.completed", data: { submission_id: submissionId } });
    expect(ev).toEqual({ submissionId, status: "completed" });
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm test docuseal` → FAIL.

- [ ] **Step 3: Implement** `packages/integrations/src/docuseal.ts`:

```ts
export interface DocusealGateway {
  createSubmission(o: { estimateId: string; signerEmail: string; total: number }): Promise<{ submissionId: string; signUrl: string }>;
  parseEvent(payload: unknown): { submissionId: string; status: "completed" | "other" } | null;
}

const BASE = () => process.env.DOCUSEAL_BASE_URL ?? "https://api.docuseal.com";

export const httpDocuseal: DocusealGateway = {
  async createSubmission({ estimateId, signerEmail }) {
    const res = await fetch(`${BASE()}/submissions`, {
      method: "POST",
      headers: { "X-Auth-Token": process.env.DOCUSEAL_API_KEY ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ template_id: process.env.DOCUSEAL_TEMPLATE_ID, send_email: true, submitters: [{ role: "Customer", email: signerEmail, metadata: { estimateId } }] }),
    });
    if (!res.ok) throw new Error(`docuseal create -> ${res.status}`);
    const j = (await res.json()) as Array<{ submission_id?: number; slug?: string }>;
    const submissionId = String(j[0]?.submission_id ?? "");
    return { submissionId, signUrl: `${BASE()}/s/${j[0]?.slug ?? submissionId}` };
  },
  parseEvent(payload) {
    const p = payload as { event_type?: string; data?: { submission_id?: string | number } };
    const submissionId = String(p.data?.submission_id ?? "");
    if (!submissionId) return null;
    return { submissionId, status: p.event_type === "form.completed" ? "completed" : "other" };
  },
};

export function makeFakeDocuseal(): DocusealGateway & { calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    async createSubmission() { const submissionId = `ds_sub_${++n}`; calls.push(submissionId); return { submissionId, signUrl: `https://docuseal.test/s/${submissionId}` }; },
    parseEvent(payload) {
      const p = payload as { event_type?: string; data?: { submission_id?: string } };
      const submissionId = String(p.data?.submission_id ?? "");
      if (!submissionId) return null;
      return { submissionId, status: p.event_type === "form.completed" ? "completed" : "other" };
    },
  };
}
```

Add `export { httpDocuseal, makeFakeDocuseal, type DocusealGateway } from "./docuseal";` to `packages/integrations/src/index.ts`.

- [ ] **Step 4: Run, verify pass** — `pnpm test docuseal` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/integrations/src/docuseal.ts packages/integrations/src/index.ts packages/integrations/src/docuseal.test.ts
git commit -m "feat(integrations): DocusealGateway (real + fake)"
```

## Task 19: Send-for-signature + accepted→approved workflows

**Files:**
- Create: `packages/agents/src/functions/estimate-sign.ts`
- Modify: `packages/agents/src/index.ts`
- Test: `packages/agents/src/functions/estimate-sign.test.ts`

- [ ] **Step 1: Implement** `packages/agents/src/functions/estimate-sign.ts`:

```ts
import { withTenant, eq, setEstimateStatus, recordStageChange, estimate, job, customer } from "@savvy/db";
import { httpDocuseal } from "@savvy/integrations";
import { inngest } from "../client";

export const sendEstimateForSignature = inngest.createFunction(
  { id: "send-estimate-for-signature", concurrency: { limit: 10 }, retries: 3 },
  { event: "estimate/send.requested" },
  async ({ event, step }) => {
    const { tenantId, estimateId } = event.data;
    return step.run("create-submission", async () =>
      withTenant(tenantId, async (tx) => {
        const [est] = await tx.select().from(estimate).where(eq(estimate.id, estimateId));
        if (!est || est.status === "accepted") return { skipped: true };
        const [j] = await tx.select().from(job).where(eq(job.id, est.jobId));
        const [cust] = j?.customerId ? await tx.select().from(customer).where(eq(customer.id, j.customerId)) : [undefined];
        const { submissionId } = await httpDocuseal.createSubmission({ estimateId, signerEmail: cust?.email ?? "", total: est.total ?? 0 });
        await setEstimateStatus({ tenantId, estimateId, status: "sent", docusealSubmissionId: submissionId });
        return { submissionId };
      }),
    );
  },
);

export const estimateAcceptedAdvanceJob = inngest.createFunction(
  { id: "estimate-accepted-advance-job", concurrency: { limit: 10 } },
  { event: "estimate/accepted" },
  async ({ event, step }) => {
    const { tenantId, estimateId } = event.data;
    return step.run("advance", async () =>
      withTenant(tenantId, async (tx) => {
        const [est] = await tx.select().from(estimate).where(eq(estimate.id, estimateId));
        if (!est) return { skipped: "no_estimate" };
        await setEstimateStatus({ tenantId, estimateId, status: "accepted" });
        const [j] = await tx.select().from(job).where(eq(job.id, est.jobId));
        if (j && j.stage !== "approved") {
          await tx.update(job).set({ stage: "approved", valueEstimate: est.total ?? null }).where(eq(job.id, j.id));
          await recordStageChange({ tenantId, jobId: j.id, fromStage: j.stage, toStage: "approved" });
        }
        return { jobId: est.jobId };
      }),
    );
  },
);
```

> Confirm the `recordStageChange` signature against `packages/db/src/lifecycle/record-stage-change.ts` and adjust args. If it must run in its own tenant tx, call it after the update outside the select tx.

- [ ] **Step 2: Test** `estimate-sign.test.ts` — harness: seed tenant + job (stage `estimate`) + a draft estimate; fire `estimate/accepted`; assert estimate `accepted` and job `approved`. For send: assert `setEstimateStatus(..., "sent")` ran and `docusealSubmissionId` set (inject `makeFakeDocuseal` by refactoring to accept an optional gateway param defaulting to `httpDocuseal`).

- [ ] **Step 3: Register** both functions in `packages/agents/src/index.ts`.

- [ ] **Step 4: Run** — `pnpm test estimate-sign`; `pnpm typecheck && pnpm lint` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/functions/estimate-sign.ts packages/agents/src/functions/estimate-sign.test.ts packages/agents/src/index.ts
git commit -m "feat(agents): send for signature + accepted->approved workflows"
```

## Task 20: DocuSeal webhook route

**Files:**
- Create: `apps/web/src/app/api/docuseal/webhook/route.ts`

Mirror `apps/web/src/app/api/stripe/webhook/route.ts` for the adminDb tenant resolution + `inngest.send` pattern (static route, no Clerk).

- [ ] **Step 1: Implement** `route.ts`:

```ts
import { NextResponse } from "next/server";
import { adminDb, estimate, eq } from "@savvy/db";
import { httpDocuseal } from "@savvy/integrations";
import { inngest } from "@savvy/agents";

export async function POST(req: Request) {
  const payload = await req.json();
  const ev = httpDocuseal.parseEvent(payload);
  if (!ev || ev.status !== "completed") return NextResponse.json({ ok: true });
  // Tenant comes from the estimate row matched by submissionId (adminDb — RLS root resolution).
  const [est] = await adminDb.select().from(estimate).where(eq(estimate.docusealSubmissionId, ev.submissionId));
  if (!est) return NextResponse.json({ ok: true });
  try { await inngest.send({ name: "estimate/accepted", data: { tenantId: est.tenantId, estimateId: est.id } }); } catch (e) { console.error(e); }
  return NextResponse.json({ ok: true });
}
```

> If DocuSeal signs webhooks, add signature verification before trusting the payload (the spec notes `verifyWebhook`; add it when wiring real creds). For the phase, the e2e posts a synthetic `form.completed`.

- [ ] **Step 2: Typecheck** — `pnpm --filter @savvy/web typecheck` → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/docuseal/webhook/route.ts
git commit -m "feat(web): docuseal webhook -> emit estimate/accepted"
```

---

# Wave Gate — isolation, e2e, env

## Task 21: Extend RLS isolation test for `price_book_item`

**Files:**
- Modify: `packages/db/tests/isolation.test.ts`

- [ ] **Step 1: Add a case** following the existing per-table pattern: insert a `price_book_item` under tenant A, set the session to tenant B (`savvy_app` role, `app.tenant_id` = B), assert the select returns zero rows.

- [ ] **Step 2: Run** — `pnpm test isolation` → PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/db/tests/isolation.test.ts
git commit -m "test(db): RLS isolation covers price_book_item"
```

## Task 22: e2e — full chain + final gate + PR

**Files:**
- Create: `apps/web/tests/e2e/estimate.spec.ts`
- Modify: `.env.example` (add `NANGO_ROOFR_INTEGRATION_ID`, `DOCUSEAL_TEMPLATE_ID` if used)

Reuse the 5B harness (`TEST_MODE=1`, `INNGEST_DEV=1`, ai-stub, inngest-cli dev, `create-tenant.ts`). Mirror `finance.spec.ts` + `comms.spec.ts`.

- [ ] **Step 1: Write the e2e** covering:
  1. Seed (adminDb): set `tenant.settings.estimate` (tax + waste); create user + customer (email) + property + job at stage `estimate`; insert a `measurement` row (areas + `8/12` pitch) for the property.
  2. Trigger generation: `inngest.send({ name: "measurement/ready", data: { tenantId, jobId, measurementId } })`; poll for a `draft` estimate; assert `total > 0` and field-shingle waste applied (assert a known line amount).
  3. Navigate to the editor; assert `estimate-total` visible; edit a line and Save; assert the total updates.
  4. Send: `inngest.send({ name: "estimate/send.requested", ... })`; poll for `status = sent` + `docusealSubmissionId`.
  5. POST a synthetic `form.completed` to `/api/docuseal/webhook` with that submission id; poll for estimate `accepted` and job stage `approved`.

- [ ] **Step 2: Run the e2e** per the recipe; verify PASS. Kill dev servers after (`pkill -f ai-stub.mjs; pkill -f inngest-cli; pkill -f "next dev"`).

- [ ] **Step 3: Env + full static gate**

```bash
# append to .env.example if referenced by code:
# NANGO_ROOFR_INTEGRATION_ID=roofr
# DOCUSEAL_TEMPLATE_ID=
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Expected: all green.

- [ ] **Step 4: Commit + push + PR**

```bash
git add apps/web/tests/e2e/estimate.spec.ts .env.example
git commit -m "test(e2e): estimate full chain — measurement -> estimate -> sign -> approved"
git push -u origin HEAD
gh pr create --title "Phase 7: Measurement & retail estimate" \
  --body "Implements the Phase 7 spec: price book (built-in rules + per-tenant overrides), deterministic estimate engine (waste field-shingles-only, contractor pitch tiers), AI upsell via gateway, Roofr ordering + DocuSeal e-sign (fake-first), estimate editor, accepted->approved. See docs/superpowers/specs/2026-06-15-phase7-measurement-estimate-design.md."
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §2 data model (price_book_item, estimate columns, settings.estimate, enums) → Tasks 1–4. ✅
- §3 engine (measurement schema, pitch, generate, totals) → Tasks 6–8. ✅
- §3 waste-only-field-shingles + labor-only pitch surcharge invariants → Task 7 tests. ✅
- §4 gateways (Roofr, DocuSeal real+fake) → Tasks 12, 18. ✅
- §5 events + 4 workflows → Tasks 5, 14, 15, 19. ✅
- §6 web (webhook, actions, price-book UI, estimates section, editor) → Tasks 10, 11, 16, 17, 20. ✅
- price book built-in + per-tenant override + lazy seed → Tasks 9, 10. ✅
- AI upsell via gateway, excluded from totals → Task 15 (+ `upsellSuggestions` column Task 4). ✅
- §7 testing (unit, db, agents, RLS, e2e) → inline + Tasks 21, 22. ✅
- §8 DoD (RLS, durable+idempotent, gateway AI, tests, env, one PR) → Tasks 21–22. ✅

**Engineer verifications flagged inline** (confirm against live code, don't guess): `helpers.ts` tenant/job/property helper names (Tasks 4, 13); `step.sendEvent` vs `inngest.send` in workflows (Task 14); `z` re-export from `@savvy/core` (Task 15); `recordStageChange` signature (Task 19); the bogus `computeEstimateTotalsRow` import to delete (Task 16); whether `estimate` generation should be sync-on-click or event-driven (Task 17 — pick one).

**Type consistency:** `EnginePriceBookItem` (Task 7) ⊇ the `priceBookItem` row columns (Task 4) and `DEFAULT_PRICE_BOOK` items (Task 9). `generateEstimateLineItems` output → consumed by `computeEstimateTotals` (Task 8) and `createEstimateFromMeasurement` (Task 13). `EstimateConfig.steepPitchTiers` (Task 2) → `pitchTier`/engine (Tasks 6, 7). Event payloads (Task 5) match all `inngest.send` call sites (Tasks 14, 16, 19, 20). ✅
