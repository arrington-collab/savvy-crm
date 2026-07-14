# Canvass Slice 3 — Digital Rep ID (QR) & GPS Breadcrumbs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public scannable rep-ID page (identity + license + insurance, homeowner capture form, per-tenant Meta pixel) with an in-app QR, plus manager-visible GPS trails recorded while the field app is open.

**Architecture:** Two new RLS'd tables (`canvass_scan`, `canvass_ping`). The ID page is a public Next.js server component keyed by the rep's uuid (adminDb read, active-reps-only). Scans are the only public write — strict whitelist + IP rate limit. Pings are session-scoped writes, manager-only reads, 30-day retention via a daily Inngest cron. Field app adds a QR modal (offline-cached), company-config fields, a dashboard scans card, a ping buffer on the existing 30-sec sync, and a manager trails toggle.

**Tech Stack:** TypeScript, Drizzle + Postgres RLS, Next.js App Router (public page + route handlers), Inngest, Vitest, vanilla-JS PWA.

## Global Constraints

- **Tenant isolation:** both new tables get `tenantId` + `tenantIsolation()` RLS (match `canvassAlert` conventions exactly: `idCol()`, `createdAt()`, index-array callback). All tenant-scoped access via `withTenant`.
- **Public surface is minimal:** `/id/<repId>` (page) exposes ONLY rep name/photo, tenant name/logo, and `tenant.settings.canvassId` fields; deactivated/unknown rep → 404. `POST /api/canvass/scan` is the only public write: field whitelist, rep-active check, IP rate limit, response `{ok:true}` only.
- **Ping scoping:** POST writes only the session rep's points (`repId` from bearer session, never the body). GET is `isCanvassManager`-gated. Reps can never read teammates' trails.
- **Rate-limit buckets:** only real ones — `canvass` for writes, `canvass-read` for authed reads (no invented buckets).
- **The rep script / page copy must use the protection framing** (verified identity + insured), never a liability-waiver claim. Acknowledgment wording exactly: *"I confirm {Company} has my permission to access my property, including the roof, for inspection."*
- **Additive only** — no existing behavior changes beyond documented additions (company route gains POST; middleware gains `/^\/id\//`).

## File Structure

- `packages/db/src/schema/canvass.ts` — append `canvassScan` + `canvassPing`.
- `packages/db/drizzle/NNNN_*.sql` — generated.
- `packages/db/src/lifecycle/canvass-scan.ts`, `canvass-ping.ts` — new. `packages/db/src/index.ts` — re-exports.
- `packages/db/tests/canvass-scan-ping.test.ts` — new.
- `apps/web/src/app/api/canvass/scan/route.ts` — new (public POST).
- `apps/web/src/app/api/canvass/scans/route.ts` — new (manager GET).
- `apps/web/src/app/api/canvass/pings/route.ts` — new (POST + GET).
- `apps/web/src/app/api/canvass/company/route.ts` — modify (add manager POST).
- `apps/web/src/app/id/[repId]/page.tsx` + `apps/web/src/app/id/[repId]/ScanForm.tsx` — new public page.
- `apps/web/src/middleware.ts` — modify (`/^\/id\//` + api allowlist entries).
- `packages/agents/src/functions/canvass-ping-prune.ts` + `packages/agents/src/index.ts` — new cron.
- `~/Sites/savvy-canvass/index.html` + `sw.js` — v1.21.0-beta.

---

### Task 1: DB — canvass_scan + canvass_ping tables + migration

**Files:** Modify `packages/db/src/schema/canvass.ts`; generate migration.

**Interfaces:** mirrors `canvassAlert` (end of file) exactly — `idCol()`, `createdAt()`, `tenantIsolation(t)`, no `.enableRLS()` chain (policy detection).

- [ ] **Step 1:** Read `canvassAlert` in `packages/db/src/schema/canvass.ts`; append with the same helpers/imports (`doublePrecision` may need adding to the import — `canvassKnock` already uses it):

```ts
export const canvassScan = pgTable(
  "canvass_scan",
  {
    id: idCol(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
    repId: uuid("rep_id").notNull().references(() => canvassRep.id, { onDelete: "cascade" }),
    name: text("name"),
    phone: text("phone"),
    ack: boolean("ack").notNull().default(false),
    ackAt: timestamp("ack_at", { withTimezone: true }),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("canvass_scan_tenant_created_idx").on(t.tenantId, t.createdAt), tenantIsolation(t)],
);

export const canvassPing = pgTable(
  "canvass_ping",
  {
    id: idCol(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
    repId: uuid("rep_id").notNull().references(() => canvassRep.id, { onDelete: "cascade" }),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("canvass_ping_tenant_rep_at_idx").on(t.tenantId, t.repId, t.at), tenantIsolation(t)],
);
```

