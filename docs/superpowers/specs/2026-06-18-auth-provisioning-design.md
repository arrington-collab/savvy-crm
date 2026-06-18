# Auth & Provisioning — Design Spec (2026-06-18)

The first production-readiness sub-project. Makes a real customer able to sign in
with Clerk and automatically get a provisioned tenant + user row, and gives admins
in-app team management. This is the prerequisite for deploying a usable app — today
the only way a `tenant` exists is the e2e `create-tenant.ts` script, and a deployed
app would 500 on first login (`getTenantId` throws "no tenant for org").

This is one of four production-readiness sub-projects (the others — deployment/infra,
onboarding UX, hardening/observability — are separate specs). This spec covers auth
& provisioning only.

## Goal

A new customer signs up via Clerk → creates an organization → on first authenticated
request the app provisions a `tenant` (with `publicKey`) and a `user` row (role mapped
from Clerk), with a Clerk webhook keeping things in sync out-of-band; and an admin can
invite teammates, change roles, remove members, and add PIN-only crew users from
`/settings/team`. Done-when: signing in to a brand-new Clerk org lands on a working
`/dashboard` with no manual DB step, and an admin can manage the team in-app.

## Identity model
Clerk owns identity. Orgs = tenants; org memberships = Clerk-backed users. The DB is a
**synced projection**: `tenant` mirrors a Clerk org, `user` mirrors org memberships,
**plus** app-only `crew` users (PIN auth, no Clerk identity). Sync is two-way:
- **lazy** (source of truth): on request, ensure the tenant + caller's user row exist.
- **webhook** (out-of-band): Clerk events keep rows in step when no request is in flight.

## Non-negotiables honored
- Tenant isolation unchanged — provisioning writes go through `adminDb` (tenant/user
  are the RLS roots, written by admin connection, exactly like existing tenant writes).
- Webhook is svix-signature-verified; fail-closed in production when the secret is unset
  (same posture as the CompanyCam/DocuSeal webhooks).
- TEST_MODE remains the e2e bypass — this spec builds out the **real-Clerk path** that
  currently exists-but-untested; it does not remove TEST_MODE.
- Ships with tests; typecheck + lint clean.

---

## Part 1 — Provisioning core + webhook + schema

### Lifecycle helpers (`@savvy/db`, the single write-path)
- `ensureTenantForOrg({ clerkOrgId, name })` → `{ id, publicKey, created }`. adminDb:
  find tenant by `clerkOrgId`; if absent, insert with a generated url-safe `publicKey`
  (nanoid-style, unique). Idempotent + race-safe via the existing `tenant.clerkOrgId`
  unique constraint (catch unique-violation → re-select).
- `ensureUser({ tenantId, clerkUserId, name, email, role })` → `{ id, created }`.
  Upsert by `(tenantId, clerkUserId)`: insert if absent, else update `name`/`email`
  and (when changed) `role`, and clear `deactivatedAt` (re-add). Race-safe via the new
  partial unique index (below). `role` is the mapped app role.
- `deactivateUserByClerkId({ tenantId, clerkUserId })` → set `deactivatedAt = now()`
  (soft-remove; preserves FK references from jobs/agent_runs).
- Role mapping helper (`@savvy/core`, pure, unit-tested) `mapClerkRole(orgRole, isCreator)`:
  `isCreator → "owner"`; `orgRole === "org:admin" → "admin"`; else `"rep"`.

### Lazy path (`apps/web/src/lib/tenant.ts` + new `current-user.ts`)
- `getTenantId()` keeps its fast path (one DB lookup by `clerkOrgId`; TEST_MODE branch
  unchanged). On a miss (org exists in Clerk but no tenant yet), it calls
  `clerkClient().organizations.getOrganization({ organizationId })` → `ensureTenantForOrg`,
  then returns the id. Clerk API only fires once per new org.
- New `getCurrentUser()` → `{ tenantId, userId, role, clerkUserId }`. Resolves
  `auth()` (orgId, userId, orgRole) → `getTenantId()` → look up `user` by
  `(tenantId, clerkUserId)`. On a miss, read `clerkClient().users.getUser(userId)`
  (name/email) + the org's `createdBy` (to detect creator) → `mapClerkRole` →
  `ensureUser`. Clerk API only on first-miss. This is the lazy user-provisioning
  entry point: it is invoked from `(app)/layout.tsx` (non-TEST_MODE) so every
  logged-in Clerk user gets a row on first request. TEST_MODE: the layout does NOT
  call it (e2e has no Clerk user); if called directly under TEST_MODE it returns a
  synthetic context `{ tenantId: TEST_TENANT_ID, userId: "test-user", role: "owner",
  clerkUserId: null }` with no DB dependency. Team-management gating uses
  `isOrgAdmin()` (already TEST_MODE-bypassed), not `getCurrentUser`, so the e2e
  team paths don't depend on a real caller row.

