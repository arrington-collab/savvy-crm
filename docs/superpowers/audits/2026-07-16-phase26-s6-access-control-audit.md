# Phase 26 Slice 6: Access Control Reality Audit

**Date:** 2026-07-16  
**Scope:** Savvy CRM multi-tenant SaaS (Next.js + Postgres + Drizzle + Clerk orgs)  
**Status:** Audit only — no modifications recommended in this phase  

---

## Executive Summary

The Savvy CRM codebase has **role infrastructure defined but minimal enforcement**. Five roles exist (`owner`, `admin`, `rep`, `crew`, `office`) and map from Clerk org roles, but:

- **Route access:** NO role-based gating on routes; tenant membership via RLS is the only access control
- **Data scoping:** Strictly tenant-level via RLS; NO row-level role scoping  
- **Money actions:** NO approval thresholds or role checks; any tenant member can approve blitz campaigns, send invoices, etc.
- **Exception cards:** No owner-only suppression; all roles see all cards (only tenant isolation)
- **The `office` role:** Provisioned in schemas and TeamManager UI but unused—no code path references it
- **Clerk mapping:** Creator → `owner`; org:admin → `admin`; everyone else → `rep`

This is **not a vulnerability**—tenant isolation is rock-solid—but leaves the door open for the proposed office-role scoping. The audit documents where each specification requirement would hook in.

---

## 1. Role Inventory

### Role Enum & Defaults

**File:** `/packages/db/src/schema/tenancy.ts` + `/packages/core/src/enums.ts`

```typescript
export const USER_ROLE = ["owner", "admin", "rep", "crew", "office"] as const;
```

**User table definition:**
```typescript
export const user = pgTable("user", {
  // ... other cols ...
  role: userRoleEnum("role").notNull().default("rep"),
  // ...
});
```

### Role Assignment Logic

**File:** `/apps/web/src/lib/current-user.ts`

```typescript
export async function getCurrentUser(): Promise<CurrentUser> {
  // ...
  const { userId: clerkUserId, orgId, orgRole } = await auth();
  // ...
  const role = mapClerkRole(orgRole, org.createdBy === clerkUserId);
  const { id } = await ensureUser({ tenantId, clerkUserId, name, email, role });
  return { tenantId, userId: id, role, clerkUserId };
}
```

**Clerk → Savvy role mapping:**  
**File:** `/packages/core/src/clerk-role.ts`

```typescript
export function mapClerkRole(orgRole: string | null | undefined, isCreator: boolean): ClerkMappedRole {
  if (isCreator) return "owner";
  return orgRole === "org:admin" ? "admin" : "rep";
}
```

**Result:**
| Clerk Org Role | Is Creator | Savvy Role |
|---|---|---|
| (any) | true | `owner` |
| `org:admin` | false | `admin` |
| `org:member` | false | `rep` |
| null/undefined | false | `rep` |
| (not invited yet) | N/A | `rep` (on first login) |

**Note:** `crew` and `office` roles **cannot be assigned via Clerk**. They are set only:
- `crew`: manually via `addCrewMember()` / `setCrewPin()` (TeamManager UI)
- `office`: manually via `changeUserRole()` (TeamManager UI, requires org:admin)

### Role Lifecycle

**Where roles are created/modified:**

1. **On user first login** (`/apps/web/src/lib/current-user.ts`):
   - Clerk org role + creator status → Savvy role via `mapClerkRole()`
   - Stored in `user.role`

2. **Team settings page** (`/apps/web/src/app/(app)/settings/team/page.tsx`):
   - Gated: `isOrgAdmin()` check (Clerk `org:admin` only)
   - Allows changing any user's role to: `["owner", "admin", "rep", "office", "crew"]`
   - Uses `changeUserRole()` server action

3. **Crew onboarding** (`/apps/web/src/app/(app)/settings/team/TeamManager.tsx`):
   - `addCrewMember()` creates a PIN-only crew user (no Clerk login)
   - Sets `role = "crew"` and `pinHash`

---

## 2. Route-Level Access Control: AS-IS Reality

### Finding: Routes Have NO Role Gating

**Middleware scope:**  
**File:** `/apps/web/src/middleware.ts`

