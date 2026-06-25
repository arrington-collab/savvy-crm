# Phase B — Scoring + Lanes + Dedupe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework lead scoring into a weighted/banded/config-driven model, persist a `lead.lane` consumed by Stage 4, dedupe re-submitted leads non-destructively, and re-score open leads nightly when fresh storms hit.

**Architecture:** A pure `scoreLead(features, cfg)` in `@savvy/core` (weighted 47/33/20 storm/roof/source, bands, fit-gates, reasons) replaces the flat `scoreLeadBaseline`; `hybridScore` keeps the ±10 LLM refine (fail-open). A pure `deriveLane` sets `lead.lane`. `createLeadForTenant` attaches re-submissions to an existing customer/property on exact phone/email match. A nightly Inngest cron re-scores open leads and records an `agentRun` on band upgrade.

**Tech Stack:** TypeScript, Zod v3, Drizzle ORM, Next.js server actions, Inngest, Vitest, pnpm + Turborepo. Worktree `~/Sites/savvy-phaseb`, branch `feat/scoring-lanes`.

## Global Constraints

- **Deterministic** scoring/lane/dedupe math; the only LLM is the existing ±10 `hybridScore` refine, which **fails open** to the deterministic baseline.
- **Weights re-normalized to available signals:** storm 47 · roof 33 · source 20 (value + engagement dropped).
- **Bands:** hot ≥ 80 · warm 60–79 · cool 40–59 · cold < 40.
- **Storm severity** (÷100 → 0..1): hail ≥1.5″=100 · ≥1.0″=70 · ≥0.75″=40; wind ≥58=60 · ≥45=35. **Recency** (months): ≤6=1.00 · ≤12=0.85 · ≤18=0.55 · ≤24=0.30 · else 0. **+10%** if ≥2 events (cap 1.0).
- **Lane precedence:** storm → tile → standard.
- **Dedupe:** non-destructive; exact normalized phone OR email only; address-only never merges.
- **Unknown fields degrade NEUTRAL (not zero):** unknown roof age → 0.5; renter gate dormant (no occupancy data).
- **Config** in `tenant.settings.scoring` jsonb (zod-defaulted); **no secrets**; tenant isolation on every query; migration ships `.sql` + drizzle meta together.

**Local gate commands** (repo root `~/Sites/savvy-phaseb`):
- `cd packages/core && npx vitest run` — pure unit tests
- `pnpm typecheck` · `pnpm lint`
- DB-backed tests (dedupe, cron, ai-qualify persist) are **CI-gated**.

---

### Task 1: Rework scoring — `scoreLead` + config (`@savvy/core`)

**Files:**
- Modify: `packages/core/src/lead-scoring.ts`
- Modify: `packages/core/src/index.ts` (ensure new exports flow through the barrel)
- Test: `packages/core/src/lead-scoring.test.ts` (replace)

**Interfaces:**
- Consumes: `LeadFeatures` (from `./lead-features`).
- Produces: `type ScoreBand = "hot"|"warm"|"cool"|"cold"`; `type ScoringConfig`; `type ScoredLead = { score:number; band:ScoreBand; reasons:string[]; components:{storm:number;roof:number;source:number}; disqualified:boolean }`; `parseScoringConfig(raw):ScoringConfig`; `stormSubScore(storm, cfg):number`; `scoreLead(f, cfg):ScoredLead`.

- [ ] **Step 1: Write the failing tests**