### Clerk webhook `/api/clerk/webhook` (svix)
- `runtime = "nodejs"`. Verify the svix signature with `CLERK_WEBHOOK_SECRET` using the
  `svix` package (`Webhook(secret).verify(rawBody, headers)`); on no secret in production
  → 401 (fail closed); in dev/test with no secret → accept (parity with other webhooks).
  Added to middleware `PUBLIC` as `/^\/api\/clerk\/webhook$/`.
- Event routing:
  - `organization.created` → `ensureTenantForOrg({ clerkOrgId: data.id, name: data.name })`.
  - `organizationMembership.created` / `.updated` → resolve tenant by org id →
    `ensureUser` with role from `mapClerkRole(data.role, data.public_user_data.user_id === org.created_by)`
    (creator detection uses the org's `created_by`; fetch org if needed).
  - `organizationMembership.deleted` → `deactivateUserByClerkId`.
  - Other events → 200 no-op.
- Always 200 on handled/no-op; svix failure → 401.

### Schema (migration `0013`)
- `user.deactivatedAt timestamptz nullable` — soft-remove. Hard delete would break
  `job.assignedUserId` / `agent_run` / `crew_checkin` FKs.
- partial unique index `user_tenant_clerk_uniq` on `(tenantId, clerkUserId)
  WHERE clerk_user_id IS NOT NULL` — race-safe Clerk-user upsert; crew users (null
  `clerkUserId`) are unaffected (multiple nulls allowed).
- **Ripple:** assignable-user listings filter out deactivated users. `listUsers`
  (`scheduling-queries.ts`) and `listCrewUsers` (`crew-admin-actions.ts`) gain
  `WHERE deactivated_at IS NULL`. (Lead-assignee dropdown consumes `listUsers`, so it
  inherits the filter.)

---

## Part 2 — Sign-in UI + team management

### Sign-in / sign-up + org chrome
- `app/sign-in/[[...sign-in]]/page.tsx` + `app/sign-up/[[...sign-up]]/page.tsx` — Clerk
  catch-all routes rendering `<SignIn>`/`<SignUp>`, OUTSIDE the `(app)` chrome (their own
  minimal layout). Added to middleware `PUBLIC` (`/^\/sign-in/`, `/^\/sign-up/`).
  Clerk URLs via `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`,
  `NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up` in `.env.example`.
- **TopBar** (`components/cockpit/TopBar.tsx`) gains `<OrganizationSwitcher>` (its built-in
  *create organization* is the customer's path to a new org → `organization.created` +
  lazy provision) + `<UserButton>`. These Clerk client components crash without a
  `ClerkProvider` (TEST_MODE), so the server `(app)/layout.tsx` passes
  `authEnabled={process.env.TEST_MODE !== "1"}` to TopBar, which renders them only when
  `authEnabled`. E2e (TEST_MODE) renders neither.
- **No-org / no-tenant handling (removes the 500):** `(app)/layout.tsx` becomes the
  choke point. Under real auth: `const { userId, orgId } = await auth();` →
  no `userId` → `redirect("/sign-in")`; signed in but no `orgId` → `redirect("/select-org")`
  (new `app/select-org/page.tsx` rendering Clerk `<OrganizationList>` with create enabled).
  Once `userId`+`orgId` resolve, the layout calls `getCurrentUser()` to lazily provision
  the caller's `user` row (and `getTenantId` provisions the tenant). Skipped entirely when
  TEST_MODE.

### Team management `/settings/team` (new Sidebar item)
- Server page (admin-only): if `getCurrentUser().role` not in {owner, admin} (or
  `!isOrgAdmin()`), render a read-only / forbidden notice. Otherwise list the team via
  `listTeam()` (`@savvy/db`/web query): `{ id, name, email, role, isClerkBacked
  (clerkUserId != null), deactivatedAt, hasPin }`, active users first.
- `team-actions.ts` (`"use server"`, each guards `isOrgAdmin()` first; Clerk org id from
  `auth().orgId`):
  - `inviteMember(email, appRole)` → `(await clerkClient()).organizations
    .createOrganizationInvitation({ organizationId, emailAddress: email, role:
    appRole === "owner" || appRole === "admin" ? "org:admin" : "org:member" })`. The
    `user` row appears on first login (lazy) or the membership webhook. Returns
    discriminated union.
  - `changeUserRole(userId, appRole)` → load the user (tenant-scoped). If `clerkUserId`:
    update Clerk membership role (`updateOrganizationMembership` admin/member) AND set
    `user.role` (keeps `org:admin`↔app role in step). Else (crew/office, app-only): set
    `user.role` directly.
  - `removeMember(userId)` → Clerk-backed: `deleteOrganizationMembership` + set
    `deactivatedAt`; crew: set `deactivatedAt`.
  - `addCrewMember(name)` → insert `user{ role:'crew', clerkUserId:null }`; returns id.
    PIN set via the existing `setCrewPin` (surfaced on crew rows in this page; the 6D
    `/settings/crew` PIN manager is reused — its `CrewPinManager` component is rendered
    for crew rows here, and the standalone `/settings/crew` page links here).
- All write actions call `revalidatePath("/settings/team")`.

### Clerk Backend SDK note
Clerk v6: `clerkClient` is **async** — `const cc = await clerkClient();` then
`cc.organizations.*` / `cc.users.*`. Methods used: `getOrganization`,
`getUser`, `createOrganizationInvitation`, `updateOrganizationMembership`,
`deleteOrganizationMembership`. Shapes verified against the v6 backend SDK at build time.

---

## Data flow
*Sign-up:* `/sign-up` → Clerk creates user → `<OrganizationSwitcher>` create-org (or
`/select-org`) → Clerk creates org (`organization.created` webhook → tenant) → first
`/dashboard` request: `getTenantId` (tenant exists) + `getCurrentUser` (lazy-creates the
owner user row). *Invite:* admin `inviteMember` → Clerk invitation → invitee signs in →
lazy `ensureUser` (or `organizationMembership.created` webhook) creates their row.
*Crew:* admin `addCrewMember` → `user{crew}` → `setCrewPin` → crew uses `/crew/[key]` (6D).

## Error handling
- No `userId` → redirect `/sign-in`; no `orgId` → redirect `/select-org` (never 500).
- Clerk API failure during lazy provision → surface a friendly "couldn't set up your
  workspace, retry" error (don't cache a partial tenant; `ensureTenantForOrg` is the only
  writer and is idempotent, so a retry completes it).