- Routes under `(app)` require Clerk auth via `auth.protect()`
- Routes under `(crew)` are PUBLIC (PIN-gated in the UI, not middleware)
- Routes under `(onboarding)` require Clerk auth
- No middleware examines `user.role`

**Layout-level enforcement:**  
**File:** `/apps/web/src/app/(app)/layout.tsx`

```typescript
export default async function AppLayout({ children }: { children: ReactNode }) {
  const authEnabled = process.env.TEST_MODE !== "1";
  if (authEnabled) {
    const { userId, orgId } = await auth();
    if (!userId) redirect("/sign-in");
    if (!orgId) redirect("/select-org");
    await getCurrentUser(); // lazily provision tenant + user
    // ... check onboarding status ...
  }
  // All authenticated users proceed; no role check
}
```

**Settings page (only place with role check):**  
**File:** `/apps/web/src/app/(app)/settings/team/page.tsx`

```typescript
export default async function TeamSettingsPage() {
  if (!(await isOrgAdmin())) {
    return <p data-testid="team-forbidden">Admins only.</p>;
  }
  // ...
}
```

**Authz function:**  
**File:** `/apps/web/src/lib/authz.ts`

```typescript
export async function isOrgAdmin(): Promise<boolean> {
  if (process.env.TEST_MODE === "1") return true;
  const { orgRole } = await auth();  // Clerk org role, not Savvy role
  return orgRole === "org:admin";
}
```

### Route × Role Access Table (Actual Today)

| Route | Gating | Who can access |
|---|---|---|
| `/today` | Tenant + auth | owner, admin, rep, office (NOT crew) |
| `/pipeline` | Tenant + auth | owner, admin, rep, office (NOT crew) |
| `/money` | Tenant + auth | owner, admin, rep, office (NOT crew) |
| `/invoices`, `/[id]` | Tenant + auth | owner, admin, rep, office (NOT crew) |
| `/commissions` | Tenant + auth | owner, admin, rep, office (NOT crew) |
| `/jobs/[id]` | Tenant + auth | owner, admin, rep, office (NOT crew) |
| `/leads` | Tenant + auth | owner, admin, rep, office (NOT crew) |
| `/partners` | Tenant + auth | owner, admin, rep, office (NOT crew) |
| `/partners/certs` | Tenant + auth | owner, admin, rep, office (NOT crew) |
| `/schedule` | Tenant + auth | owner, admin, rep, office (NOT crew) |
| `/settings/*` | Tenant + auth | **All** (team mgmt gated to org:admin only) |
| `/settings/team` | `isOrgAdmin()` | Clerk `org:admin` only (⚠️ not Savvy role) |
| `/settings/price-book` | Tenant + auth | owner, admin, rep, office (NOT crew) |
| `/crew/[key]/...` | PIN + session | crew (no login) + office can orchestrate |
| `/estimate/[code]` | Public + subscriber read | Anonymous public |

**KEY INSIGHT:** Every route under `(app)` is accessible to **any authenticated tenant member**, regardless of Savvy role. The only exception is Team Settings, which gates on Clerk `org:admin`, NOT Savvy `admin` or `owner` role.

---

## 3. Server Actions & API Route Handler Authorization: AS-IS Reality

### Money-Touching Actions: Role-Gating Status

#### Blitz Campaign Approval

**File:** `/apps/web/src/app/(app)/today/BlitzApprovalActions.tsx`  
**Action:** `/apps/web/src/lib/blitz-actions.ts`

```typescript
export async function approveBlitzAction(campaignId: string): Promise<{ ok: true } | { error: string }> {
  try {
    const { tenantId, userId } = await getCurrentUser();
    // NO ROLE CHECK
    await approveBlitzCampaign(tenantId, { campaignId, userId: userId === "test-user" ? null : userId });
    revalidatePath("/today");
    return { ok: true };
  } catch {
    return { error: "could not approve" };
  }
}
```

**DB-level function:**  
**File:** `/packages/db/src/lifecycle/mobilization-blitz.ts`

