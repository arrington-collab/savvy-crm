# Lead Enrichment & Hybrid Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture leads with structured/auto-formatted contact + address data, enrich them best-effort from the StormProof backend (county-assessor year built + NOAA storm history), and replace the opaque LLM-only score with an explainable hybrid (rules + grounded AI) score plus a storm-driven install/upsell recommendation.

**Architecture:** Extend the existing `lead/created` → `lead-intake` Inngest workflow. Pure, unit-tested functions live in `@savvy/core` (phone, scoring, recommendation, feature extraction). External calls go through a new `@savvy/integrations` StormProof gateway (real + fake, env-selected) and the existing `@savvy/ai` capability gateway. The web form gains Google Places autocomplete + structured fields; the lead detail surfaces the enriched facts, score factors, and recommendation.

**Tech Stack:** Next.js 16 (App Router) · Drizzle/Postgres (RLS) · Inngest · `@savvy/ai` (LiteLLM/Anthropic capability gateway) · zod · Google Maps JS (Places) · Vitest + Playwright.

**Reference spec:** `docs/superpowers/specs/2026-06-23-lead-enrichment-scoring-design.md`

**Conventions in this repo (read before starting):**
- Source files use **no `.js` extension** on imports (Turbopack). `@savvy/core`/`@savvy/db` re-export through `src/index.ts` (`export *`).
- Run one unit test file: `pnpm vitest run <path>`. Run all: `pnpm test`. Typecheck: `pnpm --filter @savvy/<pkg> typecheck`. Lint: `pnpm --filter @savvy/<pkg> lint`.
- apps/web is **Playwright-only** (vitest workspace = `packages/*`). Do NOT add vitest to apps/web. Keep web query helpers thin/untested; put testable logic in `@savvy/core`.
- e2e: `pnpm --filter @savvy/web exec playwright test tests/e2e/<file>`. AI is stubbed by `apps/web/tests/e2e/ai-stub.mjs` (request-aware).
- A green typecheck/lint/unit gate can still be runtime-broken — run a local prod build (`pnpm --filter @savvy/web build`) before the PR; CI never does.

---

## SLICE A — Address form + structured intake + phone formatting

### Task A1: `normalizePhone` + `formatPhoneDisplay` (pure)

**Files:**
- Create: `packages/core/src/phone.ts`
- Test: `packages/core/src/phone.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./phone";`)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/phone.test.ts
import { describe, it, expect } from "vitest";
import { normalizePhone, formatPhoneDisplay } from "./phone";

describe("normalizePhone", () => {
  it("normalizes a 10-digit US number", () => {
    expect(normalizePhone("4805551234")).toBe("+14805551234");
  });
  it("strips formatting characters", () => {
    expect(normalizePhone("(480) 555-1234")).toBe("+14805551234");
    expect(normalizePhone("480.555.1234")).toBe("+14805551234");
    expect(normalizePhone(" 480 555 1234 ")).toBe("+14805551234");
  });
  it("handles 11-digit numbers starting with 1", () => {
    expect(normalizePhone("14805551234")).toBe("+14805551234");
    expect(normalizePhone("1 (480) 555-1234")).toBe("+14805551234");
  });
  it("passes through valid E.164", () => {
    expect(normalizePhone("+14805551234")).toBe("+14805551234");
    expect(normalizePhone("+447911123456")).toBe("+447911123456");
  });
  it("rejects garbage / too-short / too-long", () => {
    expect(normalizePhone("555")).toBeNull();
    expect(normalizePhone("abc")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("123456789012345678")).toBeNull();
  });
});

