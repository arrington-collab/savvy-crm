# S4 — Shift Report (plan)

**Date:** 2026-07-11
**Spec:** `docs/superpowers/specs/2026-07-10-show-the-machine-working-design.md` §5 Slice 4
**Base:** `origin/main` @ 0b18723 (worktree `worktree-shift-report-s4`). **No migration.**

## Goal
Prepend a short, first-person **narrative shift report** — composed over the real
`summarizeAgentCoverage` numbers via the **AI gateway cheap capability** — to the existing
owner exception digest. Model failure falls back to a deterministic template built from the
same numbers; a **hype-adjective linter** guarantees no marketing language ever ships. Digest
suppression ("nothing to say" → no send) is preserved, and no model call is burned when
suppressing.

## Honesty contract (spec §4, S4 row)
- **Source:** `summarizeAgentCoverage` over the tenant's last-24h `agent_run` window.
- **Trigger:** n/a (text).
- **Fallback:** model fails → template narrative from the same numbers; hype-linter strips
  adjectives (falls back to template if the model returns any).

## Package split (why)
`@savvy/core` has vitest and **no** `@savvy/ai` dep → all deterministic honesty logic lives
there and is unit-tested without a model. The single non-deterministic step (the gateway
call) lives in `packages/agents` (which has `@savvy/ai`), wrapped fail-soft.

## Changes

### 1. `packages/core/src/shift-report.ts` (new, pure) + `.test.ts`
- `HYPE_WORDS: readonly string[]` — curated marketing/adjective ban list (incl. spec's
  "amazing/blazing/incredible/…", plus "seamless/effortless/tirelessly/relentlessly/…").
- `findHypeWords(text): string[]` — whole-word, case-insensitive matches (deduped, lowercased).
- `isFactual(text): boolean` — no hype words present.
- `templateShiftReport(coverage: AgentCoverage[]): string` — deterministic first-person
  narrative; handles 0-total ("No agent activity in the last 24 hours."), surfaces errors +
  no-ops (skipped).
- `shiftReportPrompt(coverage): { system; prompt }` — builds the model request from the
  numbers; system forbids hype + exclamation, 2–3 sentences.
- `chooseShiftReport(modelText: string | null, coverage): string` — the honesty gate: ship
  the model's trimmed text **only** if non-empty, within a length cap, and `isFactual`;
  otherwise the template. Never ships hype.
- Export via barrel: add `export * from "./shift-report";` to `packages/core/src/index.ts`.

### 2. `packages/db/src/lifecycle/agent-run.ts` — `loadAgentCoverageWindow`
- `loadAgentCoverageWindow(tenantId, since: Date): Promise<AgentRunLite[]>` — RLS-scoped
  (`withTenant`) select of the lite coverage shape since `since`. Export from db barrel.

### 3. `packages/agents/src/shift-report.ts` (new) + `.test.ts`
- `composeShiftReport(coverage, aiClient: Pick<typeof ai,"complete"> = ai):
  Promise<{ narrative; modelUsed: string | null }>` — calls
  `aiClient.complete({ capability: "workhorse", ... })` (cheap = gemini-flash), try/catch →
  null on failure, then `chooseShiftReport`. `modelUsed` = the model id **only** when the
  model's text actually shipped (else null — honest telemetry).
- Unit test with fake aiClient: throws → template; returns hype → template; returns clean →
  model text + modelUsed set.

### 4. `packages/agents/src/ops-digest.ts` — wire in
- After the `if (!msg) return` suppression guard (so suppression + no wasted model call are
  preserved): load coverage window → `summarizeAgentCoverage` → `composeShiftReport(coverage,
  deps.aiClient)` → prepend `narrative` + blank line before the existing exception block.
- Add `aiClient?: Pick<typeof ai,"complete">` to `DigestDeps`.
- Pass `modelUsed` to the proof-of-send `recordAgentRun`.

### 5. `packages/agents/src/ops-digest.test.ts` — extend (real DB)
- Seed a couple `agent_run` rows for the exception tenant; inject fake aiClient so tests never
  hit the network.
- New: narrative **prepended** before the exception line (clean model text); model-failure →
  **template** fallback (structural regex, never throws, modelUsed null); **suppression** →
  aiClient never called, `sent: 0`.

## Verify / DoD
- `pnpm --filter @savvy/core test` + `pnpm --filter @savvy/core typecheck` (esbuild vitest
  doesn't type-check).
- `pnpm --filter @savvy/agents test` (needs local Postgres).
- Full `pnpm typecheck` + `pnpm lint`. Small commit → PR → `gh pr checks` green.
- Bloom smoke (Brett): a shift-report SMS/email reads as first-person narrative over real
  numbers.