Replace `packages/core/src/lead-scoring.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { scoreLead, deriveBand, stormSubScore, parseScoringConfig } from "./lead-scoring";
import type { LeadFeatures } from "./lead-features";

const cfg = parseScoringConfig({});
const f = (over: Partial<LeadFeatures> = {}): LeadFeatures => ({
  source: "web", state: "AZ", inTerritory: true, hasContact: true,
  roofType: null, yearBuilt: null, roofAgeYears: null,
  storm: { eventCount: 0, maxHailInches: 0, maxWindMph: 0, daysSinceWorst: null },
  ...over,
});

describe("stormSubScore", () => {
  it("severe recent hail scores near 1", () => {
    expect(stormSubScore({ eventCount: 1, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 30 }, cfg)).toBeCloseTo(1, 1);
  });
  it("recency tiers reduce the score", () => {
    const recent = stormSubScore({ eventCount: 1, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 30 }, cfg);
    const old = stormSubScore({ eventCount: 1, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 500 }, cfg);
    expect(old).toBeLessThan(recent);
    expect(old).toBe(0); // >24 months => factor 0
  });
  it("hail size thresholds step down (1.5 vs 1.0 vs 0.75)", () => {
    const big = stormSubScore({ eventCount: 1, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 30 }, cfg);
    const mid = stormSubScore({ eventCount: 1, maxHailInches: 1.0, maxWindMph: 0, daysSinceWorst: 30 }, cfg);
    const sm = stormSubScore({ eventCount: 1, maxHailInches: 0.75, maxWindMph: 0, daysSinceWorst: 30 }, cfg);
    expect(big).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(sm);
  });
  it("adds a multi-event bump, capped at 1", () => {
    const one = stormSubScore({ eventCount: 1, maxHailInches: 1.0, maxWindMph: 0, daysSinceWorst: 30 }, cfg);
    const two = stormSubScore({ eventCount: 2, maxHailInches: 1.0, maxWindMph: 0, daysSinceWorst: 30 }, cfg);
    expect(two).toBeGreaterThan(one);
    expect(stormSubScore({ eventCount: 5, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 10 }, cfg)).toBeLessThanOrEqual(1);
  });
});

describe("deriveBand", () => {
  it("maps the cutoffs", () => {
    expect(deriveBand(80, cfg)).toBe("hot");
    expect(deriveBand(79, cfg)).toBe("warm");
    expect(deriveBand(60, cfg)).toBe("warm");
    expect(deriveBand(59, cfg)).toBe("cool");
    expect(deriveBand(40, cfg)).toBe("cool");
    expect(deriveBand(39, cfg)).toBe("cold");
  });
});

describe("scoreLead", () => {
  it("weights storm/roof/source (severe-storm referral old-roof scores high)", () => {
    const r = scoreLead(f({
      source: "referral", roofType: "tile", yearBuilt: 1996, roofAgeYears: 30,
      storm: { eventCount: 2, maxHailInches: 1.75, maxWindMph: 0, daysSinceWorst: 60 },
    }), cfg);
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.band).toBe("hot");
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.disqualified).toBe(false);
  });
  it("a cold-source no-storm new-roof lead is cold", () => {
    const r = scoreLead(f({ source: "other", roofType: "asphalt_shingle", yearBuilt: 2024, roofAgeYears: 1 }), cfg);
    expect(r.band).toBe("cold");
  });
  it("unknown roof age scores neutral, not zero", () => {
    const known0 = scoreLead(f({ roofAgeYears: 1 }), cfg).components.roof;
    const unknown = scoreLead(f({ roofAgeYears: null }), cfg).components.roof;
    expect(unknown).toBeGreaterThan(known0);
  });
  it("out-of-service-area gate zeroes the score and disqualifies", () => {
    const gated = parseScoringConfig({ serviceAreaStates: ["TX"] });
    const r = scoreLead(f({ state: "AZ", source: "referral", roofAgeYears: 30,
      storm: { eventCount: 1, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 10 } }), gated);
    expect(r.score).toBe(0);
    expect(r.disqualified).toBe(true);
    expect(r.band).toBe("cold");
    expect(r.reasons.some((x) => /out of area/i.test(x))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run src/lead-scoring.test.ts`
Expected: FAIL — `scoreLead`/`deriveBand`/`stormSubScore`/`parseScoringConfig` not exported.

- [ ] **Step 3: Implement the reworked scorer**

Replace the entire contents of `packages/core/src/lead-scoring.ts` with:

```ts
import { z } from "./schemas";
import type { LeadFeatures, StormFeature } from "./lead-features";

export type ScoreBand = "hot" | "warm" | "cool" | "cold";
export type ScoreFactor = { label: string; points: number };
export type ScoredLead = {
  score: number;
  band: ScoreBand;
  reasons: string[];
  components: { storm: number; roof: number; source: number }; // 0..1 each, pre-weight
  disqualified: boolean;
};

const DEFAULTS = {
  weights: { storm: 47, roof: 33, source: 20 },
  bands: { hot: 80, warm: 60, cool: 40 },
  roofAgeMinYears: 10,
  roofAgeMaxYears: 22,
  tileBump: 0.1,
  sourceQuality: {
    referral: 1.0, repeat: 0.95, carrier: 0.8, storm_canvass: 0.7, google: 0.5,
    website: 0.45, web: 0.45, door_knock: 0.45, facebook: 0.4, yard_sign: 0.35,
    manual: 0.3, other: 0.25,
  } as Record<string, number>,
  sourceDefault: 0.4,
  serviceAreaStates: null as string[] | null,
  renterMultiplier: 0.5, // dormant until occupancy data exists
  multiEventBumpPct: 0.1,
  stormLaneThreshold: 0.3,
};

export type ScoringConfig = typeof DEFAULTS;

const schema = z.object({
  weights: z.object({ storm: z.number(), roof: z.number(), source: z.number() }).partial().optional(),
  bands: z.object({ hot: z.number(), warm: z.number(), cool: z.number() }).partial().optional(),
  roofAgeMinYears: z.number().optional(),
  roofAgeMaxYears: z.number().optional(),
  tileBump: z.number().optional(),
  sourceQuality: z.record(z.string(), z.number()).optional(),
  sourceDefault: z.number().optional(),
  serviceAreaStates: z.array(z.string()).nullable().optional(),
  renterMultiplier: z.number().optional(),
  multiEventBumpPct: z.number().optional(),
  stormLaneThreshold: z.number().optional(),
});

export function parseScoringConfig(raw: unknown): ScoringConfig {
  const p = schema.safeParse(raw ?? {});
  const o = p.success ? p.data : {};
  return {
    ...DEFAULTS,
    ...o,
    weights: { ...DEFAULTS.weights, ...(o.weights ?? {}) },
    bands: { ...DEFAULTS.bands, ...(o.bands ?? {}) },
    sourceQuality: { ...DEFAULTS.sourceQuality, ...(o.sourceQuality ?? {}) },
    serviceAreaStates: o.serviceAreaStates ?? DEFAULTS.serviceAreaStates,
  };
}

function hailBase(inches: number): number {
  if (inches >= 1.5) return 1.0;
  if (inches >= 1.0) return 0.7;
  if (inches >= 0.75) return 0.4;
  return 0;
}
function windBase(mph: number): number {
  if (mph >= 58) return 0.6;
  if (mph >= 45) return 0.35;
  return 0;
}
function recencyFactor(daysSinceWorst: number | null): number {
  if (daysSinceWorst == null) return 0.5; // storm present but undated → neutral
  const months = daysSinceWorst / 30.44;
  if (months <= 6) return 1.0;
  if (months <= 12) return 0.85;
  if (months <= 18) return 0.55;
  if (months <= 24) return 0.3;
  return 0;
}

// 0..1 storm exposure: max(severity)·recency, +bump for repeat events, capped.
export function stormSubScore(storm: StormFeature, cfg: ScoringConfig): number {
  const severity = Math.max(hailBase(storm.maxHailInches), windBase(storm.maxWindMph));
  if (severity === 0) return 0;
  let s = severity * recencyFactor(storm.daysSinceWorst);
  if (storm.eventCount >= 2) s *= 1 + cfg.multiEventBumpPct;
  return Math.max(0, Math.min(1, s));
}

function roofSubScore(f: LeadFeatures, cfg: ScoringConfig): number {
  if (f.roofAgeYears == null) return 0.5; // neutral, not zero
  const span = Math.max(1, cfg.roofAgeMaxYears - cfg.roofAgeMinYears);
  let s = Math.max(0, Math.min(1, (f.roofAgeYears - cfg.roofAgeMinYears) / span));
  if (f.roofType === "tile") s = Math.min(1, s + cfg.tileBump);
  return s;
}

function sourceSubScore(f: LeadFeatures, cfg: ScoringConfig): number {
  return cfg.sourceQuality[(f.source ?? "").toLowerCase()] ?? cfg.sourceDefault;
}

export function deriveBand(score: number, cfg: ScoringConfig): ScoreBand {
  if (score >= cfg.bands.hot) return "hot";
  if (score >= cfg.bands.warm) return "warm";
  if (score >= cfg.bands.cool) return "cool";
  return "cold";
}

export function scoreLead(f: LeadFeatures, cfg: ScoringConfig): ScoredLead {
  const storm = stormSubScore(f.storm, cfg);
  const roof = roofSubScore(f, cfg);
  const source = sourceSubScore(f, cfg);
  const components = { storm, roof, source };

  // Out-of-service-area fit gate (only when a service area is configured AND the state is known).
  if (cfg.serviceAreaStates && f.state && !cfg.serviceAreaStates.includes(f.state)) {
    return { score: 0, band: "cold", reasons: ["Out of area — disqualified"], components, disqualified: true };
  }

  const w = cfg.weights;
  const wsum = w.storm + w.roof + w.source || 1;
  const score = Math.round((100 * (w.storm * storm + w.roof * roof + w.source * source)) / wsum);
  const band = deriveBand(score, cfg);

  const reasons: string[] = [];
  if (storm > 0) {
    const mo = f.storm.daysSinceWorst == null ? null : Math.round(f.storm.daysSinceWorst / 30.44);
    const kind = f.storm.maxHailInches >= 0.75 ? `${f.storm.maxHailInches}" hail` : `${f.storm.maxWindMph}mph wind`;
    reasons.push(mo == null ? `Storm exposure (${kind})` : `${kind} ${mo} mo ago`);
  }
  if (f.roofAgeYears != null && f.roofAgeYears >= cfg.roofAgeMinYears) {
    reasons.push(`Roof ~${f.roofAgeYears} yrs${f.roofType === "tile" ? " (tile)" : ""}`);
  }
  if (source >= 0.7) reasons.push(`${f.source} lead`);

  return { score, band, reasons, components, disqualified: false };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/core && npx vitest run src/lead-scoring.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify barrel exports + typecheck (this ripples into `hybridScore`)**