(`boolean` import may also need adding — check the existing import block.)

- [ ] **Step 2:** `pnpm db:generate` → confirm the new `NNNN_*.sql` creates exactly these two tables (RLS enable + `savvy_app` `tenant_isolation` policies + FKs + indexes), nothing else. `pnpm db:up && pnpm db:migrate` clean.
- [ ] **Step 3:** Commit schema + drizzle dir: `feat(canvass): canvass_scan + canvass_ping tables (rep ID scans, GPS trails)`.

---

### Task 2: DB — scan + ping lifecycle

**Files:** Create `packages/db/src/lifecycle/canvass-scan.ts`, `canvass-ping.ts`; modify `packages/db/src/index.ts`; test `packages/db/tests/canvass-scan-ping.test.ts`.

- [ ] **Step 1:** `canvass-scan.ts`:

```ts
import { desc, eq } from "drizzle-orm";
import type { Tx } from "../tenant";
import { canvassScan, canvassRep } from "../schema/index";

export interface CreateScanArgs {
  tenantId: string; repId: string;
  name?: string | null; phone?: string | null; ack?: boolean; userAgent?: string | null;
}

// Homeowner scanned a rep's ID and submitted the capture form.
export async function createScan(tx: Tx, a: CreateScanArgs): Promise<{ id: string }> {
  const now = new Date();
  const [row] = await tx.insert(canvassScan).values({
    tenantId: a.tenantId, repId: a.repId,
    name: a.name ?? null, phone: a.phone ?? null,
    ack: !!a.ack, ackAt: a.ack ? now : null,
    userAgent: a.userAgent ?? null,
  }).returning({ id: canvassScan.id });
  return { id: row!.id };
}

export interface ScanRow {
  id: string; repId: string; repName: string | null;
  name: string | null; phone: string | null; ack: boolean; createdAt: Date;
}

// Recent scans for the manager dashboard card.
export async function listScans(tx: Tx, tenantId: string, limit = 50): Promise<ScanRow[]> {
  const rows = await tx
    .select({ id: canvassScan.id, repId: canvassScan.repId, repName: canvassRep.name,
      name: canvassScan.name, phone: canvassScan.phone, ack: canvassScan.ack, createdAt: canvassScan.createdAt })
    .from(canvassScan)
    .leftJoin(canvassRep, eq(canvassRep.id, canvassScan.repId))
    .orderBy(desc(canvassScan.createdAt)).limit(limit);
  return rows;
}
```

- [ ] **Step 2:** `canvass-ping.ts`:

```ts
import { and, eq, sql, asc } from "drizzle-orm";
import type { Tx } from "../tenant";
import { canvassPing } from "../schema/index";

export interface PingPoint { lat: number; lng: number; ts: number }

// Batch-insert a rep's trail points (max 200/batch, clamped).
export async function insertPings(tx: Tx, tenantId: string, repId: string, points: PingPoint[]): Promise<number> {
  const clean = points
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.ts))
    .slice(0, 200);
  if (clean.length === 0) return 0;
  await tx.insert(canvassPing).values(
    clean.map((p) => ({ tenantId, repId, lat: p.lat, lng: p.lng, at: new Date(p.ts) })),
  );
  return clean.length;
}

// All reps' points for one tenant-local day, grouped per rep, time-ordered.
export async function listPingsForDay(
  tx: Tx, tenantId: string, tz: string, date: string,
): Promise<{ repId: string; points: [number, number, number][] }[]> {
  const rows = await tx
    .select({ repId: canvassPing.repId, lat: canvassPing.lat, lng: canvassPing.lng, at: canvassPing.at })
    .from(canvassPing)
    .where(sql`(${canvassPing.at} AT TIME ZONE ${tz})::date = ${date}::date`)
    .orderBy(asc(canvassPing.at));
  const by = new Map<string, [number, number, number][]>();
  for (const r of rows) {
    if (!by.has(r.repId)) by.set(r.repId, []);
    by.get(r.repId)!.push([r.lat, r.lng, r.at.getTime()]);
  }
  return [...by.entries()].map(([repId, points]) => ({ repId, points }));
}
```