```typescript
export async function approveBlitzCampaign(
  tenantId: string,
  input: { campaignId: string; userId: string | null },
): Promise<{ approved: boolean }> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.update(mailCampaign)
      .set({ status: "approved", approvedByUserId: input.userId, approvedAt: new Date() })
      .where(and(
        eq(mailCampaign.tenantId, tenantId),
        eq(mailCampaign.id, input.campaignId),
        eq(mailCampaign.status, "pending_approval"),
      )).returning({ id: mailCampaign.id });
    return { approved: !!row };
  });
}
```

**Finding:** ✅ Resolves tenant context (RLS scoped), ✗ **NO role check before update**.

#### Invoice/Payment Actions

**File:** `/packages/db/src/lifecycle/booking.ts`

```typescript
export async function confirmBookingAndSchedule(
  tenantId: string,
  input: { homeownerId: string; contractEsignUrl: string },
): Promise<{ ok: boolean }> {
  return withTenant(tenantId, async (tx) => {
    // ... job approval logic ...
    const [reps] = await tx
      .select({ userId: user.id })
      .from(user)
      .where(and(eq(user.tenantId, p.tenantId), or(eq(user.role, "owner"), eq(user.role, "rep"))));
    // NO AUTHZ; just filters to find available reps for assignment
  });
}
```

**Finding:** ✗ **No role check** before modifying job stage or scheduling.

#### Commission Approval

**File:** `/packages/db/src/lifecycle/` (searched, not found yet)  
**Finding:** No explicit commission approval action found in web; likely managed at DB level only.

### Admin/Configuration Actions

#### Team Member Role Change

**Server action:** `/apps/web/src/lib/team-actions.ts`

```typescript
export async function changeUserRole(userId: string, newRole: UserRole): Promise<{ ok: true } | { error: string }> {
  try {
    if (!(await isOrgAdmin())) {
      return { error: "unauthorized" };
    }
    const { tenantId } = await getCurrentUser();
    await adminDb.update(user).set({ role: newRole }).where(and(
      eq(user.id, userId),
      eq(user.tenantId, tenantId),
    ));
    return { ok: true };
  } catch {
    return { error: "could not update role" };
  }
}
```

**Finding:** ✅ **Gated to `isOrgAdmin()`** (Clerk org:admin), ✅ **tenant scoped** via `adminDb` + explicit tenantId check.

#### Price Book, Scheduling Config

**Files:** `/apps/web/src/app/(app)/settings/price-book/`, `/settings/scheduling/`

**Finding:** No explicit role checks found in configs; all gated by Team Settings page access, which requires `isOrgAdmin()`.

### Crew Access Patterns

**File:** `/apps/web/src/lib/crew-actions.ts`

```typescript
export async function crewLogin(workspaceKey: string, pin: string): Promise<{ error: string } | { selectCrew?: ... }> {
  // PIN lookup (no Clerk)
  const [ws] = await adminDb
    .select({ tenantId: tenant.id })
    .from(tenant)
    .where(eq(tenant.publicKey, workspaceKey));
  
  const [crew] = await adminDb.select({ crewId: user.id, ... })
    .from(user)
    .where(and(eq(user.tenantId, ws.tenantId), eq(user.role, "crew"), eq(user.pinHash, pinHash)))
    .limit(1);
  // ...
}
```

**Finding:** ✅ **Crew is role-segregated**—can only log in with PIN, accesses only crew boarding pages.

---

## 4. Exception Cards & Today Queue: Rendering & Suppression

### Card Types in Today Page

**File:** `/apps/web/src/app/(app)/today/page.tsx`

Card components rendered for all authenticated users:

1. **VideoBatchCard** — awaiting rep/owner video approval
2. **StormBatchCard** — storm event processing
3. **MoveVerificationCard** — inspection move verification
4. **PartnerMergeCard** — partner deduplication
5. **PartnerGradeCard** — partner quality grading
6. **BlitzApprovalCard** — mobilization campaign approval (pending_approval status)
7. **BoostCard** — lead boost/canvass
8. **LeftoverCard** — unscheduled jobs
9. **Exception queue items** — sourced from `getExceptionQueue()` (operational)
10. **Task exceptions** — sourced from `loadOpenTaskExceptions()` (scoreboard-level)

### Current Rendering Logic