Run: `grep -n "lead-scoring" packages/core/src/index.ts` (expect `export * from "./lead-scoring";`).
Run: `pnpm typecheck`
Expected: **FAIL** at `packages/agents/src/functions/lead-intake.ts:16` — `scoreLeadBaseline` no longer exists. That break is fixed in Task 5. (If you want a green typecheck before Task 5, note it; the core tests already prove this task. Do NOT re-add `scoreLeadBaseline`.)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/lead-scoring.ts packages/core/src/lead-scoring.test.ts packages/core/src/index.ts
git commit -m "feat(core): weighted/banded config-driven scoreLead (47/33/20) with fit gates"
```

---

### Task 2: Lane derivation — `deriveLane` (`@savvy/core`)

**Files:**
- Create: `packages/core/src/lane.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/lane.test.ts`

**Interfaces:**
- Consumes: `LeadFeatures`, `ScoringConfig`, `stormSubScore` (Task 1).
- Produces: `type Lane = "storm"|"tile"|"standard"`; `deriveLane(f, cfg):Lane`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/lane.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveLane } from "./lane";
import { parseScoringConfig } from "./lead-scoring";
import type { LeadFeatures } from "./lead-features";

const cfg = parseScoringConfig({});
const f = (over: Partial<LeadFeatures> = {}): LeadFeatures => ({
  source: "web", state: "AZ", inTerritory: true, hasContact: true,
  roofType: null, yearBuilt: null, roofAgeYears: null,
  storm: { eventCount: 0, maxHailInches: 0, maxWindMph: 0, daysSinceWorst: null }, ...over,
});

describe("deriveLane", () => {
  it("storm takes precedence over tile", () => {
    expect(deriveLane(f({ roofType: "tile", storm: { eventCount: 1, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 30 } }), cfg)).toBe("storm");
  });
  it("tile when a tile roof has no qualifying storm", () => {
    expect(deriveLane(f({ roofType: "tile" }), cfg)).toBe("tile");
  });
  it("standard otherwise", () => {
    expect(deriveLane(f({ roofType: "asphalt_shingle" }), cfg)).toBe("standard");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run src/lane.test.ts`
Expected: FAIL — cannot find module `./lane`.

- [ ] **Step 3: Implement**

Create `packages/core/src/lane.ts`:

```ts
import type { LeadFeatures } from "./lead-features";
import { stormSubScore, type ScoringConfig } from "./lead-scoring";

export type Lane = "storm" | "tile" | "standard";

// Precedence: a qualifying recent storm wins; else a tile roof; else standard.
export function deriveLane(f: LeadFeatures, cfg: ScoringConfig): Lane {
  if (stormSubScore(f.storm, cfg) >= cfg.stormLaneThreshold) return "storm";
  if (f.roofType === "tile") return "tile";
  return "standard";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && npx vitest run src/lane.test.ts`
Expected: PASS.

- [ ] **Step 5: Export + commit**

Add `export * from "./lane";` to `packages/core/src/index.ts`.
```bash
git add packages/core/src/lane.ts packages/core/src/lane.test.ts packages/core/src/index.ts
git commit -m "feat(core): deriveLane (storm > tile > standard)"
```

---

### Task 3: Address normalizer — `normalizeAddress` (`@savvy/core`)

**Files:**
- Modify: `packages/core/src/address.ts` (exists — has `formatCountyLabel`/`parseCityFromAddress`)
- Test: `packages/core/src/address.test.ts` (append)

**Interfaces:**
- Produces: `normalizeAddress(addr: string | null | undefined): string`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/address.test.ts` (create if absent, importing from `./address`):

```ts
import { describe, it, expect } from "vitest";
import { normalizeAddress } from "./address";