- [ ] **Step 3:** Re-export both modules' fns/types in `packages/db/src/index.ts` (mirror the canvass-alert line).
- [ ] **Step 4:** Test `canvass-scan-ping.test.ts` (model on `canvass-alert.test.ts` — seed tenant + 2 reps; afterAll cleans scans/pings/reps/tenant, ends pools):

```ts
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { adminDb, adminPool, pool, eq, tenant, canvassRep, canvassScan, canvassPing } from "../src/index";
import { withTenant } from "../src/tenant";
import { createScan, listScans } from "../src/lifecycle/canvass-scan";
import { insertPings, listPingsForDay } from "../src/lifecycle/canvass-ping";

let tId: string, repA: string, repB: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "Scan Co", publicKey: `sc-${Date.now()}`, clerkOrgId: `org_sc_${Date.now()}`, timezone: "America/Phoenix" }).returning();
  tId = t!.id;
  const reps = await adminDb.insert(canvassRep).values([
    { tenantId: tId, name: "Rep A", pinHash: "x" }, { tenantId: tId, name: "Rep B", pinHash: "x" },
  ]).returning();
  repA = reps[0]!.id; repB = reps[1]!.id;
});

afterAll(async () => {
  await adminDb.delete(canvassPing).where(eq(canvassPing.tenantId, tId));
  await adminDb.delete(canvassScan).where(eq(canvassScan.tenantId, tId));
  await adminDb.delete(canvassRep).where(eq(canvassRep.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end(); await adminPool.end();
});

describe("scans", () => {
  it("creates with ack stamping and lists newest-first with rep name", async () => {
    await withTenant(tId, (tx) => createScan(tx, { tenantId: tId, repId: repA, name: "Jane HO", phone: "480-555-1111", ack: true }));
    await withTenant(tId, (tx) => createScan(tx, { tenantId: tId, repId: repB, name: "Bob HO", ack: false }));
    const scans = await withTenant(tId, (tx) => listScans(tx, tId));
    expect(scans.length).toBe(2);
    expect(scans[0]!.name).toBe("Bob HO"); // newest first
    expect(scans[0]!.repName).toBe("Rep B");
    const jane = scans.find((s) => s.name === "Jane HO")!;
    expect(jane.ack).toBe(true);
    const [raw] = await adminDb.select().from(canvassScan).where(eq(canvassScan.id, jane.id));
    expect(raw!.ackAt).not.toBeNull();
  });
});

describe("pings", () => {
  it("clamps batches, buckets by tenant-local day, groups per rep in time order", async () => {
    const base = Date.parse("2026-07-13T20:00:00.000Z"); // 1pm Phoenix
    const n = await withTenant(tId, (tx) => insertPings(tx, tId, repA, [
      { lat: 33.40, lng: -111.80, ts: base }, { lat: 33.41, lng: -111.81, ts: base + 60000 },
      { lat: NaN as unknown as number, lng: 0, ts: base }, // dropped
    ]));
    expect(n).toBe(2);
    await withTenant(tId, (tx) => insertPings(tx, tId, repB, [{ lat: 33.50, lng: -111.90, ts: base + 120000 }]));
    const day = await withTenant(tId, (tx) => listPingsForDay(tx, tId, "America/Phoenix", "2026-07-13"));
    expect(day.length).toBe(2);
    const a = day.find((d) => d.repId === repA)!;
    expect(a.points.length).toBe(2);
    expect(a.points[0]![2]).toBeLessThan(a.points[1]![2]); // time-ordered
    // outside the local day → excluded
    const other = await withTenant(tId, (tx) => listPingsForDay(tx, tId, "America/Phoenix", "2026-07-12"));
    expect(other.find((d) => d.repId === repA)).toBeUndefined();
  });
});
```

- [ ] **Step 5:** Clear synthetic debris, run `npx vitest run packages/db/tests/canvass-scan-ping.test.ts --no-file-parallelism` → PASS; `pnpm typecheck` clean. Commit: `feat(canvass): scan + ping lifecycle`.

---

### Task 3: Web — public scan POST, manager scans GET, company POST, middleware

**Files:** Create `apps/web/src/app/api/canvass/scan/route.ts`, `apps/web/src/app/api/canvass/scans/route.ts`; modify `apps/web/src/app/api/canvass/company/route.ts`, `apps/web/src/middleware.ts`.

