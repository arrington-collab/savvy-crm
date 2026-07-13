# Slice 2 — 30-Second Ballpark Implementation Plan

> REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Steps use `- [ ]`.

**Goal:** Anchor a homeowner while they're still on the line with an honest price *range* — computed from already-captured roof data + the tenant's price book — spoken by the inbound voice agent, sent by SMS auto-reply, and shown as a quiet lead-tile chip. Never below a confidence floor, never on insurance-claim intents, always a range with a subject-to-inspection line, low end never below the price-book margin floor. Every quote is logged for a monthly calibration report.

**Architecture:** Pure `@savvy/core` core: `resolveRoofSize` (measurement > assessor sqft > footprint) and `ballparkRange` (squares × per-square good/better ± spread, margin-floored, confidence by size provenance) — both TDD'd with zero deps. Quotes are logged to the existing `audit_log` (`action='ballpark.quoted'`, `diff`=inputs snapshot) — **no migration**. The `ballpark.calibration` evidence check reads those rows vs the lead's eventual estimate. Config-gated per tenant (default ON retail only, OFF for insurance).

**Tech Stack:** `@savvy/core` (vitest), Drizzle audit_log, Vapi voice persona, existing SMS/telephony.

## Global Constraints (verbatim from spec)
- Always a RANGE with the subject-to-inspection line (template in Library); NEVER offered on insurance-claim intents (detect claim context and skip); margin floor from price book respected at the low end; every spoken/sent ballpark logged on the lead with its inputs snapshot.
- Returns null when data is insufficient — NEVER guess below the confidence floor.
- Config-gated per tenant, default ON for retail only.
- `ballpark.calibration`: monthly report quoted range vs eventual estimate value, hit-rate within range, per tenant; activates at ≥20 pairs, else "insufficient data — n=X".
- Per-tenant TZ; no secrets; dormant/config-gated defaults.

## File Structure
- `packages/core/src/ballpark/size.ts` (+test) — `resolveRoofSize`.
- `packages/core/src/ballpark/range.ts` (+test) — `ballparkRange`, `subjectToInspectionLine`, `perSquareFromPriceBook`.
- `packages/core/src/ballpark/config.ts` (+test) — `parseBallparkConfig` (tenant.settings.ballpark).
- `packages/core/src/ballpark/calibration.ts` (+test) — `computeBallparkCalibration` (pure: pairs → report).
- `packages/core/src/index.ts` — export `./ballpark/*`.
- `packages/core/src/verification/checks.ts` (+ checks.test.ts) — `ballpark.calibration` (UNBOUND; presence/insufficient — see task 5).
- `packages/db/src/lifecycle/ballpark.ts` (+ test) — `logBallparkQuote` (audit_log insert), `loadBallparkPairs` (quotes vs eventual estimate).
- Surfaces: `apps/web/src/app/api/voice/vapi/route.ts` (+ `packages/core/src/voice-persona.ts`: relax the inbound no-pricing guardrail + a `getPriceBallpark` tool), SMS auto-reply path, lead-tile chip component.

## Config (tenant.settings.ballpark, Zod, no migration)
`{ enabled: boolean (default false), retailOnly: boolean (default true), betterMultiplierBps: number (default 12500 = 1.25×), spreadBps: number (default 1000 = ±10%), marginFloorBps: number (default 2000 = +20% over cost), confidenceFloor: "measured"|"assessor"|"footprint" (default "assessor") }`.

## Tasks

### Task 1 — `resolveRoofSize` (pure)
`resolveRoofSize(input: { measurementSquares: number|null; assessorRoofSqft: number|null; footprintSqft: number|null; roofType: string|null }): { squares: number; basis: "measured"|"assessor"|"footprint" } | null`.
Precedence: measurement (squares) → assessor (roofSqft/100) → footprint (footprintSqft/100 × pitchFactor(roofType), default factor 1.3). null when none. Tests: each branch, precedence, null.

### Task 2 — `ballparkRange` (pure) + helpers
`perSquareFromPriceBook(items: {unit:string; unitPriceCents:number; unitCostCents:number}[]): { sellCents:number; costCents:number }` = Σ items with unit==="square".
`ballparkRange(input: { size: {squares:number; basis} | null; sell:{perSquareSellCents:number; perSquareCostCents:number}; config: BallparkConfig; isClaim: boolean }): { lowCents:number; highCents:number; confidence:"high"|"medium"|"low"; basis:string } | null`.
Rules: null if `!config.enabled || isClaim || !size || basis rank < confidenceFloor rank`. `good=squares×sellPerSq`; `better=good×betterMultiplier`; `low=round(good×(1-spread))`, `high=round(better×(1+spread))`; `floor=round(squares×costPerSq×(1+marginFloor))`; `low=max(low, floor)`; confidence: measured→high, assessor→medium, footprint→low; basis human string ("measured roof", "assessor sq ft", "footprint estimate"). Tests incl. claim→null, below-floor→null, margin-floor clamp, confidence mapping, range ordering low<high.
`subjectToInspectionLine(low,high): string` → `"typically runs $X–$Y — the exact number comes from a free inspection"`.

### Task 3 — `parseBallparkConfig` (pure) — schema + defaults + tests.

### Task 4 — `computeBallparkCalibration` (pure)
`computeBallparkCalibration(pairs: { lowCents:number; highCents:number; estimateCents:number }[]): { status:"insufficient"|"active"; n:number; hitRate?:number; report:string }`. <20 → insufficient ("insufficient data — n=X"). ≥20 → hitRate = share where low≤estimate≤high. Tests: n<20, n≥20 hit-rate, boundary inclusivity.

### Task 5 — `ballpark.calibration` evidence (UNBOUND)
Cross-cutting presence check — a lead with a `ballpark.quoted` audit row and an accepted estimate whose value fell OUTSIDE the quoted range is a mis-calibration signal to surface (fail → refs the lead). Invariant SQL over `audit_log` + `estimate`; red/green test via fakeDb. (Report itself = task 4; this invariant flags egregious misses.)

### Task 6 — db `logBallparkQuote` + `loadBallparkPairs`
`logBallparkQuote(tenantId, { leadId, lowCents, highCents, confidence, basis, inputs }): Promise<void>` → audit_log insert (`entityType:"lead"`, `entityId:leadId`, `action:"ballpark.quoted"`, `diff`). `loadBallparkPairs(tenantId): Promise<{lowCents,highCents,estimateCents}[]>` — join quoted leads to their accepted estimate total. Integration test (live PG).

### Task 7 — voice surface
In `voice-persona.ts`: fork the inbound persona's guardrail so pricing is allowed ONLY as the mandated framing; add a `getPriceBallpark` tool. In the vapi route `setCallDetails`/tool branch: after address capture, if not a claim and `ballparkRange` returns, speak the subject-to-inspection line + log the quote.

### Task 8 — SMS auto-reply + lead-tile chip
SMS inbound lead-intake auto-reply appends the range + booking link (non-claim, config-gated). Lead tile: a quiet `ballpark $X–$Y (basis)` chip for reps (server-computed).

## Self-Review
Coverage: pure range+size+config+calibration (T1-4) · never-on-claim (T2) · confidence floor (T2) · margin floor (T2) · evidence (T5) · logging+pairs (T6) · voice/SMS/tile surfaces (T7-8). No migration (audit_log). Types consistent (`BallparkConfig`, size basis union) across tasks.