```typescript
export default async function TodayPage() {
  const [queue, taskExceptions, ...] = await Promise.all([...]);
  
  // All users see these—no role filtering
  const decisions: Decision[] = [
    ...queue.items.map(i => ({ kind: i.kind, ... })),
    ...taskExceptions.map(e => ({ kind: e.kind, ... })),
  ];
  
  return (
    <div>
      {/* All 5 card types rendered if matching data exists */}
      <VideoBatchCard /> 
      <StormBatchCard />
      <BlitzApprovalCard /> {/* No owner-only flag yet */}
      {/* ... */}
    </div>
  );
}
```

### Finding: No Owner-Only Suppression

✗ **No `owner_role` or similar field** on `taskException` table to gate card rendering.  
✗ **No role check** in card components (`BlitzApprovalCard`, `PartnerMergeCard`, etc.).  
✗ **All cards rendered for all roles**—only tenant isolation applies.

**Schema:** `/packages/db/src/schema/task-registry.ts`

```typescript
export const taskException = pgTable("task_exception", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  taskId: integer("task_id").notNull().references(() => taskRegistry.id),
  kind: text("kind").notNull(),          // e.g., "task_regression"
  severity: text("severity").notNull(),  // "high" | "medium"
  dollarImpactCents: integer("dollar_impact_cents").notNull().default(0),
  breakGlass: boolean("break_glass").notNull().default(false),
  breakGlassNotifiedAt: timestamp("break_glass_notified_at", { withTimezone: true }),
  openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
  firstViewedAt: timestamp("first_viewed_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  updatedAt: updatedAt(),
  // ← NO required_role or owner_only field
});
```

---

## 5. Break-Glass & High-Priority Alerts: Owner-Focused Routing

### Break-Glass Configuration

**File:** `/packages/db/src/schema/tenancy.ts`

```typescript
export const tenant = pgTable("tenant", {
  // ...
  breakGlass: jsonb("break_glass")
    .$type<{ min_dollars: number; deadline_hours: number }>()
    .notNull()
    .default({ min_dollars: 10000, deadline_hours: 48 }),
});
```

### Break-Glass Alert Delivery

**File:** `/packages/agents/src/break-glass.ts`

```typescript
export async function pageBreakGlass(tenantId: string, deps: BreakGlassDeps = {}): Promise<{ paged: number }> {
  const rows = await adminDb
    .select({ id: taskException.id, taskId: taskException.taskId, ... })
    .from(taskException)
    .innerJoin(taskRegistry, ...)
    .where(and(
      eq(taskException.tenantId, tenantId),
      eq(taskException.breakGlass, true),
      isNull(taskException.breakGlassNotifiedAt),
      isNull(taskException.resolvedAt),
    ));

  // Find the owner (and ONLY the owner)
  const [owner] = await adminDb
    .select({ phone: user.phone, email: user.email })
    .from(user)
    .where(and(eq(user.tenantId, tenantId), eq(user.role, "owner")))
    .limit(1);

  // Send SMS + email to owner only
  if (owner?.phone) { /* send SMS */ }
  if (owner?.email) { /* send email */ }
  
  // Mark as paged
  await adminDb.update(taskException)
    .set({ breakGlassNotifiedAt: now, ... })
    .where(inArray(taskException.id, rows.map(r => r.id)));
}
```

**Finding:** ✅ **Owner-exclusive alert routing** via role check (`eq(user.role, "owner")`).  
✗ **But:** No suppression of cards from other roles' views; everyone sees break-glass exceptions in the queue.

### Ops Digest (Nightly Email)

**File:** `/packages/agents/src/ops-digest.ts`

```typescript
export async function sendOpsDigest(tenantId: string): Promise<{ ok: boolean }> {
  // Finds the owner via role
  const [owner] = await adminDb
    .select({ email: user.email })
    .from(user)
    .where(and(eq(user.tenantId, tenantId), eq(user.role, "owner")))
    .limit(1);
  // Sends digest to owner only
}
```

**Finding:** ✅ **Owner-exclusive email delivery**.

---

## 6. Data Scoping: Row-Level Security (RLS)

### RLS Policy

**File:** `/packages/db/src/schema/_rls.ts`