- Webhook: bad svix signature → 401; unknown event → 200 no-op; missing tenant for a
  membership event → ensure the tenant first (fetch org) or 200 no-op if the org isn't
  ours.
- Team actions: not-admin → `{ error: "forbidden" }`; Clerk SDK error → `{ error }`
  (discriminated union, never throw to the client).

## Testing
- `@savvy/core`: `mapClerkRole` unit tests (creator→owner, admin→admin, member→rep).
- `@savvy/db` integration: `ensureTenantForOrg` (create + idempotent + publicKey unique),
  `ensureUser` (insert/update/role-change/reactivate/dedupe by clerkUserId),
  `deactivateUserByClerkId`, and that `listUsers`/`listTeam` exclude deactivated users +
  cross-tenant isolation.
- Playwright e2e (TEST_MODE — app-only paths only, no Clerk):
  - team page: `addCrewMember` → crew row appears → `setCrewPin` → row shows "PIN set";
    `changeUserRole` on a crew/office user; `removeMember` (crew) → row deactivated +
    drops from the lead-assignee dropdown.
  - the webhook route: POST a fake `organizationMembership.deleted`-style payload
    (secret-bypass in dev) → assert the targeted user is deactivated.
- **Manual (Clerk dev instance, can't run under TEST_MODE):** real sign-up → create-org →
  auto-provisioned tenant + owner user; invite a teammate → they sign in → user row +
  role; change a Clerk user's role → Clerk membership + `user.role` both update; remove a
  Clerk user → membership gone + row deactivated. Documented as a manual checklist in the
  PR.
- Full gate green; `.env.example` updated.

## Out of scope (this slice → later production-readiness sub-projects)
- Deployment/hosting, managed-Postgres `savvy_app` role creation, secrets management.
- Onboarding wizard (company profile, guided integration connect) + landing page — only
  the bare `/select-org` recovery is here.
- Observability (health check, Sentry, rate-limiting) and sealing the remaining insecure
  `dev-*` secret fallbacks (`UNSUBSCRIBE_SECRET`).
- Removing TEST_MODE (kept for e2e).
- Custom Clerk roles (using default `org:admin`/`org:member`).

## File structure
| Package | Create / modify |
|---|---|
| `packages/core` | `clerk-role.ts` (`mapClerkRole`) + test |
| `packages/db` | `lifecycle/provisioning.ts` (`ensureTenantForOrg`/`ensureUser`/`deactivateUserByClerkId`) + test; `user.deactivatedAt` + partial unique index (migration `0013`); `listUsers`/team query filters; barrel exports |
| `apps/web` | `lib/tenant.ts` (lazy tenant), `lib/current-user.ts` (`getCurrentUser`), `lib/team-actions.ts`, `lib/team-queries.ts`; `app/api/clerk/webhook/route.ts`; `app/sign-in/[[...sign-in]]/`, `app/sign-up/[[...sign-up]]/`, `app/select-org/`; `(app)/layout.tsx` (auth choke point + `authEnabled`), `components/cockpit/TopBar.tsx` (OrgSwitcher+UserButton), `components/cockpit/Sidebar.tsx` (+Team nav); `app/(app)/settings/team/`; `middleware.ts` (PUBLIC += clerk webhook, sign-in, sign-up); `crew-admin-actions.ts` (deactivated filter) |
| tests | core `clerk-role`, db `provisioning`, e2e `team.spec.ts` + clerk-webhook e2e |
