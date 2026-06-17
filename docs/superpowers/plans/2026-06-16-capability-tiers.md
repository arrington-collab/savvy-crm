# Capability-Tier Formalization — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. One atomic refactor (shared capability map) → a single implementer task.

**Goal:** Formalize the AI gateway around three named capability tiers — `reflex` (cheap), `workhorse` (mid), `reasoning` (flagship) — that feature code requests instead of the old ad-hoc names. Implements spec §4. **Additive & back-compatible:** old names (`cheap-classify`/`reason`/`summarize`) stay as deprecated aliases so existing drip step configs and `AI_DRAFT_CAPABILITY` keep resolving — zero data migration.

**Tech Stack:** TypeScript, `@savvy/ai` capability gateway, Vitest.

---

### Task 1: Tier capabilities + recast call sites (atomic)

**Files:** `packages/ai/src/capabilities.ts`, `packages/agents/src/functions/{lead-intake,estimate-generate,change-order-draft,drip}.ts`, `packages/core/src/enums.ts`, `packages/core/src/enums.test.ts`, `packages/agents/src/functions/drip.test.ts`.

- [ ] **Step 1 — capabilities map (canonical tiers + aliases, typed union).** Replace `packages/ai/src/capabilities.ts` body:
```ts
// Capabilities are the named tiers feature code asks for. The gateway (LiteLLM)
// maps these logical names to real providers. Feature code NEVER imports this map.
export const CAPABILITY_MODEL = {
  // Canonical tiers:
  reflex: "gemini-flash",      // cheap / high-volume: classify, score, route
  workhorse: "gemini-flash",   // mid: summarize, personalize copy
  reasoning: "claude-sonnet",  // flagship: judgment, drafting
  // Deprecated aliases — kept so existing drip step configs + AI_DRAFT_CAPABILITY
  // resolve. Prefer the tiers above in new code.
  "cheap-classify": "gemini-flash",
  reason: "claude-sonnet",
  summarize: "gemini-flash",
} as const;
export const EMBED_MODEL = "voyage-3";
export type Capability = keyof typeof CAPABILITY_MODEL;
```

- [ ] **Step 2 — recast the four hardcoded call sites to tiers:**
  - `packages/agents/src/functions/lead-intake.ts`: `capability: "cheap-classify"` → `capability: "reflex"`.
  - `packages/agents/src/functions/estimate-generate.ts`: `capability: "reason" as Capability` → `capability: "reasoning"` (drop the now-unneeded `as Capability` cast if typecheck is happy; keep it if not).
  - `packages/agents/src/functions/change-order-draft.ts`: `capability: "reason" as Capability` → `capability: "reasoning"` (same cast note).
  - `packages/agents/src/functions/drip.ts`: `capability: step.aiCapability ?? "summarize"` → `capability: step.aiCapability ?? "workhorse"`.

- [ ] **Step 3 — extend the drip-allowed capability set (`AI_DRAFT_CAPABILITY`).** In `packages/core/src/enums.ts`, change:
```ts
export const AI_DRAFT_CAPABILITY = ["reasoning", "workhorse", "reflex", "reason", "summarize"] as const;
```
(New tiers first; old names kept for back-compat with stored drip configs.)

- [ ] **Step 4 — update the two affected tests:**
  - `packages/core/src/enums.test.ts`: `expect(AI_DRAFT_CAPABILITY).toEqual(["reason", "summarize"]);` → `expect(AI_DRAFT_CAPABILITY).toEqual(["reasoning", "workhorse", "reflex", "reason", "summarize"]);`.
  - `packages/agents/src/functions/drip.test.ts`: the DEFAULT-capability assertion `expect.objectContaining({ capability: "summarize" })` → `expect.objectContaining({ capability: "workhorse" })`. **Leave** the explicit `aiCapability: "reason"` case and its `capability: "reason"` assertion as-is — it verifies a configured capability passes through AND that the `reason` alias still works.

- [ ] **Step 5 — gate (repo root):**
```
export DATABASE_URL=postgres://savvy_app:savvy_app@localhost:5432/savvy
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/savvy
pnpm typecheck && pnpm lint && pnpm test
```
Expected: typecheck clean, lint 0 errors, all tests pass. If `Capability` tightening (from `Record<string,string>` to the `as const` union) surfaces a type error at any `capability:` call site not listed above, recast that site to a valid tier/alias (never `as any`).

- [ ] **Step 6 — commit:**
```bash
git add packages/ai/src/capabilities.ts packages/agents/src/functions/lead-intake.ts packages/agents/src/functions/estimate-generate.ts packages/agents/src/functions/change-order-draft.ts packages/agents/src/functions/drip.ts packages/core/src/enums.ts packages/core/src/enums.test.ts packages/agents/src/functions/drip.test.ts
git commit -m "feat(ai): formalize capability tiers (reflex/workhorse/reasoning) with back-compat aliases"
```

---

## Self-review
- **Spec §4:** the three tiers exist and are what feature code requests (all four call sites recast); `Capability` is now a typed union (formalized, not `string`); routing unchanged (reflex/workhorse→gemini-flash, reasoning→claude-sonnet — same models as before).
- **Back-compat / no data migration:** old names remain valid keys + valid `AI_DRAFT_CAPABILITY` members, so stored drip `aiCapability` values still resolve.
- **Behavior unchanged:** every recast maps to the SAME underlying model the old name did, so no routing/behavior change — purely a naming/type formalization.

## Deferred
- Eventually drop the deprecated aliases once any stored drip configs are migrated to tier names (needs a data check first).