```typescript
export const tenantIsolation = () =>
  pgPolicy("tenant_isolation", {
    as: "permissive",
    for: "all",
    to: "savvy_app",
    using: sql`tenant_id = current_setting('app.tenant_id')::uuid`,
    withCheck: sql`tenant_id = current_setting('app.tenant_id')::uuid`,
  });
```

**Applied to:** Every tenant-scoped table (user, job, lead, invoice, appointment, etc.)

**Scope:** Strictly **tenant-level**. No row-level role scoping (e.g., "rep X can only see leads assigned to them").

**Finding:** ✅ **Rock-solid tenant isolation**—no cross-tenant data leaks.  
✗ **No role-based row filtering**—all tenant members see all tenant data.

### Test Coverage

**File:** `/packages/db/tests/compliance.test.ts` (referenced in tenancy.ts)

Enforces: `cross-tenant reads must return empty`.

---

## 7. Specification Mapping: Where Office-Role Scoping Would Hook In

The spec calls for office roles to handle:
- **Scheduling** (book appointments, confirm crew, manage crew logistics)
- **Document chasing** (request missing documents, send reminders)
- **Collections calls** (coordinate payment follow-ups)
- **Endorsement wet-signatures** (chase e-sign, flag unsigned docs)

**Owner-only exclusions:**
- Money approvals over threshold (blitz, commissions, invoices)
- Break-glass exceptions
- M&A / business moves
- Configuration changes (price book, team settings, integrations)

### Where to Implement: Implementation Hooks

#### 1. **Task Exception Filtering**

**File to modify:** `/apps/web/src/app/(app)/today/page.tsx`

Current:
```typescript
const decisions: Decision[] = [
  ...queue.items.map(i => ({ kind: i.kind, ... })),
  ...taskExceptions.map(e => ({ kind: e.kind, ... })),
];
```

**Hook:** Filter `taskExceptions` by checking:
```typescript
const { role } = await getCurrentUser();
const visibleExceptions = taskExceptions.filter(e => {
  if (role === "owner") return true;  // owners see all
  if (role === "office") return !["money_approval", "break_glass", "m_and_a"].includes(e.kind);
  // reps see only task-level exceptions, not approval cards
  return false;
});
```

**Schema addition:** Add optional `required_role` or `owner_only` field to `taskException`:
```typescript
export const taskException = pgTable("task_exception", {
  // ... existing ...
  ownerOnly: boolean("owner_only").notNull().default(false),  // default: all see it
});
```

#### 2. **Money-Touching Action Guards**

**Files to modify:** 
- `/apps/web/src/lib/blitz-actions.ts` → `approveBlitzAction()`
- `/apps/web/src/lib/commission-actions.ts` (if exists) → commission approval
- `/apps/web/src/lib/invoice-actions.ts` (if exists) → send/approve invoice

**Pattern:**
```typescript
export async function approveBlitzAction(campaignId: string) {
  const { role } = await getCurrentUser();
  if (role !== "owner" && role !== "admin") {
    return { error: "Only owners/admins can approve campaigns over cap" };
  }
  // ... existing logic ...
}
```

#### 3. **Card Rendering Guards**

**Files to modify:**
- `/apps/web/src/app/(app)/today/BlitzApprovalCard.tsx`
- `/apps/web/src/app/(app)/today/PartnerMergeCard.tsx` (if owner-only)
- `/apps/web/src/app/(app)/today/PartnerGradeCard.tsx` (if owner-only)

**Pattern:**
```typescript
export function BlitzApprovalCard({ items }: { items: PendingBlitz[] }) {
  const { role } = useServerRole();  // or pass via props
  if (role !== "owner") return null;  // hide for office/rep
  // ... existing render ...
}
```

#### 4. **Scheduling/Crew Appointment Routes**

**File to gate:** `/apps/web/src/app/(app)/schedule/page.tsx` and components

Current: All authenticated users can create/modify appointments.

**Add guard:**
```typescript
export default async function SchedulePage() {
  const { role } = await getCurrentUser();
  // office + owner + admin can modify; rep is read-only or crew-assignment-only
  if (!["owner", "admin", "office"].includes(role)) {
    return <ReadOnlyScheduleView />;
  }
  // ... existing editable view ...
}
```

#### 5. **Settings Page Route Guards**