- [ ] **Step 1:** `scan/route.ts` — PUBLIC POST (the homeowner has no session). Resolve the rep via adminDb, then insert via `withTenant`:

```ts
import { NextResponse } from "next/server";
import { z } from "@savvy/core";
import { adminDb, withTenant, canvassRep, eq, createScan } from "@savvy/db";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

const bodySchema = z.object({
  repId: z.string().uuid(),
  name: z.string().max(120).optional(),
  phone: z.string().max(40).optional(),
  ack: z.boolean().optional(),
});

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "POST, OPTIONS") });
}

// PUBLIC write (homeowner ID-scan capture): strict whitelist, active-rep check,
// hard per-IP limit. Echoes nothing back.
export async function POST(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });

  const { ok } = await checkRateLimit("canvass", `scan:${clientIp(req.headers)}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);

  let json: unknown;
  try { json = await req.json(); } catch { return reply({ error: "invalid json" }, 400); }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return reply({ error: "bad_request" }, 400);
  const b = parsed.data;
  if (!b.name?.trim() && !b.phone?.trim()) return reply({ error: "name_or_phone" }, 400);

  const [rep] = await adminDb
    .select({ tenantId: canvassRep.tenantId, active: canvassRep.active })
    .from(canvassRep).where(eq(canvassRep.id, b.repId));
  if (!rep || rep.active === false) return reply({ error: "not_found" }, 404);

  await withTenant(rep.tenantId, (tx) =>
    createScan(tx, {
      tenantId: rep.tenantId, repId: b.repId,
      name: b.name?.trim() || null, phone: b.phone?.trim() || null, ack: !!b.ack,
      userAgent: (req.headers.get("user-agent") || "").slice(0, 300) || null,
    }),
  );
  return reply({ ok: true }, 201);
}
```

(Confirm `z` is re-exported from `@savvy/core` — the canvass login route imports it that way. If `clientIp` lives in `@/lib/rate-limit`, reuse; it does — the login route uses it.)

- [ ] **Step 2:** `scans/route.ts` — manager GET, mirroring the spiffs route shape: bearer → 401; `canvass-read` limit; `isCanvassManager` inside `withTenant` → 403; `listScans(tx, tenantId)` → `{ scans }`.

- [ ] **Step 3:** `company/route.ts` — ADD a POST (leave GET + OPTIONS as-is, but extend OPTIONS allow-methods to `"GET, POST, OPTIONS"` in both handlers' cors calls). Manager-only merge into `tenant.settings.canvassId`:

```ts
// append imports: verifyCanvassToken, bearerToken from "@/lib/canvass-session";
// withTenant, isCanvassManager, tenant, eq from "@savvy/db"; checkRateLimit from "@/lib/rate-limit";

const ID_FIELDS = ["licenseNo", "insuranceCarrier", "insurancePolicy", "insurancePhone", "coiUrl", "metaPixelId"] as const;

export async function POST(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });
  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);
  let json: unknown; try { json = await req.json(); } catch { return reply({ error: "invalid json" }, 400); }
  const body = (json ?? {}) as Record<string, unknown>;
  const patch: Record<string, string> = {};
  for (const f of ID_FIELDS) if (typeof body[f] === "string") patch[f] = (body[f] as string).slice(0, 300);
  const done = await withTenant(sess.tenantId, async (tx) => {
    if (!(await isCanvassManager(tx, sess.tenantId, sess.repId))) return false;
    const [t] = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, sess.tenantId));
    const settings = (t?.settings ?? {}) as Record<string, unknown>;
    const prev = (settings.canvassId ?? {}) as Record<string, string>;
    await tx.update(tenant).set({ settings: { ...settings, canvassId: { ...prev, ...patch } } }).where(eq(tenant.id, sess.tenantId));
    return true;
  });
  if (!done) return reply({ error: "forbidden" }, 403);
  return reply({ ok: true }, 200);
}
```

Also extend the GET to return the `canvassId` object (so the field app can prefill the manager form and the rep modal can show insurance presence): add `canvassId: settings.canvassId ?? null` to the GET response (it's company-level info a tenant chose to publish on a public ID page — not sensitive).

- [ ] **Step 4:** `middleware.ts` — add THREE entries to `PUBLIC`, dropping nothing: `/^\/id\//` (page prefix), add `scan|scans|pings` to the canvass api alternation (`...|alerts|scan|scans|pings)$/`).

