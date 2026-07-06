# Cell 17a — License Matrix + Scheduling Block Invariant

**Date:** 2026-07-05
**Contract:** First-20-Cells, Cell 17 (`docs/superpowers/specs/first-20-cells.md`) — Wave D, license/permit blocking invariants (#289, #294).
**Scope:** 17a only. SB38 CO contract templates + signed-contract compliant-version invariant are 17b (separate PR).
**Migration:** 0054.

## Why

Colorado (and AZ ROC) legal exposure: doing roofing work in a jurisdiction where the tenant holds no active license is a compliance violation. The contract's principle is **blocking beats reminding** — the system must make it *physically impossible* to schedule work in an unlicensed jurisdiction, not merely warn. This is also the licensing seam Cell 20 (Alta provisioning) will seed from.

Repo survey finding: despite the spec's note that "permit gates already exist in `production.ts`," there is **no existing license/jurisdiction blocking logic** — `production.ts` only lists `permit` as a required *photo* kind. Cell 17a is effectively greenfield.

## Design decisions (locked with owner 2026-07-05)

1. **PR split:** 17a (this) = license matrix + scheduling block. 17b (next) = SB38 templates.
2. **Block scope:** hard-block **all appointment types** (inspection, sales, install) in an unlicensed jurisdiction. Simplest, strictest rule; matches Alta's intent that nothing happens in a jurisdiction until licensed.
3. **Jurisdiction key:** `(state, city?)`. `city` NULL = state-level license (AZ ROC covers all AZ cities); `city` set = municipal registration (Denver, Aurora, Lakewood).
4. **Null-state escape valve:** if a property has no resolvable `state`, do **not** block. You can't prove a null jurisdiction is unlicensed, and blocking on missing data would wedge legitimate flows. Alta's CO properties always carry `state='CO'`, so the gate still bites where it matters.
5. **Keep `authority` label column** (e.g. "AZ ROC", "City of Denver") — human-readable provenance on cards/exceptions.

## Schema — new `license` table

New file `packages/db/src/schema/compliance.ts`. Migration 0054. Tenant-scoped RLS (`tenant_id = current_setting('app.tenant_id')::uuid`), mirroring existing tenant tables.

| column | type | notes |
|---|---|---|
| `id` | uuid pk default random | |
| `tenant_id` | uuid notNull | RLS discriminator |
| `state` | text notNull | 2-letter, e.g. `AZ`, `CO` |
| `city` | text nullable | NULL = state-level; set = municipal registration |
| `authority` | text notNull | label, e.g. "AZ ROC", "City of Denver" |
| `license_number` | text notNull | |
| `status` | text notNull | `active` \| `pending` \| `expired` \| `suspended` |
| `issued_at` | timestamp nullable | |
| `expires_at` | timestamp nullable | NULL = no expiry |
| `created_at` | timestamp notNull default now | |
| `updated_at` | timestamp notNull default now | |

Index: `(tenant_id, state, city)` for resolver lookups. RLS policies added in the same migration following the repo's existing policy pattern.

## Pure resolver — `packages/core/src/license.ts`

No DB access; takes an already-fetched license array. Fully unit-testable.

- `type LicenseLike = { state: string; city: string | null; status: string; expiresAt: Date | null }`
- `isLicenseActive(license, now): boolean` — `status === 'active' && (expiresAt == null || expiresAt > now)`.
- `resolveActiveLicense(licenses, { state, city }, now): LicenseLike | null` — returns first active license where `state` matches (case-insensitive, trimmed) **and** (`license.city == null` **or** `license.city === property.city`). A city-specific match and a state-level match are both acceptable; state-level covers every city in that state.
- `licenseRenewalStatus(license, now): 'ok' | 'expiring_soon' | 'expired'` — `expired` if past `expires_at`; `expiring_soon` if within 60 days; else `ok`. `expires_at == null` → `ok`.

## The block — `bookAppointment()` in `packages/db/src/lifecycle/appointments.ts`

Inside the existing transaction, alongside `SlotTakenError` / `NoAssigneeError`:

1. Resolve the appointment's property `(state, city)` via its job/lead → property.
2. If `state` is null/blank → **skip the check** (escape valve).
3. Fetch the tenant's licenses; run `resolveActiveLicense`.
4. If none → **throw new `LicenseRequiredError`** (new typed error exported from the same module), carrying `{ state, city }` for the caller/UI.

Enforced at the data layer so no path (API route, Inngest agent, backfill) can bypass it.

## Renewal 60-day card — `production.license` evidence check

Add a check in `packages/core/src/verification/checks.ts` that surfaces any license with `licenseRenewalStatus` of `expiring_soon` or `expired` as an amber exception card (with `authority` + `expires_at`) on the Agents surface. Rides existing exception-vector plumbing; no new UI framework.

## Seed + existing-test consequence (flagged)

A fail-closed hard-block on all appointment types means **any tenant/test that books an appointment must have an active license for that property's jurisdiction**, or booking throws. Therefore 17a also:

1. **Seeds an active `AZ` state-level license** (`authority: "AZ ROC"`, `status: active`, no expiry) for the demo/seed tenant, whose seeded properties are AZ.
2. **Updates existing appointment / e2e test setup** to seed a license so previously-green booking tests stay green.

This is expected ripple, not scope creep: the invariant's whole point is that unlicensed jurisdictions can't schedule, so every green booking path must now assert a license exists.

## Tests (TDD — red first)

**Unit (`packages/core/src/license.test.ts`):**
- state-level license (`city=null`) permits a city in that state
- city-specific license permits only that city
- expired / suspended / pending licenses excluded
- no matching state → `null`
- `licenseRenewalStatus`: ok / expiring_soon (≤60d) / expired boundaries

**Integration red-path (the deliverable, `packages/db/src/lifecycle/appointments.test.ts` or a new sibling):**
- book appointment for a CO property with **no** CO license → throws `LicenseRequiredError`
- add an active CO license → same booking **succeeds**
- AZ state-level license permits an AZ-city property
- property with null `state` → booking **succeeds** (escape valve)

## Out of scope (→ 17b)
- SB38 CO contract templates (right-to-rescind, deductible no-waiver, 10-day language)
- Signed-contract compliant-template-version invariant (every signed CO contract used a compliant version)

## House rules
Worktree per cell (`cell-17a`), TDD, PR per cell, watch CI. Org-admin session on any privileged license-mutation route (if a management route is added — otherwise licenses are seeded/provisioned; a UI is not in 17a scope). No real tenant keys in tracked files.