**Files to modify:**
- `/apps/web/src/app/(app)/settings/team/page.tsx` → gated to `owner` or `admin`
- `/apps/web/src/app/(app)/settings/price-book/page.tsx` → owner-only
- `/apps/web/src/app/(app)/settings/payments/page.tsx` → owner-only
- `/apps/web/src/app/(app)/settings/integrations/page.tsx` → owner-only
- `/apps/web/src/app/(app)/settings/quickbooks/page.tsx` → owner-only
- `/apps/web/src/app/(app)/settings/crew/page.tsx` → office or owner
- `/apps/web/src/app/(app)/settings/scheduling/page.tsx` → office or owner

**Pattern:**
```typescript
export default async function SettingsPage() {
  const { role } = await getCurrentUser();
  if (!["owner", "admin"].includes(role)) {
    return <Forbidden />;
  }
  // ...
}
```

#### 6. **Clerk Org Role Mapping Extension**

**File to modify:** `/packages/core/src/clerk-role.ts`

Currently: Only `owner`, `admin`, `rep` are mapped from Clerk. `office` and `crew` are manual.

**Future:** If Savvy gets a custom Clerk permission model for office/crew, extend mapping here.

#### 7. **Assignment & Rep List Filtering**

**File:** `/apps/web/src/lib/assignment-queries.ts`

Current:
```typescript
export async function getSalesReps(tenantId: string): Promise<RepOption[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({ id: user.id, name: user.name })
      .from(user)
      .where(and(eq(user.tenantId, tenantId), isNull(user.deactivatedAt), inArray(user.role, ["owner", "admin", "rep"]))),
  );
}
```

**Finding:** `getSalesReps()` already filters to `["owner", "admin", "rep"]` (excludes `office` and `crew`). ✅ Correct for now.

**When office role assigned to lead follow-up:** Modify to include `"office"` if needed:
```typescript
const rolesForAssignment = role === "office" ? ["owner", "admin", "rep"] : ["owner", "admin", "rep"];
```

---

## 8. Surprising Access Holes & Risks (As-Is, No Recommended Changes)

### 1. Clerk `org:admin` ≠ Savvy `admin`

**Risk:** Low, but confusing.

The Team Settings page gates on Clerk `org:admin` (via `isOrgAdmin()`), but the Savvy database has both `admin` and `owner` roles. A Clerk `org:member` promoted to Savvy `admin` by a Clerk `org:admin` **cannot then see the Team page** (because `isOrgAdmin()` checks Clerk role, not Savvy role).

**Implication:** Team management is tied to Clerk org admin, not Savvy role hierarchy. This is intentional (avoid privilege escalation), but means the UI and DB models diverge.

### 2. Invoice Send / Payment Collection: No Threshold Gates

**Risk:** Low operationally (no customer-facing leak), but open to misuse.

Any tenant member (rep, office, even a hypothetical non-admin) can:
- Send an invoice (no role check in invoice actions found)
- Record a payment (no role check in payment actions found)
- Adjust an invoice amount (no role check)

**Implication:** If an angry rep is fired, they could still send/record fake invoices before their account is revoked. Mitigation: Monitoring via `audit_log` (if implemented) and immediate deactivation.

### 3. Crew PIN as Sole Auth for BloomCam Surface

**Risk:** Medium for physical sites; low for data.

Crew members authenticate only via PIN (no Clerk). If a PIN is compromised, an attacker can:
- Clock crew in/out
- Upload photos
- Record work progress

**Implication:** PIN rotation and per-site PIN logs are critical (see `/apps/web/src/app/(crew)/crew/[key]/...`).

### 4. Office Role Unused

**Risk:** None today (not assigned), but future liability.

The `office` role exists in schema and TeamManager but is never checked in code. If an admin assigns a user to `office`, they get full tenant access (same as `rep`). This is **not a bug** until the spec is implemented.

### 5. Settings Gated to Clerk Org:Admin, Not Savvy Owner

**Risk:** Low, but worth documenting.

User A is promoted to Savvy `owner` by an admin but isn't in Clerk's `org:admin` group. User A **cannot access** `/settings/team`, even though their Savvy role suggests they should. This is intentional (org admin is the gating factor), but the UI doesn't explain it.

---

## 9. Current Access Control Matrix