- [ ] **Step 5:** `pnpm typecheck && pnpm lint` clean. Commit: `feat(canvass): scan capture endpoints + company ID config + /id public route`.

---

### Task 4: Web — pings endpoints

**Files:** Create `apps/web/src/app/api/canvass/pings/route.ts`.

- [ ] **Step 1:** POST (rep writes own trail) + GET (manager, tenant-local day — copy the eod tz pattern):

```ts
import { NextResponse } from "next/server";
import { dateKeyInTimeZone } from "@savvy/core";
import { withTenant, tenant, eq, insertPings, listPingsForDay, isCanvassManager } from "@savvy/db";
import { verifyCanvassToken, bearerToken } from "@/lib/canvass-session";
import { canvassCors } from "@/lib/canvass-cors";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export function OPTIONS(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: canvassCors(req, "GET, POST, OPTIONS") });
}

// POST — the signed-in rep uploads their own trail buffer (repId from session).
export async function POST(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });
  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);
  let json: unknown; try { json = await req.json(); } catch { return reply({ error: "invalid json" }, 400); }
  const points = (json as { points?: unknown })?.points;
  if (!Array.isArray(points)) return reply({ error: "bad_request" }, 400);
  const n = await withTenant(sess.tenantId, (tx) =>
    insertPings(tx, sess.tenantId, sess.repId, points as { lat: number; lng: number; ts: number }[]),
  );
  return reply({ ok: true, stored: n }, 201);
}

// GET ?date=YYYY-MM-DD — manager-only day trails for the whole team.
export async function GET(req: Request): Promise<NextResponse> {
  const headers = canvassCors(req, "GET, POST, OPTIONS");
  const reply = (b: unknown, s: number) => NextResponse.json(b, { status: s, headers });
  const sess = verifyCanvassToken(bearerToken(req.headers));
  if (!sess) return reply({ error: "unauthorized" }, 401);
  const { ok } = await checkRateLimit("canvass-read", `${sess.tenantId}:${sess.repId}`);
  if (!ok) return reply({ error: "rate_limited" }, 429);
  const out = await withTenant(sess.tenantId, async (tx) => {
    if (!(await isCanvassManager(tx, sess.tenantId, sess.repId))) return null;
    const [tRow] = await tx.select({ timezone: tenant.timezone }).from(tenant).where(eq(tenant.id, sess.tenantId));
    const tz = tRow?.timezone ?? "UTC";
    const date = new URL(req.url).searchParams.get("date") || dateKeyInTimeZone(new Date(), tz);
    return { date, reps: await listPingsForDay(tx, sess.tenantId, tz, date) };
  });
  if (out === null) return reply({ error: "forbidden" }, 403);
  return reply(out, 200);
}
```

- [ ] **Step 2:** typecheck + lint clean. Commit: `feat(canvass): ping upload + manager day-trails endpoints`.

---

### Task 5: Web — public /id/[repId] page

**Files:** Create `apps/web/src/app/id/[repId]/page.tsx` (server component) + `apps/web/src/app/id/[repId]/ScanForm.tsx` (client).

- [ ] **Step 1:** `page.tsx` — adminDb read; `notFound()` unless rep exists AND active; UUID-validate the param before querying (bad param → 404, not a DB error):