describe("formatPhoneDisplay", () => {
  it("formats US E.164 to (xxx) xxx-xxxx", () => {
    expect(formatPhoneDisplay("+14805551234")).toBe("(480) 555-1234");
  });
  it("returns non-US E.164 unchanged", () => {
    expect(formatPhoneDisplay("+447911123456")).toBe("+447911123456");
  });
  it("returns empty string for empty input", () => {
    expect(formatPhoneDisplay("")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/phone.test.ts`
Expected: FAIL ("Failed to resolve import './phone'").

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/phone.ts

/**
 * Normalize any common phone format to E.164.
 * US-centric: 10 digits -> +1XXXXXXXXXX, 11 digits starting with 1 -> +1...,
 * a leading "+" with 7-15 digits passes through. Returns null if it cannot
 * be normalized to a valid-length number.
 */
export function normalizePhone(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (hasPlus) {
    // already international; validate length 7-15 (E.164)
    return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** E.164 -> friendly display. US numbers become (480) 555-1234; others unchanged. */
export function formatPhoneDisplay(e164: string): string {
  if (!e164) return "";
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
```

Then add to `packages/core/src/index.ts`:

```ts
export * from "./phone";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/phone.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/phone.ts packages/core/src/phone.test.ts packages/core/src/index.ts
git commit -m "feat(core): add normalizePhone + formatPhoneDisplay"
```

---

### Task A2: Extend `leadIntakeSchema` — phone transform + optional structured fields

**Files:**
- Modify: `packages/core/src/schemas.ts`
- Test: `packages/core/src/schemas.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/schemas.test.ts
import { describe, it, expect } from "vitest";
import { leadIntakeSchema } from "./schemas";

describe("leadIntakeSchema", () => {
  const base = { name: "Jane", phone: "(480) 555-1234", address: "1 Main St, Mesa AZ" };

  it("normalizes phone to E.164 on parse", () => {
    const r = leadIntakeSchema.parse(base);
    expect(r.phone).toBe("+14805551234");
  });
  it("rejects an unparseable phone", () => {
    expect(leadIntakeSchema.safeParse({ ...base, phone: "555" }).success).toBe(false);
  });
  it("defaults source to web and leaves optional fields undefined", () => {
    const r = leadIntakeSchema.parse(base);
    expect(r.source).toBe("web");
    expect(r.city).toBeUndefined();
    expect(r.roofType).toBeUndefined();
  });
  it("accepts the structured optional fields", () => {
    const r = leadIntakeSchema.parse({
      ...base, city: "Mesa", state: "AZ", zip: "85201", county: "Maricopa",
      lat: 33.4, lng: -111.8, roofType: "tile", yearBuilt: 2004,
    });
    expect(r.state).toBe("AZ");
    expect(r.roofType).toBe("tile");
    expect(r.yearBuilt).toBe(2004);
  });
  it("rejects an out-of-range yearBuilt", () => {
    expect(leadIntakeSchema.safeParse({ ...base, yearBuilt: 1500 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/schemas.test.ts`
Expected: FAIL (phone stays `(480) 555-1234`, optional fields rejected as unknown keys are stripped — assertions fail).

- [ ] **Step 3: Write minimal implementation**

Replace the `phone` const and `leadIntakeSchema` in `packages/core/src/schemas.ts`:

```ts
import { z } from "zod";
import { normalizePhone } from "./phone";

export { z };

// Accept any common format; normalize to E.164. Adds an issue if unparseable.
const phone = z.string().transform((v, ctx) => {
  const n = normalizePhone(v);
  if (!n) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid phone number" });
    return z.NEVER;
  }
  return n;
});

const roofType = z.enum(["asphalt_shingle", "tile", "metal", "flat_foam", "other"]);

export const leadIntakeSchema = z.object({
  name: z.string().min(1).max(120),
  phone,
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
export type LeadIntakeInput = z.infer<typeof leadIntakeSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/schemas.test.ts`
Expected: PASS (5 tests). Also run `pnpm vitest run packages/core` to confirm no regression in dependent tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/schemas.ts packages/core/src/schemas.test.ts
git commit -m "feat(core): phone transform + optional structured fields on leadIntakeSchema"
```

---

### Task A3: Extend `property` + `lead` schema and generate migration

**Files:**
- Modify: `packages/db/src/schema/crm.ts`
- Generated: `packages/db/drizzle/0015_*.sql` + `meta/_journal.json` + `meta/0015_snapshot.json`

- [ ] **Step 1: Add columns to the schema**

In `packages/db/src/schema/crm.ts`, add to `property` (after `city`):

```ts
  line1: text("line1"),
  state: text("state"),
  zip: text("zip"),
  county: text("county"),
  roofType: text("roof_type"),
```

And add to `lead` (after `scoreReason`):

```ts
  scoreFeatures: jsonb("score_features"),
  installRecommendation: jsonb("install_recommendation"),
```

Add `jsonb` to the drizzle import at the top of the file:

```ts
import { pgTable, uuid, text, integer, doublePrecision, boolean, index, jsonb } from "drizzle-orm/pg-core";
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: creates `packages/db/drizzle/0015_<name>.sql` with `ALTER TABLE "property" ADD COLUMN ...` and `ALTER TABLE "lead" ADD COLUMN ...`, updates `meta/_journal.json`, writes `meta/0015_snapshot.json`. All new columns nullable (no NOT NULL, no default needed).

- [ ] **Step 3: Apply the migration locally**

Run: `pnpm db:migrate` (local docker `savvy_db` must be up: `docker compose up -d`)
Expected: "migrations applied"; no error.

- [ ] **Step 4: Verify the generated SQL only adds nullable columns**

Run: `cat packages/db/drizzle/0015_*.sql`
Expected: only `ADD COLUMN` statements for the 7 new columns; no `NOT NULL`, no data migration, no RLS change.

- [ ] **Step 5: Commit (include ALL drizzle metadata)**

```bash
git add packages/db/src/schema/crm.ts packages/db/drizzle
git status   # confirm _journal.json + 0015_snapshot.json + 0015_*.sql are staged
git commit -m "feat(db): add structured address + roofType to property; scoreFeatures + installRecommendation to lead (0015)"
```

---

### Task A4: Persist new fields in `createLeadForTenant`

**Files:**
- Modify: `apps/web/src/lib/intake.ts`
- Test: `packages/db`-style integration test is not possible here (intake.ts lives in apps/web). Instead add an integration test for the underlying inserts in `packages/db`. Create: `packages/db/src/__tests__/lead-property-fields.test.ts`

> Note: `createLeadForTenant` is thin web glue (untested per repo convention). We test the DB write path it relies on with a focused integration test that mirrors its inserts.

- [ ] **Step 1: Write the failing integration test**

```ts
// packages/db/src/__tests__/lead-property-fields.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { adminDb, withTenant, tenant, customer, property, lead, eq } from "../index";

describe("property structured fields persist", () => {
  let tenantId: string;
  beforeAll(async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "T", clerkOrgId: `org_${Date.now()}` }).returning();
    tenantId = t!.id;
  });

  it("stores line1/state/zip/county/roofType + yearBuilt on property", async () => {
    const row = await withTenant(tenantId, async (tx) => {
      const [c] = await tx.insert(customer).values({ tenantId, name: "Jane" }).returning();
      const [p] = await tx.insert(property).values({
        tenantId, customerId: c!.id, address: "1 Main St, Mesa AZ 85201",
        line1: "1 Main St", city: "Mesa", state: "AZ", zip: "85201", county: "Maricopa",
        roofType: "tile", yearBuilt: 2004, lat: 33.4, lng: -111.8,
      }).returning();
      return p!;
    });
    expect(row.state).toBe("AZ");
    expect(row.roofType).toBe("tile");
    expect(row.yearBuilt).toBe(2004);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/db/src/__tests__/lead-property-fields.test.ts`
Expected: FAIL only if columns are missing — but A3 added them, so this should PASS once the migration is applied. If it FAILS with "column does not exist", re-run `pnpm db:migrate`. (This task's real change is in intake.ts below; the test guards the schema contract.)

- [ ] **Step 3: Wire the fields into `createLeadForTenant`**

In `apps/web/src/lib/intake.ts`, update the `property` insert (line ~23) to pass the new optional fields:

```ts
const [p] = await tx.insert(property).values({
  tenantId,
  customerId: c!.id,
  address: input.address,
  line1: input.line1 ?? null,
  city: input.city ?? parseCityFromAddress(input.address),
  state: input.state ?? null,
  zip: input.zip ?? null,
  county: input.county ?? null,
  lat: input.lat ?? null,
  lng: input.lng ?? null,
  roofType: input.roofType ?? null,
  yearBuilt: input.yearBuilt ?? null,
}).returning();
```

(`LeadIntakeInput` already carries these from Task A2; no other change needed.)

- [ ] **Step 4: Run typecheck + the test**

Run: `pnpm --filter @savvy/web typecheck && pnpm vitest run packages/db/src/__tests__/lead-property-fields.test.ts`
Expected: typecheck clean; test PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/intake.ts packages/db/src/__tests__/lead-property-fields.test.ts
git commit -m "feat(intake): persist structured address + roof/year on lead creation"
```

---

### Task A5: `AddressAutocomplete` component (Google Places, graceful)

**Files:**
- Create: `apps/web/src/components/AddressAutocomplete.tsx`

- [ ] **Step 1: Implement the component**

```tsx
// apps/web/src/components/AddressAutocomplete.tsx
"use client";
import { useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";

export type ParsedAddress = {
  line1: string; city: string; state: string; zip: string; county: string;
  lat?: number; lng?: number; formatted: string;
};

declare global {
  interface Window { google?: any; __savvyPlacesLoading?: Promise<void>; }
}

const KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

function loadPlaces(): Promise<void> {
  if (typeof window === "undefined" || !KEY) return Promise.reject(new Error("no key"));
  if (window.google?.maps?.places) return Promise.resolve();
  if (!window.__savvyPlacesLoading) {
    window.__savvyPlacesLoading = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${KEY}&libraries=places`;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("places load failed"));
      document.head.appendChild(s);
    });
  }
  return window.__savvyPlacesLoading;
}

function parse(place: any): ParsedAddress {
  const get = (type: string, short = false) => {
    const c = place.address_components?.find((x: any) => x.types.includes(type));
    return c ? (short ? c.short_name : c.long_name) : "";
  };
  const streetNo = get("street_number");
  const route = get("route");
  return {
    line1: [streetNo, route].filter(Boolean).join(" "),
    city: get("locality") || get("sublocality") || get("postal_town"),
    state: get("administrative_area_level_1", true),
    zip: get("postal_code"),
    county: get("administrative_area_level_2"),
    lat: place.geometry?.location?.lat?.(),
    lng: place.geometry?.location?.lng?.(),
    formatted: place.formatted_address ?? "",
  };
}

export function AddressAutocomplete({
  value, onChange, onPick, id = "address",
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (a: ParsedAddress) => void;
  id?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let ac: any;
    loadPlaces()
      .then(() => {
        if (!ref.current || !window.google) return;
        ac = new window.google.maps.places.Autocomplete(ref.current, {
          types: ["address"], componentRestrictions: { country: "us" },
          fields: ["address_components", "geometry", "formatted_address"],
        });
        ac.addListener("place_changed", () => {
          const place = ac.getPlace();
          if (place?.address_components) onPick(parse(place));
        });
      })
      .catch(() => { /* no key / offline -> plain input, still works */ });
    return () => { if (ac && window.google) window.google.maps.event.clearInstanceListeners(ac); };
  }, [onPick]);

  return (
    <Input
      ref={ref}
      id={id}
      name={id}
      data-testid="address-autocomplete"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Start typing an address…"
      autoComplete="off"
      required
    />
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @savvy/web typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/AddressAutocomplete.tsx
git commit -m "feat(web): AddressAutocomplete (Google Places, degrades to plain input)"
```

---

### Task A6: Rebuild `NewLeadForm` — structured fields, optional roof/year, as-you-type phone

**Files:**
- Modify: `apps/web/src/app/(app)/leads/new/NewLeadForm.tsx`

- [ ] **Step 1: Replace the form**

```tsx
"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { normalizePhone, formatPhoneDisplay } from "@savvy/core";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AddressAutocomplete, type ParsedAddress } from "@/components/AddressAutocomplete";
import { createLead } from "@/lib/lead-actions";

const ROOF_TYPES = [
  { v: "", label: "— select (optional) —" },
  { v: "asphalt_shingle", label: "Asphalt shingle" },
  { v: "tile", label: "Tile" },
  { v: "metal", label: "Metal" },
  { v: "flat_foam", label: "Flat / foam" },
  { v: "other", label: "Other" },
];

export function NewLeadForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [parts, setParts] = useState<Partial<ParsedAddress>>({});
  const [source, setSource] = useState("manual");
  const [roofType, setRoofType] = useState("");
  const [yearBuilt, setYearBuilt] = useState("");

  function onPhoneChange(raw: string) {
    // format as-you-type when it looks like a complete US number, else show raw
    const n = normalizePhone(raw);
    setPhone(n ? formatPhoneDisplay(n) : raw);
  }
  function onPick(a: ParsedAddress) {
    setAddress(a.formatted);
    setParts(a);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const res = await createLead({
        name, phone, address, source,
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

  return (
    <Card className="max-w-lg p-6">
      <form onSubmit={submit} className="space-y-4" data-testid="new-lead-form">
        <div className="space-y-1.5">
          <Label htmlFor="name">Customer name</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone</Label>
          <Input id="phone" value={phone} onChange={(e) => onPhoneChange(e.target.value)}
                 placeholder="(480) 555-1234" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="address">Property address</Label>
          <AddressAutocomplete value={address} onChange={setAddress} onPick={onPick} />
        </div>
        {(parts.city || parts.state) && (
          <p className="text-xs text-muted-foreground" data-testid="address-parts">
            {[parts.city, parts.state, parts.zip].filter(Boolean).join(", ")}
            {parts.county ? ` · ${parts.county} County` : ""}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="roofType">Roof type (optional)</Label>
            <select id="roofType" data-testid="roof-type"
                    className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                    value={roofType} onChange={(e) => setRoofType(e.target.value)}>
              {ROOF_TYPES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="yearBuilt">Year built (optional)</Label>
            <Input id="yearBuilt" data-testid="year-built" type="number" inputMode="numeric"
                   value={yearBuilt} onChange={(e) => setYearBuilt(e.target.value)} placeholder="e.g. 2004" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="source">Source</Label>
          <Input id="source" value={source} onChange={(e) => setSource(e.target.value)} />
        </div>
        <Button type="submit" disabled={pending} data-testid="new-lead-submit">
          {pending ? "Creating…" : "Create lead"}
        </Button>
      </form>
    </Card>
  );
}
```

- [ ] **Step 2: Confirm the `createLead` action forwards the new fields**

In `apps/web/src/lib/lead-actions.ts`, `createLead(input: unknown)` already passes `input` to `leadIntakeSchema.safeParse` then `createLeadForTenant`. No change needed — the schema (A2) now accepts the optional fields. Verify by reading the action; if it destructures a fixed field set, widen it to pass `parsed.data` through (it already does).

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/leads/new/NewLeadForm.tsx"
git commit -m "feat(web): structured address + optional roof/year + as-you-type phone on new-lead form"
```

---

### Task A7: e2e — new-lead form creates a lead with structured data

**Files:**
- Create: `apps/web/tests/e2e/lead-capture.spec.ts`

- [ ] **Step 1: Write the e2e test** (Google Places is bypassed — type the address directly; structured parts come from manual fields/submit path)

```ts
// apps/web/tests/e2e/lead-capture.spec.ts
import { test, expect } from "@playwright/test";

test("create a lead with phone auto-format + optional roof/year", async ({ page }) => {
  await page.goto("/leads/new");
  await page.getByLabel("Customer name").fill("E2E Tester");
  const phone = page.getByLabel("Phone");
  await phone.fill("4805551234");
  await expect(phone).toHaveValue("(480) 555-1234"); // as-you-type formatting
  await page.getByTestId("address-autocomplete").fill("100 Test St, Mesa AZ 85201");
  await page.getByTestId("roof-type").selectOption("tile");
  await page.getByTestId("year-built").fill("2004");
  await page.getByTestId("new-lead-submit").click();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]+$/);
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @savvy/web exec playwright test tests/e2e/lead-capture.spec.ts`
Expected: PASS (TEST_MODE bypasses Clerk; the lead persists with phone `+14805551234`).

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/e2e/lead-capture.spec.ts
git commit -m "test(e2e): new-lead form phone formatting + structured fields"
```

---

### Task A8: `DEFAULT_LEAD_SOURCES` + `mergeLeadSources` (pure)

**Files:**
- Create: `packages/core/src/lead-sources.ts`
- Test: `packages/core/src/lead-sources.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/lead-sources.test.ts
import { describe, it, expect } from "vitest";
import { DEFAULT_LEAD_SOURCES, mergeLeadSources } from "./lead-sources";

describe("lead sources", () => {
  it("ships a non-empty default list including referral", () => {
    expect(DEFAULT_LEAD_SOURCES.length).toBeGreaterThan(5);
    expect(DEFAULT_LEAD_SOURCES.some((s) => s.value === "referral")).toBe(true);
  });
  it("appends custom sources, skipping case-insensitive duplicates", () => {
    const merged = mergeLeadSources(["Home Show", "REFERRAL", "Home Show"]);
    const values = merged.map((s) => s.value);
    expect(values).toContain("Home Show");
    expect(values.filter((v) => v.toLowerCase() === "home show").length).toBe(1); // deduped
    expect(values.filter((v) => v.toLowerCase() === "referral").length).toBe(1); // not duplicated vs default
  });
  it("handles null/undefined custom list", () => {
    expect(mergeLeadSources(null).length).toBe(DEFAULT_LEAD_SOURCES.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/lead-sources.test.ts`
Expected: FAIL (unresolved import).

- [ ] **Step 3: Implement**

```ts
// packages/core/src/lead-sources.ts
export type LeadSource = { value: string; label: string };

export const DEFAULT_LEAD_SOURCES: LeadSource[] = [
  { value: "referral", label: "Referral" },
  { value: "repeat", label: "Repeat / past customer" },
  { value: "door_knock", label: "Door knock" },
  { value: "storm_canvass", label: "Storm canvassing" },
  { value: "website", label: "Website" },
  { value: "google", label: "Google" },
  { value: "facebook", label: "Facebook" },
  { value: "yard_sign", label: "Yard sign" },
  { value: "carrier", label: "Insurance carrier" },
  { value: "other", label: "Other" },
];

/** defaults + tenant-added sources (value=label for customs), case-insensitive dedupe. */
export function mergeLeadSources(custom: string[] | null | undefined): LeadSource[] {
  const seen = new Set(DEFAULT_LEAD_SOURCES.map((s) => s.value.toLowerCase()));
  const extra: LeadSource[] = [];
  for (const c of custom ?? []) {
    const v = (c ?? "").trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    extra.push({ value: v, label: v });
  }
  return [...DEFAULT_LEAD_SOURCES, ...extra];
}
```

Add `export * from "./lead-sources";` to `packages/core/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/lead-sources.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/lead-sources.ts packages/core/src/lead-sources.test.ts packages/core/src/index.ts
git commit -m "feat(core): DEFAULT_LEAD_SOURCES + mergeLeadSources"
```

---

### Task A9: Tenant lead-source store + `LeadSourceSelect` + form wiring

**Files:**
- Create: `packages/db/src/lifecycle/lead-sources.ts`
- Test: `packages/db/src/__tests__/lead-sources.test.ts`
- Modify: `packages/db/src/index.ts` (export the two helpers)
- Create: `apps/web/src/lib/lead-source-actions.ts`
- Create: `apps/web/src/components/LeadSourceSelect.tsx`
- Modify: `apps/web/src/app/(app)/leads/new/page.tsx` (server-fetch sources)
- Modify: `apps/web/src/app/(app)/leads/new/NewLeadForm.tsx` (use the select)

- [ ] **Step 1: Write the failing DB integration test**

```ts
// packages/db/src/__tests__/lead-sources.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { adminDb, tenant, eq } from "../index";
import { addLeadSource, getCustomLeadSources } from "../lifecycle/lead-sources";

describe("tenant lead sources", () => {
  let tenantId: string;
  beforeAll(async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "T", clerkOrgId: `org_${Date.now()}`, settings: { onboarding: { done: true } } }).returning();
    tenantId = t!.id;
  });

  it("appends a source and preserves sibling settings", async () => {
    const after = await addLeadSource(tenantId, "Home Show");
    expect(after).toContain("Home Show");
    const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
    expect((t!.settings as any).onboarding.done).toBe(true); // sibling preserved
    expect(await getCustomLeadSources(tenantId)).toContain("Home Show");
  });

  it("dedupes case-insensitively", async () => {
    await addLeadSource(tenantId, "Home Show");
    await addLeadSource(tenantId, "HOME SHOW");
    const list = await getCustomLeadSources(tenantId);
    expect(list.filter((s) => s.toLowerCase() === "home show").length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/db/src/__tests__/lead-sources.test.ts`
Expected: FAIL (unresolved import).

- [ ] **Step 3: Implement the DB helpers**

```ts
// packages/db/src/lifecycle/lead-sources.ts
import { adminDb } from "../admin-client";
import { tenant } from "../schema/tenancy";
import { eq } from "drizzle-orm";

export async function getCustomLeadSources(tenantId: string): Promise<string[]> {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const ls = (t?.settings as { leadSources?: unknown } | null)?.leadSources;
  return Array.isArray(ls) ? (ls as string[]) : [];
}

export async function addLeadSource(tenantId: string, source: string): Promise<string[]> {
  const clean = source.trim();
  if (!clean) throw new Error("empty source");
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const settings = (t?.settings ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(settings.leadSources) ? (settings.leadSources as string[]) : [];
  if (existing.some((s) => s.toLowerCase() === clean.toLowerCase())) return existing;
  const updated = [...existing, clean];
  await adminDb.update(tenant).set({ settings: { ...settings, leadSources: updated } }).where(eq(tenant.id, tenantId));
  return updated;
}
```

Add to `packages/db/src/index.ts`:

```ts
export { addLeadSource, getCustomLeadSources } from "./lifecycle/lead-sources";
```

(Confirm the actual import paths for `adminDb`/`tenant`/`eq` match other files in `lifecycle/` — e.g. mirror `lifecycle/onboarding.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/db/src/__tests__/lead-sources.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit the store**

```bash
git add packages/db/src/lifecycle/lead-sources.ts packages/db/src/__tests__/lead-sources.test.ts packages/db/src/index.ts
git commit -m "feat(db): tenant lead-source store (add/get, preserves siblings)"
```

- [ ] **Step 6: Add the server action**

```ts
// apps/web/src/lib/lead-source-actions.ts
"use server";
import { addLeadSource } from "@savvy/db";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";

export async function addLeadSourceAction(
  source: string,
): Promise<{ ok: true; sources: string[] } | { error: string }> {
  const clean = (source ?? "").trim();
  if (!clean) return { error: "Source cannot be empty" };
  try {
    const tenantId = await getTenantId();
    const sources = await addLeadSource(tenantId, clean);
    revalidatePath("/leads/new");
    return { ok: true, sources };
  } catch {
    return { error: "Could not add source" };
  }
}
```

- [ ] **Step 7: Build `LeadSourceSelect`**

```tsx
// apps/web/src/components/LeadSourceSelect.tsx
"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { mergeLeadSources, type LeadSource } from "@savvy/core";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { addLeadSourceAction } from "@/lib/lead-source-actions";

export function LeadSourceSelect({ value, onChange, initialCustom }: {
  value: string; onChange: (v: string) => void; initialCustom: string[];
}) {
  const [custom, setCustom] = useState<string[]>(initialCustom);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, start] = useTransition();
  const options: LeadSource[] = mergeLeadSources(custom);

  function add() {
    const v = draft.trim();
    if (!v) return;
    start(async () => {
      const res = await addLeadSourceAction(v);
      if ("error" in res) { toast.error(res.error); return; }
      setCustom(res.sources);
      onChange(v);
      setDraft(""); setAdding(false);
      toast.success("Source added");
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <select data-testid="lead-source" value={value} onChange={(e) => onChange(e.target.value)}
                className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm">
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <Button type="button" variant="outline" data-testid="lead-source-add-toggle"
                onClick={() => setAdding((a) => !a)}>+ Add</Button>
      </div>
      {adding && (
        <div className="flex gap-2">
          <Input data-testid="lead-source-new" value={draft} onChange={(e) => setDraft(e.target.value)}
                 placeholder="New source name" />
          <Button type="button" disabled={pending} data-testid="lead-source-save" onClick={add}>
            {pending ? "…" : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Server-fetch sources in the page + pass to the form**

In `apps/web/src/app/(app)/leads/new/page.tsx` (server component), fetch the custom list and pass it:

```tsx
import { getCustomLeadSources } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";
import { NewLeadForm } from "./NewLeadForm";

export default async function NewLeadPage() {
  const tenantId = await getTenantId();
  const initialCustomSources = await getCustomLeadSources(tenantId);
  return <NewLeadForm initialCustomSources={initialCustomSources} />;
}
```

(Keep any existing page heading/layout wrapper that's already there.)

- [ ] **Step 9: Swap the source field in `NewLeadForm`**

In `NewLeadForm.tsx`: accept the prop, default the source, and replace the source `<Input>` with the select:

```tsx
import { LeadSourceSelect } from "@/components/LeadSourceSelect";
// signature: export function NewLeadForm({ initialCustomSources }: { initialCustomSources: string[] }) {
// state: const [source, setSource] = useState("referral");
// replace the Source field block with:
//   <div className="space-y-1.5">
//     <Label htmlFor="source">Source</Label>
//     <LeadSourceSelect value={source} onChange={setSource} initialCustom={initialCustomSources} />
//   </div>
```

- [ ] **Step 10: Typecheck, lint, e2e (add-source path)**

Append to `apps/web/tests/e2e/lead-capture.spec.ts`:

```ts
test("can add a new lead source inline and select it", async ({ page }) => {
  await page.goto("/leads/new");
  await page.getByTestId("lead-source-add-toggle").click();
  await page.getByTestId("lead-source-new").fill("Home Show");
  await page.getByTestId("lead-source-save").click();
  await expect(page.getByTestId("lead-source")).toHaveValue("Home Show");
});
```

Run: `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint && pnpm --filter @savvy/web exec playwright test tests/e2e/lead-capture.spec.ts`
Expected: clean + PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/lib/lead-source-actions.ts apps/web/src/components/LeadSourceSelect.tsx "apps/web/src/app/(app)/leads/new/page.tsx" "apps/web/src/app/(app)/leads/new/NewLeadForm.tsx" apps/web/tests/e2e/lead-capture.spec.ts
git commit -m "feat(web): managed lead-source dropdown with inline add"
```

---

## SLICE B — StormProof enrichment

### Task B1: StormProof gateway (interface + real + fake + env factory)

**Files:**
- Create: `packages/integrations/src/stormproof.ts`
- Modify: `packages/integrations/src/index.ts`
- Test: `packages/integrations/src/stormproof.test.ts`

- [ ] **Step 1: Write the failing test** (fake gateway behavior)

```ts
// packages/integrations/src/stormproof.test.ts
import { describe, it, expect } from "vitest";
import { makeFakeStormProof } from "./stormproof";

describe("makeFakeStormProof", () => {
  it("returns deterministic year built + a storm event", async () => {
    const sp = makeFakeStormProof();
    const prop = await sp.getProperty({ lat: 33.4, lng: -111.8, address: "1 Main St" });
    expect(prop?.yearBuilt).toBeTypeOf("number");
    const storms = await sp.lookupStorms({ lat: 33.4, lng: -111.8, months: 12 });
    expect(storms.eventCount).toBeGreaterThanOrEqual(0);
    expect(storms).toHaveProperty("maxHailInches");
    expect(sp.calls.length).toBe(2);
  });
  it("getProperty returns null without lat/lng", async () => {
    const sp = makeFakeStormProof();
    expect(await sp.getProperty({ address: "1 Main St" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/integrations/src/stormproof.test.ts`
Expected: FAIL (import unresolved).

- [ ] **Step 3: Implement the gateway**

```ts
// packages/integrations/src/stormproof.ts

export type StormEvent = { date: string; eventType: "hail" | "wind"; size?: number; windMph?: number; id?: string };
export type PropertyData = { yearBuilt: number | null; roofAge: number | null; roofType: string | null; county: string | null; supported: boolean };
export type StormSummary = {
  events: StormEvent[]; eventCount: number;
  maxHailInches: number; maxWindMph: number;
  daysSinceWorst: number | null; worstEventId: string | null;
};

export interface StormProofGateway {
  getProperty(o: { lat?: number; lng?: number; address?: string }): Promise<PropertyData | null>;
  lookupStorms(o: { lat?: number; lng?: number; address?: string; months?: number }): Promise<StormSummary>;
}

const BASE = () => process.env.STORMPROOF_API_BASE ?? "";
const headers = (): Record<string, string> => {
  const k = process.env.STORMPROOF_API_KEY;
  return k ? { "x-api-key": k } : {};
};

const EMPTY_STORMS: StormSummary = { events: [], eventCount: 0, maxHailInches: 0, maxWindMph: 0, daysSinceWorst: null, worstEventId: null };

export const httpStormProof: StormProofGateway = {
  async getProperty({ lat, lng, address }) {
    if (lat == null || lng == null) return null; // endpoint does not geocode
    try {
      const u = new URL(`${BASE()}/api/property`);
      u.searchParams.set("lat", String(lat));
      u.searchParams.set("lng", String(lng));
      if (address) u.searchParams.set("address", address);
      const res = await fetch(u, { headers: headers() });
      if (!res.ok) return null;
      const d = (await res.json()) as any;
      return {
        yearBuilt: d.yearBuilt ?? null,
        roofAge: d.roofAge ?? (d.yearBuilt ? new Date().getFullYear() - d.yearBuilt : null),
        roofType: d.roofType ?? null,
        county: d.county ?? null,
        supported: Boolean(d.supported),
      };
    } catch { return null; }
  },
  async lookupStorms({ lat, lng, address, months = 12 }) {
    try {
      const u = new URL(`${BASE()}/api/storms/lookup`);
      if (lat != null && lng != null) {
        u.searchParams.set("lat", String(lat));
        u.searchParams.set("lng", String(lng));
      } else if (address) {
        u.searchParams.set("location", address);
      } else { return EMPTY_STORMS; }
      u.searchParams.set("months", String(months));
      const res = await fetch(u, { headers: headers() });
      if (!res.ok) return EMPTY_STORMS;
      const d = (await res.json()) as any;
      return summarize((d.events ?? []) as StormEvent[]);
    } catch { return EMPTY_STORMS; }
  },
};

// pure summarizer — re-used by feature extraction tests in @savvy/core via its own copy;
// kept here because it shapes the gateway's return.
function summarize(events: StormEvent[]): StormSummary {
  if (events.length === 0) return EMPTY_STORMS;
  let maxHailInches = 0, maxWindMph = 0, worst: StormEvent | null = null, worstScore = -1;
  for (const e of events) {
    const hail = e.eventType === "hail" ? e.size ?? 0 : 0;
    const wind = e.eventType === "wind" ? e.windMph ?? 0 : 0;
    maxHailInches = Math.max(maxHailInches, hail);
    maxWindMph = Math.max(maxWindMph, wind);
    const score = hail * 10 + wind;
    if (score > worstScore) { worstScore = score; worst = e; }
  }
  const daysSinceWorst = worst?.date ? Math.floor((Date.now() - Date.parse(worst.date)) / 86_400_000) : null;
  return { events, eventCount: events.length, maxHailInches, maxWindMph, daysSinceWorst, worstEventId: worst?.id ?? null };
}

export function makeFakeStormProof(): StormProofGateway & { calls: { op: string }[] } {
  const calls: { op: string }[] = [];
  return {
    calls,
    async getProperty({ lat, lng }) {
      calls.push({ op: "getProperty" });
      if (lat == null || lng == null) return null;
      return { yearBuilt: 2004, roofAge: new Date().getFullYear() - 2004, roofType: null, county: "Maricopa", supported: true };
    },
    async lookupStorms() {
      calls.push({ op: "lookupStorms" });
      return summarize([{ date: "2026-05-01", eventType: "hail", size: 1.5, id: "evt_fake_1" }]);
    },
  };
}

export const stormProof: StormProofGateway = process.env.STORMPROOF_API_BASE ? httpStormProof : makeFakeStormProof();
```

Add to `packages/integrations/src/index.ts`:

```ts
export { stormProof, httpStormProof, makeFakeStormProof, type StormProofGateway, type StormEvent, type PropertyData, type StormSummary } from "./stormproof";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/integrations/src/stormproof.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/integrations/src/stormproof.ts packages/integrations/src/stormproof.test.ts packages/integrations/src/index.ts
git commit -m "feat(integrations): StormProof gateway (property + storm lookup, real+fake)"
```

---

### Task B2: `LeadFeatures` type + `buildLeadFeatures` (pure, in core)

**Files:**
- Create: `packages/core/src/lead-features.ts`
- Test: `packages/core/src/lead-features.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/lead-features.test.ts
import { describe, it, expect } from "vitest";
import { buildLeadFeatures } from "./lead-features";

const storm = { events: [], eventCount: 1, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 30, worstEventId: "e1" };

describe("buildLeadFeatures", () => {
  it("computes roof age from year built", () => {
    const f = buildLeadFeatures({ source: "referral", state: "AZ", phone: "+14805551234",
      roofType: "tile", yearBuilt: 2004, storm });
    expect(f.roofAgeYears).toBe(new Date().getFullYear() - 2004);
    expect(f.inTerritory).toBe(true);
    expect(f.hasContact).toBe(true);
    expect(f.storm.maxHailInches).toBe(1.5);
  });
  it("handles missing year/state/contact", () => {
    const f = buildLeadFeatures({ source: "web", state: null, phone: "",
      roofType: null, yearBuilt: null, storm });
    expect(f.roofAgeYears).toBeNull();
    expect(f.inTerritory).toBe(false);
    expect(f.hasContact).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/lead-features.test.ts`
Expected: FAIL (unresolved import).

- [ ] **Step 3: Implement**

```ts
// packages/core/src/lead-features.ts
export type StormFeature = {
  eventCount: number; maxHailInches: number; maxWindMph: number; daysSinceWorst: number | null;
};

export type LeadFeatures = {
  source: string;
  state: string | null;
  inTerritory: boolean;
  hasContact: boolean;
  roofType: string | null;
  yearBuilt: number | null;
  roofAgeYears: number | null;
  storm: StormFeature;
};

export function buildLeadFeatures(input: {
  source: string;
  state: string | null;
  phone?: string | null;
  email?: string | null;
  roofType: string | null;
  yearBuilt: number | null;
  storm: StormFeature;
}): LeadFeatures {
  const year = input.yearBuilt;
  return {
    source: input.source,
    state: input.state,
    inTerritory: Boolean(input.state),
    hasContact: Boolean(input.phone || input.email),
    roofType: input.roofType,
    yearBuilt: year,
    roofAgeYears: year ? new Date().getFullYear() - year : null,
    storm: {
      eventCount: input.storm.eventCount,
      maxHailInches: input.storm.maxHailInches,
      maxWindMph: input.storm.maxWindMph,
      daysSinceWorst: input.storm.daysSinceWorst,
    },
  };
}
```

Add `export * from "./lead-features";` to `packages/core/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/lead-features.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/lead-features.ts packages/core/src/lead-features.test.ts packages/core/src/index.ts
git commit -m "feat(core): LeadFeatures + buildLeadFeatures"
```

---

### Task B3: `enrich-property` step in `lead-intake`

**Files:**
- Modify: `packages/agents/src/functions/lead-intake.ts`
- Test: `packages/agents/src/functions/lead-intake.test.ts` (add a case)

- [ ] **Step 1: Write the failing test** (enrichment fills year built via the fake gateway)

```ts
// add to packages/agents/src/functions/lead-intake.test.ts
import { describe, it, expect } from "vitest";
import { makeFakeStormProof } from "@savvy/integrations";
import { enrichProperty } from "./lead-intake";

describe("enrichProperty", () => {
  it("fills year built + storm summary when lat/lng present", async () => {
    const sp = makeFakeStormProof();
    const out = await enrichProperty(
      { lat: 33.4, lng: -111.8, address: "1 Main St", yearBuilt: null, roofType: null },
      sp,
    );
    expect(out.yearBuilt).toBe(2004);
    expect(out.storm.maxHailInches).toBe(1.5);
    expect(out.stormEventId).toBe("evt_fake_1");
  });
  it("keeps rep-entered year built (does not overwrite)", async () => {
    const sp = makeFakeStormProof();
    const out = await enrichProperty(
      { lat: 33.4, lng: -111.8, address: "1 Main St", yearBuilt: 1999, roofType: "tile" },
      sp,
    );
    expect(out.yearBuilt).toBe(1999);
    expect(out.roofType).toBe("tile");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/agents/src/functions/lead-intake.test.ts`
Expected: FAIL (`enrichProperty` not exported).

- [ ] **Step 3: Implement the exported pure-ish helper + wire it into the function**

Add to `packages/agents/src/functions/lead-intake.ts` (near `qualifyLead`):

```ts
import { stormProof as defaultStormProof, type StormProofGateway } from "@savvy/integrations";

export async function enrichProperty(
  input: { lat: number | null; lng: number | null; address: string; yearBuilt: number | null; roofType: string | null },
  sp: StormProofGateway = defaultStormProof,
): Promise<{ yearBuilt: number | null; roofType: string | null; county: string | null;
            storm: { eventCount: number; maxHailInches: number; maxWindMph: number; daysSinceWorst: number | null };
            stormEventId: string | null }> {
  let yearBuilt = input.yearBuilt;
  let roofType = input.roofType;
  let county: string | null = null;

  if (yearBuilt == null && input.lat != null && input.lng != null) {
    const prop = await sp.getProperty({ lat: input.lat, lng: input.lng, address: input.address });
    if (prop) {
      yearBuilt = prop.yearBuilt ?? yearBuilt;
      roofType = roofType ?? prop.roofType;
      county = prop.county;
    }
  }
  const storms = await sp.lookupStorms({
    lat: input.lat ?? undefined, lng: input.lng ?? undefined, address: input.address, months: 12,
  });
  return {
    yearBuilt, roofType, county,
    storm: { eventCount: storms.eventCount, maxHailInches: storms.maxHailInches, maxWindMph: storms.maxWindMph, daysSinceWorst: storms.daysSinceWorst },
    stormEventId: storms.worstEventId,
  };
}
```

Then in the `leadIntake` function body, after `load-lead`, read the property's lat/lng/yearBuilt/roofType (extend the `load-lead` select to include `property` columns: join `property` on `l.propertyId`), and add a step:

```ts
const enriched = await step.run("enrich-property", () =>
  enrichProperty({ lat: ctx.lat, lng: ctx.lng, address: ctx.address, yearBuilt: ctx.yearBuilt, roofType: ctx.roofType }),
);
// persist back onto property + lead.stormEventId
await withTenant(tenantId, async (tx) => {
  await tx.update(property).set({ yearBuilt: enriched.yearBuilt, roofType: enriched.roofType, county: enriched.county }).where(eq(property.id, ctx.propertyId));
  await tx.update(lead).set({ stormEventId: enriched.stormEventId }).where(eq(lead.id, leadId));
});
```

Update the `load-lead` step to return `{ name, phone, source, address, lat, lng, yearBuilt, roofType, propertyId, state }` by selecting from `property` (it currently hardcodes `address: "unknown"` — replace that with the real `property.address`, and add the new fields). Import `property` from `@savvy/db`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/agents/src/functions/lead-intake.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/functions/lead-intake.ts packages/agents/src/functions/lead-intake.test.ts
git commit -m "feat(agents): enrich-property step (StormProof year built + storm history)"
```

---

### Task B4: Document env

**Files:**
- Modify: `.env.example`, `.env.production.example`

- [ ] **Step 1: Add the new vars with comments**

Append to both files:

```bash
# Google Places (browser key, restricted to Places + your referrers) — address autocomplete
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=
# StormProof backend — lead enrichment (year built via county assessor + storm history).
# Unset = the fake gateway is used (dev/test). AZ counties only for year built.
STORMPROOF_API_BASE=
STORMPROOF_API_KEY=
```

- [ ] **Step 2: Commit**

```bash
git add .env.example .env.production.example
git commit -m "docs(env): NEXT_PUBLIC_GOOGLE_MAPS_API_KEY + STORMPROOF_* "
```

---

## SLICE C — Hybrid scoring

### Task C1: `scoreLeadBaseline` (pure, deterministic + factors)

**Files:**
- Create: `packages/core/src/lead-scoring.ts`
- Test: `packages/core/src/lead-scoring.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/lead-scoring.test.ts
import { describe, it, expect } from "vitest";
import { scoreLeadBaseline } from "./lead-scoring";
import type { LeadFeatures } from "./lead-features";

const f = (over: Partial<LeadFeatures> = {}): LeadFeatures => ({
  source: "web", state: "AZ", inTerritory: true, hasContact: true,
  roofType: null, yearBuilt: null, roofAgeYears: null,
  storm: { eventCount: 0, maxHailInches: 0, maxWindMph: 0, daysSinceWorst: null }, ...over,
});

describe("scoreLeadBaseline", () => {
  it("scores a referral higher than web (same everything else)", () => {
    expect(scoreLeadBaseline(f({ source: "referral" })).score)
      .toBeGreaterThan(scoreLeadBaseline(f({ source: "web" })).score);
  });
  it("adds points for recent significant hail", () => {
    const noStorm = scoreLeadBaseline(f()).score;
    const hail = scoreLeadBaseline(f({ storm: { eventCount: 1, maxHailInches: 2, maxWindMph: 0, daysSinceWorst: 5 } })).score;
    expect(hail).toBeGreaterThan(noStorm);
  });
  it("adds points for an old roof", () => {
    expect(scoreLeadBaseline(f({ roofAgeYears: 25 })).score)
      .toBeGreaterThan(scoreLeadBaseline(f({ roofAgeYears: 2 })).score);
  });
  it("clamps to 0..100 and returns labeled factors", () => {
    const r = scoreLeadBaseline(f({ source: "referral", roofAgeYears: 30,
      storm: { eventCount: 3, maxHailInches: 3, maxWindMph: 120, daysSinceWorst: 1 } }));
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.factors.every((x) => typeof x.label === "string" && typeof x.points === "number")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/lead-scoring.test.ts`
Expected: FAIL (unresolved import).

- [ ] **Step 3: Implement**

```ts
// packages/core/src/lead-scoring.ts
import type { LeadFeatures } from "./lead-features";

export type ScoreFactor = { label: string; points: number };
export type BaselineScore = { score: number; factors: ScoreFactor[] };

// Tunable weights (edit freely).
export const SCORE_WEIGHTS = {
  // keys align with DEFAULT_LEAD_SOURCES values (Task A8); looked up case-insensitively
  source: { referral: 18, repeat: 16, carrier: 14, storm_canvass: 14, google: 9,
            website: 8, web: 8, facebook: 7, door_knock: 8, yard_sign: 6,
            manual: 5, other: 5 } as Record<string, number>,
  sourceDefault: 5,
  hailMaxPoints: 30,
  windMaxPoints: 20,
  roofAgeMaxPoints: 20,
  inTerritory: 5,
  hasContact: 5,
  recencyHalfLifeDays: 60, // storm points decay; ~half at 60 days
};

function recencyFactor(days: number | null): number {
  if (days == null) return 0.5; // unknown recency -> half credit
  return Math.max(0, Math.min(1, Math.pow(0.5, days / SCORE_WEIGHTS.recencyHalfLifeDays)));
}

export function scoreLeadBaseline(f: LeadFeatures): BaselineScore {
  const factors: ScoreFactor[] = [];
  const add = (label: string, points: number) => { if (points !== 0) factors.push({ label, points: Math.round(points) }); };

  add(`source: ${f.source}`, SCORE_WEIGHTS.source[(f.source ?? "").toLowerCase()] ?? SCORE_WEIGHTS.sourceDefault);

  if (f.storm.maxHailInches > 0) {
    const sizeFrac = Math.min(1, f.storm.maxHailInches / 2); // 2"+ = full
    add(`hail ${f.storm.maxHailInches}" (${f.storm.daysSinceWorst ?? "?"}d ago)`,
        SCORE_WEIGHTS.hailMaxPoints * sizeFrac * recencyFactor(f.storm.daysSinceWorst));
  }
  if (f.storm.maxWindMph > 0) {
    const windFrac = Math.min(1, f.storm.maxWindMph / 100); // 100mph+ = full
    add(`wind ${f.storm.maxWindMph}mph`,
        SCORE_WEIGHTS.windMaxPoints * windFrac * recencyFactor(f.storm.daysSinceWorst));
  }
  if (f.roofAgeYears != null && f.roofAgeYears >= 15) {
    const ageFrac = Math.min(1, (f.roofAgeYears - 15) / 15); // 15->30 yrs ramps to full
    add(`roof ~${f.roofAgeYears} yrs old`, SCORE_WEIGHTS.roofAgeMaxPoints * ageFrac);
  }
  if (f.inTerritory) add("in territory", SCORE_WEIGHTS.inTerritory);
  if (f.hasContact) add("has contact info", SCORE_WEIGHTS.hasContact);

  const raw = factors.reduce((s, x) => s + x.points, 0);
  return { score: Math.max(0, Math.min(100, raw)), factors };
}
```

Add `export * from "./lead-scoring";` to `packages/core/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/lead-scoring.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/lead-scoring.ts packages/core/src/lead-scoring.test.ts packages/core/src/index.ts
git commit -m "feat(core): scoreLeadBaseline (deterministic factors)"
```

---

### Task C2: Replace the stub — hybrid score in `lead-intake`

**Files:**
- Modify: `packages/agents/src/functions/lead-intake.ts`
- Test: `packages/agents/src/functions/lead-intake.test.ts`

- [ ] **Step 1: Write the failing test** (hybrid scorer grounds on the baseline; injected AI)

```ts
// add to packages/agents/src/functions/lead-intake.test.ts
import { hybridScore } from "./lead-intake";
import { buildLeadFeatures } from "@savvy/core";

it("hybridScore stays within ±10 of baseline and returns a reason", async () => {
  const features = buildLeadFeatures({ source: "referral", state: "AZ", phone: "+14805551234",
    roofType: "tile", yearBuilt: 2004, storm: { eventCount: 1, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 5 } });
  const fakeAi = { completeObject: async () => ({ object: { score: 999, reason: "Referral + recent hail" }, model: "fake" }) };
  const r = await hybridScore(features, fakeAi as any);
  expect(r.reason).toContain("hail");
  expect(Math.abs(r.score - r.baseline)).toBeLessThanOrEqual(10); // clamps the AI's 999
  expect(r.factors.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/agents/src/functions/lead-intake.test.ts`
Expected: FAIL (`hybridScore` not exported).

- [ ] **Step 3: Implement `hybridScore` + swap it into the function**

Add to `packages/agents/src/functions/lead-intake.ts`:

```ts
import { z } from "@savvy/core";
import { scoreLeadBaseline, type LeadFeatures } from "@savvy/core";
import * as aiNS from "@savvy/ai";

const scoreSchema = z.object({ score: z.number().min(0).max(100), reason: z.string().max(200) });

export async function hybridScore(
  features: LeadFeatures,
  ai: Pick<typeof aiNS, "completeObject"> = aiNS,
): Promise<{ score: number; reason: string; baseline: number; factors: { label: string; points: number }[]; model: string }> {
  const { score: baseline, factors } = scoreLeadBaseline(features);
  const factorText = factors.map((f) => `${f.label} (+${f.points})`).join("; ") || "no strong signals";
  const { object, model } = await ai.completeObject({
    capability: "reasoning",
    schema: scoreSchema,
    system: "You refine a roofing lead score. A deterministic baseline and its factors are given. " +
      "Adjust the score only slightly (stay close to the baseline) and write a terse reason citing the factors. Do not invent facts.",
    prompt: `Baseline ${baseline}/100. Factors: ${factorText}. Source=${features.source}. ` +
      `Roof age=${features.roofAgeYears ?? "unknown"}. Return {score, reason}.`,
  });
  // ground the AI: clamp to ±10 of the deterministic baseline
  const score = Math.max(0, Math.min(100, Math.max(baseline - 10, Math.min(baseline + 10, object.score))));
  return { score, reason: object.reason, baseline, factors, model };
}
```

Replace the `ai-qualify` step's body: build features from `ctx` + `enriched`, call `hybridScore`, and persist `score`, `scoreReason`, `scoreFeatures` (JSON), plus keep `status: "contacted"` and the `recordAgentRun` (taskKey stays `lead.qualify`, `modelUsed: r.model`). Delete the old `qualifyLead` call path (keep `qualifyLead` exported only if other tests use it; otherwise remove). Persist:

```ts
await withTenant(tenantId, (tx) =>
  tx.update(lead).set({
    score: r.score, scoreReason: r.reason, status: "contacted",
    scoreFeatures: { features, baseline: r.baseline, factors: r.factors },
  }).where(eq(lead.id, leadId)),
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/agents/src/functions/lead-intake.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/functions/lead-intake.ts packages/agents/src/functions/lead-intake.test.ts
git commit -m "feat(agents): hybrid lead score (baseline + grounded AI), store scoreFeatures"
```

---

### Task C3: Surface enriched facts + score factors on lead detail

**Files:**
- Modify: `apps/web/src/lib/leads-queries.ts` (extend `getLeadDetail` to return `scoreFeatures`, property `yearBuilt`, `roofType`, `state`, `county`, storm summary, `installRecommendation`)
- Create: `apps/web/src/components/LeadEnrichmentCard.tsx`
- Modify: `apps/web/src/app/(app)/leads/[id]/page.tsx` (render the card)

- [ ] **Step 1: Extend the query**

In `getLeadDetail`, add to the select: `lead.scoreFeatures`, `lead.installRecommendation`, and the joined `property.yearBuilt / roofType / state / county`. Add them to the returned `LeadDetail` type.

- [ ] **Step 2: Build the card**

```tsx
// apps/web/src/components/LeadEnrichmentCard.tsx
import { Card } from "@/components/ui/card";

type Factor = { label: string; points: number };
export function LeadEnrichmentCard({ scoreFeatures, yearBuilt, roofType, county }: {
  scoreFeatures: { factors?: Factor[]; baseline?: number } | null;
  yearBuilt: number | null; roofType: string | null; county: string | null;
}) {
  const factors = scoreFeatures?.factors ?? [];
  return (
    <Card className="p-4 space-y-3" data-testid="lead-enrichment-card">
      <h3 className="text-sm font-semibold">Why this score</h3>
      <div className="text-xs text-muted-foreground">
        {[yearBuilt && `Built ${yearBuilt}`, roofType, county && `${county} County`].filter(Boolean).join(" · ") || "No enrichment yet"}
      </div>
      <ul className="space-y-1">
        {factors.map((f, i) => (
          <li key={i} className="flex justify-between text-sm">
            <span>{f.label}</span><span className="tabular-nums text-accent-gold">+{f.points}</span>
          </li>
        ))}
        {factors.length === 0 && <li className="text-sm text-muted-foreground">No factors recorded.</li>}
      </ul>
    </Card>
  );
}
```

- [ ] **Step 3: Render it on the detail page**

In `apps/web/src/app/(app)/leads/[id]/page.tsx`, import and render `<LeadEnrichmentCard scoreFeatures={lead.scoreFeatures} yearBuilt={lead.yearBuilt} roofType={lead.roofType} county={lead.county} />` near the score display.

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/leads-queries.ts apps/web/src/components/LeadEnrichmentCard.tsx "apps/web/src/app/(app)/leads/[id]/page.tsx"
git commit -m "feat(web): lead detail shows enrichment facts + score factor breakdown"
```

---

## SLICE D — Install / upsell recommendation

### Task D1: `deriveInstallRecommendation` + config (pure)

**Files:**
- Create: `packages/core/src/install-recommendation.ts`
- Test: `packages/core/src/install-recommendation.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/install-recommendation.test.ts
import { describe, it, expect } from "vitest";
import { deriveInstallRecommendation } from "./install-recommendation";
import type { LeadFeatures } from "./lead-features";

const f = (over: Partial<LeadFeatures> = {}): LeadFeatures => ({
  source: "web", state: "AZ", inTerritory: true, hasContact: true,
  roofType: null, yearBuilt: null, roofAgeYears: null,
  storm: { eventCount: 0, maxHailInches: 0, maxWindMph: 0, daysSinceWorst: null }, ...over,
});

describe("deriveInstallRecommendation", () => {
  it("recommends high-wind install for strong wind", () => {
    const r = deriveInstallRecommendation(f({ storm: { eventCount: 1, maxHailInches: 0, maxWindMph: 115, daysSinceWorst: 3 } }));
    expect(r.windRating).toBe("high");
    expect(r.suggestedProducts.join(" ")).toMatch(/high-wind|6-nail/i);
  });
  it("recommends Class 4 for hail >= 1 inch", () => {
    const r = deriveInstallRecommendation(f({ storm: { eventCount: 1, maxHailInches: 1.25, maxWindMph: 0, daysSinceWorst: 3 } }));
    expect(r.impactResistance).toBe("class4");
    expect(r.suggestedProducts.join(" ")).toMatch(/class 4/i);
  });
  it("returns standard with no products when no storm", () => {
    const r = deriveInstallRecommendation(f());
    expect(r.windRating).toBe("standard");
    expect(r.impactResistance).toBe("standard");
    expect(r.suggestedProducts).toEqual([]);
  });
  it("notes replacement framing for old roof + storm", () => {
    const r = deriveInstallRecommendation(f({ roofAgeYears: 22, storm: { eventCount: 1, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 3 } }));
    expect(r.rationale.toLowerCase()).toContain("replace");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/install-recommendation.test.ts`
Expected: FAIL (unresolved import).

- [ ] **Step 3: Implement**

```ts
// packages/core/src/install-recommendation.ts
import type { LeadFeatures } from "./lead-features";

export type InstallRecommendation = {
  windRating: "standard" | "high";
  impactResistance: "standard" | "class4";
  suggestedProducts: string[];
  rationale: string;
};

// Editable defaults — tune thresholds + product strings here.
export const RECOMMENDATION_CONFIG = {
  highWindMph: 110,
  highWindEventCount: 2,
  class4HailInches: 1.0,
  oldRoofYears: 18,
  products: {
    highWind: ["High-wind rated shingle", "6-nail install pattern", "Upgraded starter + ridge"],
    class4: ["Class 4 impact-resistant shingle (insurance-discount eligible)"],
  },
};

export function deriveInstallRecommendation(f: LeadFeatures): InstallRecommendation {
  const c = RECOMMENDATION_CONFIG;
  const products: string[] = [];
  const reasons: string[] = [];

  const highWind = f.storm.maxWindMph >= c.highWindMph || f.storm.eventCount >= c.highWindEventCount;
  if (highWind) {
    products.push(...c.products.highWind);
    reasons.push(`wind exposure (${f.storm.maxWindMph || "repeated events"})`);
  }
  const class4 = f.storm.maxHailInches >= c.class4HailInches;
  if (class4) {
    products.push(...c.products.class4);
    reasons.push(`hail history (${f.storm.maxHailInches}")`);
  }
  if (f.roofAgeYears != null && f.roofAgeYears >= c.oldRoofYears && (highWind || class4)) {
    reasons.push(`${f.roofAgeYears}-yr roof — frame as full replacement vs repair`);
  }

  return {
    windRating: highWind ? "high" : "standard",
    impactResistance: class4 ? "class4" : "standard",
    suggestedProducts: products,
    rationale: reasons.length ? reasons.join("; ") : "Standard install; no storm-driven upgrades indicated.",
  };
}
```

Add `export * from "./install-recommendation";` to `packages/core/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/install-recommendation.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/install-recommendation.ts packages/core/src/install-recommendation.test.ts packages/core/src/index.ts
git commit -m "feat(core): deriveInstallRecommendation + editable config"
```

---

### Task D2: Persist + surface the recommendation

**Files:**
- Modify: `packages/agents/src/functions/lead-intake.ts` (compute + persist `installRecommendation`)
- Modify: `apps/web/src/components/LeadEnrichmentCard.tsx` (render it)

- [ ] **Step 1: Compute + persist in the score step**

In `lead-intake.ts`, after building `features` (Task C2), also compute and store the recommendation in the same `withTenant` update:

```ts
import { deriveInstallRecommendation } from "@savvy/core";
// ...
const recommendation = deriveInstallRecommendation(features);
// add to the lead update set: installRecommendation: recommendation,
```

(Combine into the existing `tx.update(lead).set({ ... })` from C2 so there's one write.)

- [ ] **Step 2: Add a recommendation block to the card**

Extend `LeadEnrichmentCard` props with `installRecommendation` and render the chips + rationale when products exist:

```tsx
// add prop: installRecommendation: { windRating: string; impactResistance: string; suggestedProducts: string[]; rationale: string } | null;
{installRecommendation && installRecommendation.suggestedProducts.length > 0 && (
  <div className="space-y-1" data-testid="install-recommendation">
    <h3 className="text-sm font-semibold">Suggested install / upsell</h3>
    <div className="flex flex-wrap gap-1">
      {installRecommendation.suggestedProducts.map((p, i) => (
        <span key={i} className="rounded bg-accent-gold/15 px-2 py-0.5 text-xs">{p}</span>
      ))}
    </div>
    <p className="text-xs text-muted-foreground">{installRecommendation.rationale}</p>
  </div>
)}
```

Pass `installRecommendation={lead.installRecommendation}` from the detail page.

- [ ] **Step 3: Typecheck + run agents tests**

Run: `pnpm --filter @savvy/web typecheck && pnpm vitest run packages/agents/src/functions/lead-intake.test.ts`
Expected: clean + PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/functions/lead-intake.ts apps/web/src/components/LeadEnrichmentCard.tsx "apps/web/src/app/(app)/leads/[id]/page.tsx"
git commit -m "feat: store + surface storm-driven install/upsell recommendation"
```

---

### Task D3: e2e — enrichment + recommendation render on lead detail

**Files:**
- Create: `apps/web/tests/e2e/lead-enrichment.spec.ts`

> The fake StormProof gateway is active in e2e (no `STORMPROOF_API_BASE`), and `ai-stub.mjs` returns a `{score, reason}` for qualify requests. The fake returns a 1.5" hail event → expect a Class 4 chip.

- [ ] **Step 1: Write the e2e**

```ts
// apps/web/tests/e2e/lead-enrichment.spec.ts
import { test, expect } from "@playwright/test";

test("lead detail shows score factors + Class 4 recommendation after enrichment", async ({ page }) => {
  await page.goto("/leads/new");
  await page.getByLabel("Customer name").fill("Enrich Tester");
  await page.getByLabel("Phone").fill("4805550000");
  await page.getByTestId("address-autocomplete").fill("200 Storm Ave, Mesa AZ 85201");
  await page.getByTestId("new-lead-submit").click();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]+$/);

  // enrichment + scoring run via Inngest; poll the detail page for the card
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("lead-enrichment-card")).toBeVisible();
    await expect(page.getByTestId("install-recommendation")).toContainText(/Class 4/i);
  }).toPass({ timeout: 20_000 });
});
```

- [ ] **Step 2: Run it** (needs the Inngest dev server; Playwright `webServer` starts `next dev` — confirm the e2e harness also runs inngest, as other agent e2e do; if not, this test asserts the card after a `lead/created` is processed by the in-process dev handler)

Run: `pnpm --filter @savvy/web exec playwright test tests/e2e/lead-enrichment.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/e2e/lead-enrichment.spec.ts
git commit -m "test(e2e): lead enrichment card + recommendation"
```

---

## Final verification (before PR)

- [ ] **Whole gate:** `pnpm typecheck && pnpm lint && pnpm test`
- [ ] **Prod build (CI never runs this):** `pnpm --filter @savvy/web build`
- [ ] **e2e:** `pnpm --filter @savvy/web exec playwright test tests/e2e/lead-capture.spec.ts tests/e2e/lead-enrichment.spec.ts`
- [ ] **RLS still green:** run the existing tenant-isolation suite (`pnpm test` covers `packages/db` isolation tests).
- [ ] **Manual smoke (optional):** with `STORMPROOF_API_BASE` + `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` set locally, create a real AZ-address lead and confirm year built + storm + score factors populate.
- [ ] Open PR against `main`: `gh pr create --base main`.

## Self-review notes (spec coverage)

- Address autocomplete + split → A5/A6. No default state → A6 (no default in form). Optional roof/year → A6, schema A2. Phone normalize → A1/A2/A6. Managed lead sources + inline add → A8 (defaults/merge) + A9 (tenant store, action, `LeadSourceSelect`, form swap); A9 step 9 replaces A6's free-text source field. Scoring weights aligned to source values → C1. StormProof year built + storms → B1/B3. Roof-type-from-assessor (opportunistic) → B3 (`roofType ?? prop.roofType`). Multi-state caveat (AZ-only year built) → B3 (only fills when `getProperty` returns data). Hybrid score + grounding → C1/C2. scoreFeatures audit → C2/C3. Install/upsell recommendation + editable config → D1/D2. Surfacing → C3/D2. Tests at every layer → each task. Env → B4. Idempotency/best-effort → B3/C2 (steps overwrite deterministically; gateway returns null/empty on failure).