| Action | Current Gating | Who Can Do It | Issues |
|---|---|---|---|
| View Today page | Tenant + Clerk auth | owner, admin, rep, office | No role filter; all see all cards |
| Approve blitz campaign | Tenant only | owner, admin, rep, office | ✗ NO role check |
| Send invoice | Tenant only | owner, admin, rep, office | ✗ NO role check |
| Record payment | Tenant only | owner, admin, rep, office | ✗ NO role check |
| Create/modify appointment | Tenant only | owner, admin, rep, office | ✗ NO role check |
| Book crew | Tenant only | owner, admin, rep, office | ✗ NO role check; crew can't see this page (different app root) |
| View pipeline | Tenant + Clerk auth | owner, admin, rep, office | No role filter |
| View partners ledger | Tenant + Clerk auth | owner, admin, rep, office | No role filter |
| Access team settings | `isOrgAdmin()` (Clerk) | Clerk `org:admin` only | ✗ Checks Clerk role, not Savvy role |
| Change user role | `isOrgAdmin()` + explicit tenant check | Clerk `org:admin` | ✅ Tenant-scoped; correct |
| Invite member | `isOrgAdmin()` + explicit tenant check | Clerk `org:admin` | ✅ Tenant-scoped; correct |
| Receive break-glass page | Direct query by role | Savvy `owner` only | ✅ Role checked; owner-exclusive |
| Receive nightly digest | Direct query by role | Savvy `owner` only | ✅ Role checked; owner-exclusive |
| Crew app login | PIN hash + role check | Savvy `crew` only | ✅ Role segregated |
| Crew photo upload | Crew session + auth | Savvy `crew` only | ✅ Role segregated |

---

## 10. RLS Enforcement Verification

**Test suite:** `/packages/db/tests/compliance.test.ts`

Confirms: A user from tenant A cannot see or modify rows from tenant B, regardless of role.

**Result:** ✅ **PASS**—tenant isolation is enforced at the database layer, independent of role.

---

## 11. Recommendations for Phase 26 Slice 6

This audit is **documentation-only**. No implementation is suggested, but the infrastructure is clear:

1. **Add `ownerOnly` boolean** to `taskException` schema (default false).
2. **Filter exception cards** in `/today` page based on role and `ownerOnly` flag.
3. **Guard money-touching actions** with role checks (`owner` or `admin` only).
4. **Gate settings routes** to `owner` + `admin` (not just Clerk `org:admin`).
5. **Document Clerk vs. Savvy role divergence** for admins (Team Settings page should clarify).

All changes are **additive** (no breaking changes to auth flow). Tenant isolation remains the foundation.

---

## 12. Files Modified / Reviewed (No Changes Made)

### Schema & Core

- `/packages/db/src/schema/tenancy.ts` — user.role enum
- `/packages/db/src/schema/task-registry.ts` — taskException table (no role field)
- `/packages/core/src/enums.ts` — USER_ROLE enum
- `/packages/core/src/clerk-role.ts` — Clerk→Savvy mapping
- `/packages/db/src/schema/_rls.ts` — RLS policy (tenant-only)

### Middleware & Auth

- `/apps/web/src/middleware.ts` — routes (no role checks)
- `/apps/web/src/lib/authz.ts` — `isOrgAdmin()` (Clerk role)
- `/apps/web/src/lib/current-user.ts` — role assignment on first login

### Routes & Pages

- `/apps/web/src/app/(app)/layout.tsx` — (app) entry point (no role gating)
- `/apps/web/src/app/(app)/today/page.tsx` — cards (no role filtering)
- `/apps/web/src/app/(app)/settings/team/page.tsx` — team mgmt (gated to Clerk admin)
- `/apps/web/src/app/(app)/settings/*/` — all settings (tenant + auth, no role check)
- `/apps/web/src/app/(crew)/layout.tsx` — crew app (PIN-gated)

### Server Actions

- `/apps/web/src/lib/blitz-actions.ts` — approveBlitzAction (no role check)
- `/apps/web/src/lib/team-actions.ts` — changeUserRole (gated to Clerk admin, ✅)
- `/apps/web/src/lib/crew-actions.ts` — crewLogin (role-scoped to crew, ✅)