describe("normalizeAddress", () => {
  it("lowercases, strips punctuation, and collapses whitespace", () => {
    expect(normalizeAddress("123 Main St., Mesa, AZ  85201")).toBe("123 main st mesa az 85201");
  });
  it("treats casing/spacing variants as equal", () => {
    expect(normalizeAddress("123  MAIN st")).toBe(normalizeAddress("123 Main St"));
  });
  it("returns empty string for null/undefined", () => {
    expect(normalizeAddress(null)).toBe("");
    expect(normalizeAddress(undefined)).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run src/address.test.ts`
Expected: FAIL — `normalizeAddress` not exported.

- [ ] **Step 3: Implement**

Append to `packages/core/src/address.ts`:

```ts
// Canonical form for duplicate matching: lowercase, drop punctuation, collapse whitespace.
export function normalizeAddress(addr: string | null | undefined): string {
  if (!addr) return "";
  return addr
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
```

- [ ] **Step 4: Run to verify it passes + commit**

Run: `cd packages/core && npx vitest run src/address.test.ts`
Expected: PASS.
```bash
git add packages/core/src/address.ts packages/core/src/address.test.ts
git commit -m "feat(core): normalizeAddress for dedupe matching"
```

---

### Task 4: Migration — `lead.score_band` + `lead.lane`

**Files:**
- Modify: `packages/db/src/schema/crm.ts` (the `lead` table)
- Generate: `packages/db/drizzle/NNNN_*.sql` + `meta/*`

**Interfaces:**
- Produces: `lead.scoreBand: string | null`, `lead.lane: string | null`.

- [ ] **Step 1: Add the columns**

In `packages/db/src/schema/crm.ts`, in the `lead` table, add after `scoreFeatures`:

```ts
  scoreBand: text("score_band"),
  lane: text("lane"),
```

- [ ] **Step 2: Generate the migration + meta**

Run: `pnpm db:generate`
Expected: a new `.sql` adding `score_band` + `lane` (both nullable text), plus updated `meta/_journal.json` + new `NNNN_snapshot.json`.

- [ ] **Step 3: Verify + typecheck**

Run: `ls packages/db/drizzle/*.sql | tail -1` and confirm it adds both columns.
Run: `pnpm typecheck` — still FAILS at `lead-intake.ts:16` (Task 1 ripple, fixed in Task 5); the schema itself compiles.

- [ ] **Step 4: Commit (SQL + meta together)**

```bash
git add packages/db/src/schema/crm.ts packages/db/drizzle
git commit -m "feat(db): lead.score_band + lead.lane columns"
```

---

### Task 5: Wire scoring + lane into intake; Stage 4 reads persisted lane (`@savvy/agents`)

**Files:**
- Modify: `packages/agents/src/functions/lead-intake.ts`
- Test: `packages/agents/src/functions/lead-intake.test.ts` (extend; CI-gated)

**Interfaces:**
- Consumes: `scoreLead`, `deriveLane`, `parseScoringConfig` (`@savvy/core`); `getScoringSettings` (added below, `@savvy/db`).

- [ ] **Step 1: Add a tenant scoring-config loader**

In `packages/db/src/lifecycle/assignment.ts` (sibling settings loaders live here), append:

```ts
export async function getScoringSettings(tenantId: string): Promise<unknown> {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  return (t?.settings as { scoring?: unknown } | null)?.scoring ?? null;
}
```
Confirm it's exported via `packages/db/src/index.ts` (the lifecycle barrel already re-exports this file).

- [ ] **Step 2: Update `hybridScore` to use `scoreLead`**

In `packages/agents/src/functions/lead-intake.ts`:

(a) Change the `@savvy/core` import: replace `scoreLeadBaseline` with `scoreLead, deriveLane, parseScoringConfig, type ScoringConfig`.
(b) Replace the `hybridScore` signature + baseline call so it accepts a config and returns the band/lane-relevant fields:

```ts
export async function hybridScore(
  features: LeadFeatures,
  cfg: ScoringConfig,
  aiClient: Pick<typeof ai, "completeObject"> = ai,
): Promise<{ score: number; reason: string; baseline: number; band: string; reasons: string[]; model: string }> {
  const scored = scoreLead(features, cfg);
  const baseline = scored.score;
  const factorText = scored.reasons.join("; ") || "no strong signals";
  try {
    const { object, model } = await aiClient.completeObject({
      capability: "reasoning",
      schema: scoreSchema,
      system: "You refine a roofing lead score. A deterministic baseline and its reasons are given. " +
        "Adjust the score only slightly (stay close to the baseline) and write a terse reason citing the factors. Do not invent facts.",
      prompt: `Baseline ${baseline}/100. Reasons: ${factorText}. Source=${features.source}. ` +
        `Roof age=${features.roofAgeYears ?? "unknown"}. Return {score, reason}.`,
    });
    const score = Math.max(0, Math.min(100, Math.max(baseline - 10, Math.min(baseline + 10, object.score))));
    return { score, reason: object.reason, baseline, band: scored.band, reasons: scored.reasons, model };
  } catch (err) {
    console.error("hybridScore: AI refine failed, using deterministic baseline:", err instanceof Error ? err.message : err);
    return { score: baseline, reason: factorText, baseline, band: scored.band, reasons: scored.reasons, model: "baseline-fallback" };
  }
}
```

> Note: the band is taken from the deterministic baseline (the ±10 LLM nudge does not re-band — bands track the deterministic model, keeping them stable/explainable).

- [ ] **Step 3: Update the `ai-qualify` step to persist band + lane**

In the `ai-qualify` `step.run`, replace the body (currently builds features, calls `hybridScore(features)`, persists) with:

```ts
    const scored = await step.run("ai-qualify", async () => {
      const features = buildLeadFeatures({
        source: ctx.source, state: ctx.state, phone: ctx.phone,
        roofType: enriched.roofType, yearBuilt: enriched.yearBuilt, storm: enriched.storm,
      });
      const cfg = parseScoringConfig(await getScoringSettings(tenantId));
      const r = await hybridScore(features, cfg);
      const lane = deriveLane(features, cfg);
      const recommendation = deriveInstallRecommendation(features);
      await withTenant(tenantId, (tx) =>
        tx.update(lead).set({
          score: r.score, scoreReason: r.reason, scoreBand: r.band, lane, status: "contacted",
          scoreFeatures: { features, baseline: r.baseline, reasons: r.reasons, aiAdjustment: r.score - r.baseline },
          installRecommendation: recommendation,
        }).where(eq(lead.id, leadId)),
      );
      await recordAgentRun({
        tenantId, agent: "comms", taskKey: "lead.qualify", status: "ok",
        modelUsed: r.model, inngestRunId: event.id ?? null,
      });
      return r;
    });
```

Add `getScoringSettings` to the `@savvy/db` import.

- [ ] **Step 4: Stage 4 — read the persisted lane**

In `runLeadAssignment` (same file), replace the inline derivation line:

```ts
      lane = dest?.roofType === "tile" ? "tile" : null;
```

with a read of the persisted lane (extend the lead select at the top of the proximity block to include `lane`):

```ts
      // (in the lead select) add: lane: lead.lane
      lane = l.lane ?? (dest?.roofType === "tile" ? "tile" : null);
```

i.e. add `lane: lead.lane` to the `tx.select({...})` for `l`, and use `l.lane` first, falling back to the old inline rule only if the lane wasn't persisted yet (older leads).

- [ ] **Step 5: Typecheck (the Task 1 ripple resolves here)**

Run: `pnpm typecheck`
Expected: PASS now (no more `scoreLeadBaseline`).

- [ ] **Step 6: Extend the workflow test (CI-gated)**

In `packages/agents/src/functions/lead-intake.test.ts`, add/extend a case asserting that after intake the lead row has a non-null `scoreBand` and a `lane` in `{storm,tile,standard}`. Reuse the file's seed harness. CI-gated — note if local Postgres is unavailable.

- [ ] **Step 7: Commit**

```bash
git add packages/agents/src/functions/lead-intake.ts packages/db/src/lifecycle/assignment.ts packages/agents/src/functions/lead-intake.test.ts
git commit -m "feat(agents): persist scoreBand+lane at intake; assignment reads persisted lane"
```

---

### Task 6: Dedupe in `createLeadForTenant` (`apps/web`)

**Files:**
- Modify: `apps/web/src/lib/intake.ts`
- Test: `apps/web/src/lib/intake.test.ts` (CI-gated; create/extend)

**Interfaces:**
- Consumes: `normalizeAddress` (`@savvy/core`).

- [ ] **Step 1: Implement non-destructive attach**

In `apps/web/src/lib/intake.ts`, add `and, or, isNotNull` to the `@savvy/db` import and `normalizeAddress` to the `@savvy/core` import, then replace the `withTenant` body of `createLeadForTenant` with:

```ts
  const leadId = await withTenant(tenantId, async (tx) => {
    // Dedupe: reuse an existing customer on an EXACT normalized phone OR email match.
    const conds = [] as ReturnType<typeof eq>[];
    if (input.phone) conds.push(eq(customer.phone, input.phone));
    if (input.email) conds.push(eq(customer.email, input.email));
    let existing: typeof customer.$inferSelect | undefined;
    if (conds.length) {
      const matches = await tx.select().from(customer)
        .where(and(eq(customer.tenantId, tenantId), conds.length === 1 ? conds[0] : or(...conds)));
      existing = matches.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]; // oldest, deterministic
    }

    const c = existing ?? (await tx.insert(customer)
      .values({ tenantId, name: input.name, phone: input.phone ?? null, email: input.email ?? null })
      .returning())[0]!;

    // Reuse the customer's property only on an exact normalized-address match; else insert.
    let propertyId: string | undefined;
    if (existing) {
      const props = await tx.select().from(property).where(eq(property.customerId, c.id));
      const want = normalizeAddress(input.address);
      propertyId = props.find((p) => normalizeAddress(p.address) === want)?.id;
    }
    if (!propertyId) {
      const [p] = await tx.insert(property).values({
        tenantId, customerId: c.id, address: input.address, line1: input.line1 ?? null,
        city: input.city ?? parseCityFromAddress(input.address), state: input.state ?? null,
        zip: input.zip ?? null, county: input.county ?? null, lat: input.lat ?? null, lng: input.lng ?? null,
        roofType: input.roofType ?? null, yearBuilt: input.yearBuilt ?? null,
      }).returning();
      propertyId = p!.id;
    }

    const [l] = await tx.insert(lead).values({
      tenantId, customerId: c.id, propertyId, source: input.source, status: "new",
    }).returning();
    return l!.id;
  });
```

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. (If `customer.$inferSelect` typing is awkward, type `existing` as `{ id: string; createdAt: Date } | undefined` and select only those columns.)

- [ ] **Step 3: CI-gated dedupe test**

Create/extend `apps/web/src/lib/intake.test.ts`: seed a tenant; create a lead with phone `+14805551234`; create a second lead with the same phone, different address → assert ONE customer, TWO properties, TWO leads. A third with a brand-new phone+email → new customer. Mirror the seed harness of other `apps/web` server-side tests. CI-gated.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/intake.ts apps/web/src/lib/intake.test.ts
git commit -m "feat(intake): non-destructive dedupe — attach re-submits to existing customer"
```

---

### Task 7: Nightly re-score cron (`@savvy/agents`)

**Files:**
- Create: `packages/agents/src/functions/lead-rescore.ts`
- Modify: `packages/agents/src/index.ts` (register the function)
- Test: `packages/agents/src/functions/lead-rescore.test.ts` (CI-gated)

**Interfaces:**
- Consumes: `scoreLead`, `deriveLane`, `parseScoringConfig`, `buildLeadFeatures` (`@savvy/core`); `stormProof` (`@savvy/integrations`); `getScoringSettings` (`@savvy/db`).

- [ ] **Step 1: Implement the re-score function + cron**

Create `packages/agents/src/functions/lead-rescore.ts`:

```ts
import { adminDb, withTenant, tenant, lead, property, eq, and, inArray, recordAgentRun } from "@savvy/db";
import { scoreLead, deriveLane, parseScoringConfig, buildLeadFeatures } from "@savvy/core";
import { stormProof } from "@savvy/integrations";
import { inngest } from "../client";

const OPEN = ["new", "contacted", "qualified", "booked"] as const;

// Re-score one tenant's open leads; returns how many were upgraded to a higher band.
export async function rescoreTenant(tenantId: string): Promise<number> {
  const cfg = parseScoringConfig(await getScoringSettingsSafe(tenantId));
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: lead.id, band: lead.scoreBand, source: lead.source, state: property.state,
        roofType: property.roofType, yearBuilt: property.yearBuilt, lat: property.lat, lng: property.lng,
      })
      .from(lead)
      .leftJoin(property, eq(lead.propertyId, property.id))
      .where(and(eq(lead.tenantId, tenantId), inArray(lead.status, [...OPEN])));

    let upgraded = 0;
    for (const r of rows) {
      if (r.lat == null || r.lng == null) continue;
      let storm;
      try {
        storm = await stormProof.lookupStorms({ lat: Number(r.lat), lng: Number(r.lng) });
      } catch (err) {
        console.error(`rescore: storm lookup failed for lead ${r.id}:`, err instanceof Error ? err.message : err);
        continue; // fail-open per lead
      }
      const features = buildLeadFeatures({
        source: r.source ?? "web", state: r.state, roofType: r.roofType, yearBuilt: r.yearBuilt,
        storm: { eventCount: storm.eventCount, maxHailInches: storm.maxHailInches, maxWindMph: storm.maxWindMph, daysSinceWorst: storm.daysSinceWorst },
      });
      const scored = scoreLead(features, cfg);
      const lane = deriveLane(features, cfg);
      const improved = bandRank(scored.band) > bandRank(r.band);
      await tx.update(lead).set({ score: scored.score, scoreBand: scored.band, scoreReason: scored.reasons.join("; "), lane }).where(eq(lead.id, r.id));
      if (improved) upgraded++;
    }
    // Audit the sweep (no per-user push channel exists yet; band lives on the lead for the UI).
    if (upgraded > 0) {
      await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "lead.rescore.upgraded", status: "ok" });
    }
    return upgraded;
  });
}

function bandRank(b: string | null): number {
  return { cold: 0, cool: 1, warm: 2, hot: 3 }[b ?? "cold"] ?? 0;
}

async function getScoringSettingsSafe(tenantId: string): Promise<unknown> {
  const { getScoringSettings } = await import("@savvy/db");
  return getScoringSettings(tenantId);
}

export const leadRescore = inngest.createFunction(
  { id: "lead-rescore", concurrency: { limit: 1 } },
  { cron: "TZ=America/Phoenix 0 3 * * *" }, // nightly 03:00
  async ({ step }) => {
    const tenants = await step.run("list-tenants", async () => adminDb.select({ id: tenant.id }).from(tenant));
    let upgraded = 0;
    for (const t of tenants) {
      upgraded += await step.run(`rescore-${t.id}`, () => rescoreTenant(t.id));
    }
    return { upgraded };
  },
);
```

> If `getScoringSettings` is already exported from `@savvy/db` (Task 5), import it directly at the top instead of the dynamic `getScoringSettingsSafe` shim and delete the shim.

- [ ] **Step 2: Register the function**

In `packages/agents/src/index.ts`, import `leadRescore` and add it to the exported `functions` array (mirror how `coldArchiveDocuments` is registered).

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: CI-gated cron test**

Create `packages/agents/src/functions/lead-rescore.test.ts`: seed a tenant + an open lead with band `cool` whose property coords make the fake StormProof return a qualifying hail event → call `rescoreTenant(tenantId)` → assert it returns ≥1, the lead's `scoreBand` rose, and `lane` became `storm`. CI-gated.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/functions/lead-rescore.ts packages/agents/src/functions/lead-rescore.test.ts packages/agents/src/index.ts
git commit -m "feat(agents): nightly re-score cron lifts open leads on fresh storms"
```

---

### Task 8: Surface band + reasons on the lead detail (`apps/web`)

**Files:**
- Modify: `apps/web/src/lib/leads-queries.ts` (`getLeadDetail` select + `LeadDetail` type)
- Modify: `apps/web/src/app/(app)/leads/[id]/page.tsx` (render band chip + reasons)

**Interfaces:**
- Consumes: `lead.scoreBand`, `lead.scoreFeatures.reasons`.

- [ ] **Step 1: Add band + reasons to `getLeadDetail`**

In `apps/web/src/lib/leads-queries.ts`: add `scoreBand: lead.scoreBand` to the select, `scoreBand: string | null` to `LeadDetail`, and return it. If `scoreFeatures` (jsonb) isn't already returned, add `scoreFeatures: lead.scoreFeatures` and type it `{ reasons?: string[] } | null`.

- [ ] **Step 2: Render the band chip + reasons**

In the lead detail page's score area, add (using existing design-system classes; the band drives a semantic color — map hot→destructive/red, warm→amber, cool→blue, cold→muted via existing tokens, NO hardcoded hex):

```tsx
{detail.scoreBand && (
  <span data-testid="lead-band" className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize"
    style={{ background: "var(--surface-muted)", color: "var(--text-muted)" }}>
    {detail.scoreBand}
  </span>
)}
{Array.isArray((detail.scoreFeatures as { reasons?: string[] } | null)?.reasons) && (
  <ul className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
    {((detail.scoreFeatures as { reasons?: string[] }).reasons ?? []).map((r, i) => <li key={i}>• {r}</li>)}
  </ul>
)}
```

> Match the file's existing styling approach — if it uses Tailwind semantic classes rather than CSS vars, use those. The requirement is: band chip + reasons visible, dark-mode safe (no hardcoded colors).

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/leads-queries.ts "apps/web/src/app/(app)/leads/[id]/page.tsx"
git commit -m "feat(leads): show score band + reasons on lead detail"
```

---

### Task 9: Doc — scoring/lanes/dedupe (how it works + how to tune)

**Files:**
- Create: `docs/lead-pipeline-scoring.md`

- [ ] **Step 1: Write the doc**

Create `docs/lead-pipeline-scoring.md`: the scoring model (weights 47/33/20, the storm severity/recency table, roof-age ramp + tile bump, source map, bands), the out-of-area gate + dormant renter gate, lane precedence, the nightly re-score cron, the dedupe rule (exact phone/email attach, non-destructive), and how to tune via `tenant.settings.scoring` (show the JSON shape with real keys from `parseScoringConfig`). ~1 page.

- [ ] **Step 2: Commit**

```bash
git add docs/lead-pipeline-scoring.md
git commit -m "docs: scoring + lanes + dedupe — how it works and how to tune"
```

---

### Task 10: Full gate, push, PR, CI

- [ ] **Step 1: Full local gate**

```bash
cd ~/Sites/savvy-phaseb
( cd packages/core && npx vitest run )
pnpm typecheck
pnpm lint
```
Expected: all PASS.

- [ ] **Step 2: Push + PR**

```bash
git push -u origin feat/scoring-lanes
gh pr create --base main --title "Phase B: scoring rework + lanes + dedupe" --body "$(cat <<'EOF'
## Summary
- **Scoring** reworked to a weighted (47/33/20 storm/roof/source), banded (Hot/Warm/Cool/Cold), config-driven `scoreLead` with an out-of-area fit gate; keeps the ±10 LLM refine (fail-open).
- **Lanes**: `lead.lane` (storm>tile>standard) persisted at intake + re-score; Stage 4 reads it.
- **Dedupe**: `createLeadForTenant` attaches re-submits to an existing customer on exact normalized phone/email (non-destructive; address-only never merges).
- **Nightly re-score cron** lifts open leads when fresh storms qualify; records an agentRun on band upgrade.
- Band + reasons surfaced on the lead detail.

## Notes
- Property-value + engagement components are dropped/re-weighted (no data source yet). Renter gate is config-present but dormant (no occupancy data). Storm sub-score uses StormProof summary fields (per-event exactness is a future follow-up). "Notify owner" = agentRun audit (no user push channel exists yet).

## Tests
- Core unit: scoreLead boundaries (severity/recency/bands/gate/neutral-degrade), deriveLane precedence, normalizeAddress, config defaults.
- CI-gated DB: intake persists band+lane, dedupe attach, re-score cron upgrade.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr checks --watch
```
Expected: green. Fix-forward if red. **Do not merge until Brett says so.**

---

## Self-Review

**Spec coverage:**
- Weighted/banded/config scoring + fit gates → Task 1. ✅
- Storm severity/recency curve + multi-event bump → Task 1 (`stormSubScore`). ✅
- Lanes (storm>tile>standard) persisted + Stage 4 wiring → Tasks 2, 4, 5. ✅
- Dedupe non-destructive exact phone/email → Task 6. ✅
- Nightly re-score cron + band-upgrade audit → Task 7. ✅
- Band + reasons surfaced → Task 8. ✅
- `lead.score_band` + `lead.lane` migration → Task 4. ✅
- Keep LLM ±10 fail-open → Task 5 (`hybridScore`). ✅
- Config in `tenant.settings.scoring` → Task 1 (`parseScoringConfig`) + Task 5 loader. ✅
- Unknown-field neutral degrade + dormant renter gate → Task 1. ✅
- Doc → Task 9. ✅

**Placeholder scan:** No TBD/TODO; pure tasks (1–3) carry full code; DB-test bodies (5,6,7) are described against each file's existing seed harness (the implementer reads it in-file), every implementation step shows complete code.

**Type consistency:** `ScoringConfig`/`ScoredLead`/`ScoreBand` (Task 1) are consumed by `deriveLane` (Task 2), `hybridScore`/`ai-qualify` (Task 5), and the cron (Task 7) with matching names. `lead.scoreBand`/`lead.lane` (Task 4) are what Tasks 5/7/8 read+write. `normalizeAddress` (Task 3) is used by Task 6. `getScoringSettings` (Task 5 Step 1) is consumed by Task 5 + Task 7.