```tsx
import { notFound } from "next/navigation";
import Script from "next/script";
import { adminDb, canvassRep, tenant, eq } from "@savvy/db";
import { ScanForm } from "./ScanForm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CanvassId {
  licenseNo?: string; insuranceCarrier?: string; insurancePolicy?: string;
  insurancePhone?: string; coiUrl?: string; metaPixelId?: string;
}

export default async function RepIdPage({ params }: { params: Promise<{ repId: string }> }) {
  const { repId } = await params;
  if (!UUID_RE.test(repId)) notFound();
  const [row] = await adminDb
    .select({ name: canvassRep.name, photoUrl: canvassRep.photoUrl, active: canvassRep.active,
      companyName: tenant.name, settings: tenant.settings })
    .from(canvassRep).innerJoin(tenant, eq(tenant.id, canvassRep.tenantId))
    .where(eq(canvassRep.id, repId));
  if (!row || row.active === false) notFound();
  const settings = (row.settings ?? {}) as { canvassLogo?: string; canvassId?: CanvassId };
  const info = settings.canvassId ?? {};
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  return (
    <main className="mx-auto max-w-md p-6 font-sans">
      {info.metaPixelId ? (
        <Script id="fbp" strategy="afterInteractive">{`
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init','${info.metaPixelId.replace(/[^0-9]/g, "")}');fbq('track','PageView');`}</Script>
      ) : null}
      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <div className="flex items-center gap-4">
          {row.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={row.photoUrl} alt={row.name} className="h-20 w-20 rounded-full object-cover" />
          ) : (
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gray-900 text-2xl font-bold text-white">{row.name.slice(0, 1)}</div>
          )}
          <div>
            <h1 className="text-xl font-bold">{row.name}</h1>
            <p className="text-sm text-gray-500">{row.companyName}</p>
            <p className="mt-1 inline-block rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800">✓ Verified active rep — {today}</p>
          </div>
        </div>
        <dl className="mt-6 space-y-2 text-sm">
          {info.licenseNo ? (<div className="flex justify-between"><dt className="text-gray-500">Contractor license</dt><dd className="font-semibold">{info.licenseNo}</dd></div>) : null}
          {info.insuranceCarrier ? (<div className="flex justify-between"><dt className="text-gray-500">Insured by</dt><dd className="font-semibold">{info.insuranceCarrier}</dd></div>) : null}
          {info.insurancePolicy ? (<div className="flex justify-between"><dt className="text-gray-500">Policy #</dt><dd className="font-semibold">{info.insurancePolicy}</dd></div>) : null}
          {info.insurancePhone ? (<div className="flex justify-between"><dt className="text-gray-500">Verify coverage</dt><dd className="font-semibold">{info.insurancePhone}</dd></div>) : null}
        </dl>
        {info.coiUrl ? (<a href={info.coiUrl} target="_blank" rel="noopener noreferrer" className="mt-3 block text-sm font-semibold text-blue-600 underline">View certificate of insurance</a>) : null}
        <p className="mt-4 text-xs text-gray-500">This page confirms the person at your door works with {row.companyName}, is licensed where required, and that the company carries active liability insurance for work on your property.</p>
      </div>
      <ScanForm repId={repId} company={row.companyName} repName={row.name} hasPixel={!!info.metaPixelId} />
    </main>
  );
}
```

- [ ] **Step 2:** `ScanForm.tsx` — client component: name + phone inputs (either), the acknowledgment checkbox with the EXACT spec wording, POSTs to `/api/canvass/scan`, fires `fbq('track','Lead')` on success when `hasPixel`, then a thank-you card ("You're covered — {repName} is verified and insured."). Handle 429/400 with a soft inline error. Keep it ~60 lines, Tailwind, no external deps.

- [ ] **Step 3:** Verify locally that `/id/<garbage>` 404s and `pnpm typecheck && pnpm lint` are clean (rendering against local DB is covered by the deploy smoke; no page unit test in v1). Commit: `feat(canvass): public rep ID page with capture + pixel`.

---

### Task 6: Agents — ping retention cron

**Files:** Create `packages/agents/src/functions/canvass-ping-prune.ts`; register in `packages/agents/src/index.ts` (3 ways).

- [ ] **Step 1:**

```ts
import { adminDb, canvassPing, sql } from "@savvy/db";
import { inngest } from "../client";