### Agents

- `/packages/agents/src/break-glass.ts` — pages owner only (✅ role-checked)
- `/packages/agents/src/ops-digest.ts` — sends to owner only (✅ role-checked)

### Queries

- `/apps/web/src/lib/assignment-queries.ts` — getSalesReps (filters to sales roles, ✅)
- `/apps/web/src/lib/exception-queries.ts` — getExceptionQueue (no role filtering)
- `/apps/web/src/lib/today-queries.ts` — getTodayMoney, getTodayDigest (no role filtering)

---

**End of Audit**

---

*This document is the Phase 26 Slice 6 baseline for a standalone PR documenting the current state of access control in Savvy CRM. It makes no code changes and serves as the owner-approval reference for the proposed office-role permission matrix.*

---

# PROPOSED: Office-Role Permission Matrix (FOR OWNER APPROVAL)

Per spec (#353): the owner approves this matrix via PR review BEFORE any implementation.
Nothing below is built yet. Approval of this PR = approval to implement slice 6b exactly as specified here.

## Design principles

1. **Additive only.** Tenant RLS stays the foundation; role scoping layers on top. No existing role loses access.
2. **Office = coordination, not money.** Office staff run the day (scheduling, document chasing, collections calls, endorsement wet-signatures) but never approve spend, discounts, or see break-glass.
3. **Deny-by-flag, not allow-by-list, for cards**: exception cards gain `owner_role` (`'owner' | 'any'`, default `'any'`). Owner-tier cards NEVER render for office (red-path test) — a new card kind forgotten in a list defaults to visible-to-office, but money/break-glass/M&A generators explicitly stamp `owner_role='owner'`.

## Proposed route × role matrix (TO-BE)

| Route | owner | admin | office | rep | crew |
|---|---|---|---|---|---|
| /today (scoped) | full | full | **scoped cards only** | full | — |
| /schedule, appointments | full | full | **full** | full | — |
| /leads, /jobs (view/edit) | full | full | full | full | — |
| /estimates (draft/send) | full | full | view + chase docs | full | — |
| /invoices (send/record payment) | full | full | **view + collections calls log** | full | — |
| /partners (ledger, quarterly) | full | full | view | view | — |
| /production | full | full | full | full | — |
| /settings/* (incl. team) | full | full | — | — | — |
| /approvals (money cards) | full | full | — | — | — |
| (crew) BloomCam surface | — | — | — | — | PIN |

## Proposed action gating (TO-BE)

| Action | Gate |
|---|---|
| Approve blitz campaign / fill discount card / estimate-over-threshold | `owner`, `admin` |
| Send invoice / record payment | `owner`, `admin`, `rep` (office: log collections call only) |
| Break-glass acknowledge | `owner` only (unchanged) |
| Change roles / invite / settings | `owner`, `admin` (replaces Clerk-org:admin-only check) |
| Scheduling (create/move appointments) | all app roles incl. `office` |
| Endorsement wet-signature task complete | `owner`, `admin`, `office` |

## Office-scoped Today (their cards)

INCLUDE: scheduling gaps/conflicts, document-chasing (unsigned endorsements, missing docs), collections-call reminders, appointment confirmations.
EXCLUDE (owner_role='owner'): money approvals over threshold (blitz/fill/estimate cards), break-glass, M&A/valuation cards, partner-ledger exceptions.

## Implementation shape (slice 6b, after approval)

1. Mig 0107: `task_exception.owner_role text NOT NULL DEFAULT 'any'`; generators for money/break-glass/M&A stamp `'owner'`.
2. `requireRole(action, roles)` helper in `apps/web/src/lib/authz.ts` (Savvy role, not Clerk); guards the actions table above.
3. `/today` query filters `owner_role='any'` for office; settings gate moves to Savvy `owner|admin`.
4. Red-path tests: owner-tier card never renders for office (e2e); office cannot invoke approve actions (unit); role change audit-logged.

## Open questions for the owner

1. Should `rep` keep invoice-send/payment-record (current reality), or restrict to owner/admin + office-logged calls?
2. Does office need /partners view at all, or hide entirely?
3. M&A cards don't exist yet (Owner's Room) — the `owner_role` field ships ready for them. OK?