// Trails are an operational aid, not an archive: keep 30 days, prune daily.
export const canvassPingPrune = inngest.createFunction(
  { id: "canvass-ping-prune" },
  { cron: "0 10 * * *" }, // ~3am Phoenix
  async ({ step }) => {
    const pruned = await step.run("prune", async () => {
      const res = await adminDb.delete(canvassPing)
        .where(sql`${canvassPing.at} < now() - interval '30 days'`)
        .returning({ id: canvassPing.id });
      return res.length;
    });
    return { pruned };
  },
);
```

(Confirm `canvassPing` and `sql` are exported from `@savvy/db`; add `canvassPing` to whatever schema barrel export pattern exists — `export * from "./schema/index"` likely already covers it.)

- [ ] **Step 2:** Register import/export/`functions[]` like `challengeSettleHourly`. Typecheck clean. Commit: `feat(canvass): 30-day ping retention cron`.

---

### Task 7: Field app — My ID QR, company config, scans card, trail buffer, manager trails (v1.21.0-beta)

**Files:** `~/Sites/savvy-canvass/index.html`, `sw.js`. Locate everything by CONTENT (line numbers drift).

- [ ] **Step 1 — QR lib loader** (copy the `loadChartJs` lazy pattern exactly):

```js
let qrReady=null;
function loadQr(){
  if(window.qrcode)return Promise.resolve();
  if(qrReady)return qrReady;
  qrReady=new Promise(res=>{const s=document.createElement('script');
    s.src='https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
    s.integrity='sha384-mZT2gIty7ZDdOGkxfP6joZcYdMW1Jvj9dRlfpTmaJAKKXTqzygtB22k7FLe+KZC1';
    s.crossOrigin='anonymous';s.onload=res;s.onerror=()=>{qrReady=null;res()};
    document.head.appendChild(s)});
  return qrReady;
}
```

- [ ] **Step 2 — 🪪 My ID button + modal.** Header button next to `#alertBell` (visible when `canSell()`): opens a modal (reuse the `detailModal` pattern or a new `#idModal`) showing a large QR of `crmBase()+'/id/'+cur`, the rep name, and the approved script: *"Scan this before anyone gets on your roof — it shows exactly who I am, our license, and proof we're insured."* QR render: `loadQr().then(()=>{const q=qrcode(0,'M');q.addData(url);q.make();el.innerHTML=q.createImgTag(6,8)})`; on success cache `el.innerHTML` in `localStorage(LS+'_qrid_'+cur)` and render from that cache first (offline support). Never block on the network.

- [ ] **Step 3 — Company ID config (manager).** In the Company card (where `coWebhook` lives), add inputs: license #, insurance carrier, policy #, insurance phone, COI URL, Meta Pixel ID, prefilled from `GET /api/canvass/company?key=...` (`canvassId` in the response) and saved via `POST` `canvassBase()+'/company'` with `authHeaders()` (manager). Flash on save.

- [ ] **Step 4 — Dashboard scans card (manager).** In `renderDash()`, add an "🪪 ID scans" card: fetch `canvassBase()+'/scans'` with `authHeaders()`; list up to 15: `esc(name/phone)` · rep · `ack?'✓ access OK':''` · `fmtDT`. Empty state "No scans yet — reps share their ID with 🪪".

- [ ] **Step 5 — Trail buffer.** In `startTracking()`'s `watchPosition` callback, append to a persisted buffer when moved ≥25 m from the last buffered point (use `canvassHaversineMeters`-style helper already in-app — `kmBetween` exists; 25 m = 0.025 km) OR ≥60 s since the last point: `_trail.push([Date.now(),lat,lng])`, cap 500, persist `localStorage(LS+'_trail')`. Only when `canSell()` && `getAuth()`. In `syncTick()`, flush: POST `canvassBase()+'/pings'` `{points:_trail.map(([ts,lat,lng])=>({ts,lat,lng}))}`; clear buffer on `r.ok`.

- [ ] **Step 6 — Manager trails toggle.** Add a 👣 button to `.mapctl` (manager only — hide otherwise): toggles `trailLayer` (an `L.layerGroup`); on enable, fetch `canvassBase()+'/pings'`, draw one `L.polyline(points.map(p=>[p[0],p[1]]),{color:user(repId).color||'#4f46e5',weight:3,opacity:.75})` per rep with a tooltip `esc(user(repId).name)+' · '+points.length+' pts'`; on disable, clear. Points arrive `[lat,lng,ts]`.

- [ ] **Step 7 — Versions + validation + deploy.** `APP_VERSION='1.21.0-beta'`; `sw.js` `V='canvass-v1.21.0'`. Run the `new Function` inline-script parse check + `node --check sw.js`. Commit; deploy `npx wrangler pages deploy . --project-name savvy-canvass --commit-dirty=true`; confirm the prod alias serves 1.21.0-beta.

---

## Post-execution (controller)

1. Full suite (debris-clear, `--no-file-parallelism`) + typecheck + lint on the branch, then final whole-branch review (opus) — adversarial on the PUBLIC surface (`/id`, `/scan`) and ping scoping.
2. Merge to main; apply the migration to prod Supabase as the next prod number (`0080_canvass_scan_ping`); deploy backend.
3. Live checks: `/id/<bogus-uuid>` → 404; `/api/canvass/scan` with no body → 400, hammered → 429; `/api/canvass/pings` unauth → 401; field app v1.21.0-beta on the alias; QR renders.

## Non-goals (YAGNI)

No COI upload, no non-Meta pixels, no scan→lead conversion, no live trail streaming, no background geolocation, no per-rep page customization.
