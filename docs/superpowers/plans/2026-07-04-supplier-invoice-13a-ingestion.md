# Supplier Invoice — Slice 13a (Ingestion Pipe) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supplier invoices forwarded to a per-tenant address land automatically in R2 + the database, tenant-scoped, and emit a durable event — with no AI yet.

**Architecture:** A provider-agnostic inbound-email webhook (`POST /api/inbound/supplier-invoice`) resolves the tenant from an opaque token in the recipient address, stores each PDF attachment as a `document`, inserts a `supplier_invoice` row (idempotent on the email Message-Id), and emits `supplier-invoice/received` for the later parse slice (13b). Mirrors the existing `sitesnap/photos` webhook → testable-lib → Inngest-event pattern.

**Tech Stack:** Next.js route handler · Drizzle/Postgres (RLS) · Inngest · Cloudflare R2 (`@savvy/integrations` `r2Storage`) · Vitest + Playwright.

**Spec:** `docs/superpowers/specs/2026-07-04-supplier-invoice-price-guard-design.md` §3–§4.

## Global Constraints

- **Tenant isolation on every table + query.** New tables carry `tenant_id` + `tenantIsolation()` RLS; cross-tenant reads must return nothing (RLS test required). Use `withTenant(tenantId, tx => …)` for tenant-scoped reads; `adminDb` only for the token→tenant lookup (pre-tenant-context) and tests.
- **Anything async is a durable Inngest workflow** — the webhook only *emits*; it never does the parse inline.
- **No secrets in repo** — `INBOUND_EMAIL_SECRET` + `INBOX_DOMAIN` via env; add to `.env.example`.
- **Migrations:** generate with `pnpm db:generate` (drizzle-kit) — never hand-number. Next migration number follows the current max in `packages/db/drizzle/`.
- **Package imports:** import tables/operators from `@savvy/db`, pure logic from `@savvy/core`; no `.js` extensions (Turbopack).
- **Every slice:** `pnpm typecheck` + `pnpm lint` clean; `gh pr checks <n> --watch` before squash-merge.
- **Test commands:** core/db/integrations unit tests → `cd packages/<pkg> && pnpm exec vitest run <file>`; web e2e → CI only (no local DB) via `pnpm --filter @savvy/web exec playwright test`.

---

### Task 1: Core — status enum, line type, inbox-address parser

**Files:**
- Modify: `packages/core/src/enums.ts` (add `SUPPLIER_INVOICE_STATUS`)
- Create: `packages/core/src/supplier-invoice.ts`
- Create: `packages/core/src/supplier-invoice.test.ts`
- Modify: `packages/core/src/index.ts` (export)

**Interfaces:**
- Produces: `SUPPLIER_INVOICE_STATUS` (const tuple) + `SupplierInvoiceStatus` type; `type SupplierInvoiceLine`; `parseInboxToken(toAddress: string): string | null`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/supplier-invoice.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseInboxToken } from "./supplier-invoice";

describe("parseInboxToken", () => {
  it("extracts the token from a well-formed inbox address", () => {
    expect(parseInboxToken("inv-abc123XYZ@inbox.getsavvy.com")).toBe("abc123XYZ");
  });
  it("is case-insensitive on the local-part prefix and domain", () => {
    expect(parseInboxToken("INV-abc123@INBOX.GetSavvy.com")).toBe("abc123");
  });
  it("tolerates display-name / angle-bracket forms", () => {
    expect(parseInboxToken('"ABC Supply" <inv-tok9@inbox.getsavvy.com>')).toBe("tok9");
  });
  it("returns null for a non-inbox address", () => {
    expect(parseInboxToken("sales@abcsupply.com")).toBeNull();
    expect(parseInboxToken("inv-@inbox.getsavvy.com")).toBeNull(); // empty token
    expect(parseInboxToken("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm exec vitest run src/supplier-invoice.test.ts`
Expected: FAIL — cannot resolve `./supplier-invoice`.

- [ ] **Step 3: Add the status enum**

In `packages/core/src/enums.ts`, add near the other status tuples:

```ts
export const SUPPLIER_INVOICE_STATUS = ["received", "parsing", "parsed", "guarded", "parse_failed"] as const;
export type SupplierInvoiceStatus = (typeof SUPPLIER_INVOICE_STATUS)[number];
```

- [ ] **Step 4: Write the implementation**

Create `packages/core/src/supplier-invoice.ts`:

```ts
/**
 * Supplier-invoice pure types + helpers. The inbox token routes an inbound
 * email to its tenant; lines carry parsed amounts (13b) plus guard annotations
 * (13c). Kept pure so routing + shapes are unit-tested.
 */
export type SupplierInvoiceLine = {
  description: string;
  sku?: string;
  quantity: number;
  unit?: string;
  unitBilledCents: number;
  amountBilledCents: number;
  // guard annotations (written in slice 13c)
  matchedItemKey?: string | null;
  expectedUnitCostCents?: number | null;
  overageCents?: number | null;
  matchConfidence?: number | null;
};

// Per-tenant inbox address: inv-<token>@<INBOX_DOMAIN>. Token is [A-Za-z0-9]+.
const INBOX_RE = /(?:^|<)\s*inv-([A-Za-z0-9]+)@inbox\.getsavvy\.com\s*>?$/i;

export function parseInboxToken(toAddress: string): string | null {
  const m = INBOX_RE.exec(toAddress.trim());
  return m ? m[1] : null;
}
```

- [ ] **Step 5: Export from the core index**

In `packages/core/src/index.ts`, add:

```ts
export * from "./supplier-invoice";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/core && pnpm exec vitest run src/supplier-invoice.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm --filter @savvy/core typecheck
git add packages/core/src/supplier-invoice.ts packages/core/src/supplier-invoice.test.ts packages/core/src/enums.ts packages/core/src/index.ts
git commit -m "feat(core): supplier-invoice status enum, line type, inbox-token parser"
```

---

### Task 2: DB — supplier_invoice table + migration + RLS isolation test

**Files:**
- Create: `packages/db/src/schema/supplier-invoice.ts`
- Modify: `packages/db/src/schema/enums.ts` (register `supplierInvoiceStatusEnum`)
- Modify: `packages/db/src/schema/index.ts` (export the new schema file)
- Create: `packages/db/src/schema/supplier-invoice.rls.test.ts` (or add to the existing RLS suite if one aggregates)
- Generated: `packages/db/drizzle/00NN_*.sql` via `pnpm db:generate`

**Interfaces:**
- Consumes: `SUPPLIER_INVOICE_STATUS` from `@savvy/core`.
- Produces: `supplierInvoice` Drizzle table (columns: `id, tenantId, jobId, documentId, supplierName, invoiceNumber, invoiceDate, totalCents, lines, status, parseConfidence, externalMessageId, createdAt, updatedAt`), re-exported from `@savvy/db`.

- [ ] **Step 1: Register the pg enum**

In `packages/db/src/schema/enums.ts` (mirror the existing `invoiceStatusEnum` line), add:

```ts
import { SUPPLIER_INVOICE_STATUS } from "@savvy/core";
// ...
export const supplierInvoiceStatusEnum = pgEnum("supplier_invoice_status", SUPPLIER_INVOICE_STATUS);
```

(If `@savvy/core` enums are already imported at the top of the file, add `SUPPLIER_INVOICE_STATUS` to that import list instead of a new import.)

- [ ] **Step 2: Define the table**

Create `packages/db/src/schema/supplier-invoice.ts` (follow `finance.ts`/`procurement.ts` conventions — `idCol`, `tenantIsolation`, `createdAt`, `updatedAt`):

```ts
import { pgTable, uuid, text, integer, real, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import type { SupplierInvoiceLine } from "@savvy/core";
import { idCol, createdAt, updatedAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenant";
import { job } from "./jobs";
import { document } from "./ops";
import { supplierInvoiceStatusEnum } from "./enums";

export const supplierInvoice = pgTable("supplier_invoice", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").references(() => job.id), // nullable — matched during parse (13b)
  documentId: uuid("document_id").references(() => document.id),
  supplierName: text("supplier_name"),
  invoiceNumber: text("invoice_number"),
  invoiceDate: timestamp("invoice_date", { withTimezone: true }),
  totalCents: integer("total_cents"), // negative for credit memos (13c)
  lines: jsonb("lines").$type<SupplierInvoiceLine[]>().notNull().default([]),
  status: supplierInvoiceStatusEnum("status").notNull().default("received"),
  parseConfidence: real("parse_confidence"),
  externalMessageId: text("external_message_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("supplier_invoice_tenant_job_idx").on(t.tenantId, t.jobId),
  uniqueIndex("supplier_invoice_tenant_msg_uniq").on(t.tenantId, t.externalMessageId).where(sql`external_message_id is not null`),
  tenantIsolation(),
]);
```

Add `import { sql } from "drizzle-orm";` at the top (needed for the partial-unique `where`). Verify `_rls` exports `idCol/createdAt/updatedAt/tenantIsolation` — match whatever `finance.ts` imports.

- [ ] **Step 3: Export the schema**

In `packages/db/src/schema/index.ts`, add (alphabetically near the others):

```ts
export * from "./supplier-invoice";
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter @savvy/db db:generate`
Expected: a new `packages/db/drizzle/00NN_*.sql` creating `supplier_invoice_status` enum + `supplier_invoice` table + RLS policy. **Open it and verify** it includes `ENABLE ROW LEVEL SECURITY` + the `tenant_id = current_setting('app.tenant_id')::uuid` policy (that's what `tenantIsolation()` emits). Do not hand-edit.

- [ ] **Step 5: Write the RLS isolation test**

Create `packages/db/src/schema/supplier-invoice.rls.test.ts` (model on the existing RLS/isolation test — find it with `grep -rl "current_setting\|cross-tenant\|returns nothing" packages/db`). It must: seed a `supplier_invoice` under tenant A (via `withTenant(A)`), then assert a `withTenant(B)` select returns zero rows.

```ts
import { describe, it, expect } from "vitest";
import { withTenant, adminDb, supplierInvoice, tenant, eq } from "../index";
import { randomUUID } from "node:crypto";

describe("supplier_invoice RLS", () => {
  it("does not leak rows across tenants", async () => {
    const a = randomUUID(), b = randomUUID();
    await adminDb.insert(tenant).values([{ id: a, name: "A" }, { id: b, name: "B" }]);
    await withTenant(a, (tx) => tx.insert(supplierInvoice).values({ tenantId: a, externalMessageId: "m1" }));
    const seenByB = await withTenant(b, (tx) => tx.select().from(supplierInvoice));
    expect(seenByB).toHaveLength(0);
    await adminDb.delete(tenant).where(eq(tenant.id, a));
    await adminDb.delete(tenant).where(eq(tenant.id, b));
  });
});
```

Adapt the exact `tenant` insert columns + cleanup to match the existing RLS test's helpers (it may have a `makeTenant` helper — reuse it).

- [ ] **Step 6: Run the RLS test**

Run: `cd packages/db && pnpm exec vitest run src/schema/supplier-invoice.rls.test.ts`
Expected: PASS (requires the migration applied to the test DB — CI runs `db:migrate` first; locally it needs a Postgres + `db:migrate`). If no local DB, note it runs in CI and proceed.

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm --filter @savvy/db typecheck
git add packages/db/src/schema/supplier-invoice.ts packages/db/src/schema/enums.ts packages/db/src/schema/index.ts packages/db/src/schema/supplier-invoice.rls.test.ts packages/db/drizzle/
git commit -m "feat(db): supplier_invoice table + RLS + migration"
```

---

### Task 3: Web lib — `ingestSupplierInvoice` (tenant resolve → store → insert → emit)

**Files:**
- Create: `apps/web/src/lib/supplier-invoice-ingest.ts`
- Create: `apps/web/src/lib/supplier-invoice-ingest.test.ts`

**Interfaces:**
- Consumes: `parseInboxToken` (`@savvy/core`); `supplierInvoice`, `document`, `adminDb`, `withTenant`, `tenant`, `sql` (`@savvy/db`); `StorageGateway` (`@savvy/integrations`).
- Produces: `type InboundBody = { messageId: string; to: string; from?: string; attachments: { filename: string; contentType: string; bytesBase64: string }[] }`; `ingestSupplierInvoice(body: InboundBody, secret: string, deps: { expectedSecret: string; storage: StorageGateway; emit: (e: { tenantId: string; supplierInvoiceId: string; documentId: string }) => Promise<void> }): Promise<{ status: number; body: unknown }>`.

**Behavior:** wrong secret → `401`; malformed body → `400`; unknown token → `404 { error: "unknown_inbox" }`; no PDF attachment → `202 { ignored: true }`; success → for each PDF: `putObject` to `tenant/<id>/supplier-invoice/<uuid>.pdf`, insert `document(kind:"supplier_invoice")`, insert `supplierInvoice(status:"received", externalMessageId)` with `onConflictDoNothing`, `emit(...)`; return `200 { received: <count> }`. Re-delivery of the same `messageId` is a no-op (idempotent) and still returns `200`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/supplier-invoice-ingest.test.ts` (use `makeFakeStorage` + a real test tenant seeded via `adminDb`; inject a capturing `emit`):

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { adminDb, tenant, supplierInvoice, document, withTenant, eq } from "@savvy/db";
import { makeFakeStorage } from "@savvy/integrations";
import { ingestSupplierInvoice, type InboundBody } from "./supplier-invoice-ingest";

const TOKEN = "guardtok1";
let tenantId: string;

const pdf = (filename = "abc.pdf"): InboundBody => ({
  messageId: `msg-${randomUUID()}`,
  to: `inv-${TOKEN}@inbox.getsavvy.com`,
  from: "billing@abcsupply.com",
  attachments: [{ filename, contentType: "application/pdf", bytesBase64: Buffer.from("%PDF-1.4 fake").toString("base64") }],
});

beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "Guard Co", settings: { supplierInbox: { token: TOKEN } } });
});
afterAll(async () => { await adminDb.delete(tenant).where(eq(tenant.id, tenantId)); });

const deps = (emit: any) => ({ expectedSecret: "s3cret", storage: makeFakeStorage(), emit });

it("rejects a bad secret", async () => {
  const res = await ingestSupplierInvoice(pdf(), "wrong", deps(async () => {}));
  expect(res.status).toBe(401);
});

it("404s an unknown inbox token", async () => {
  const body = { ...pdf(), to: "inv-nope@inbox.getsavvy.com" };
  const res = await ingestSupplierInvoice(body, "s3cret", deps(async () => {}));
  expect(res.status).toBe(404);
});

it("stores the PDF, inserts document + supplier_invoice, and emits once", async () => {
  const emitted: any[] = [];
  const body = pdf();
  const res = await ingestSupplierInvoice(body, "s3cret", deps(async (e: any) => emitted.push(e)));
  expect(res.status).toBe(200);
  expect(emitted).toHaveLength(1);
  const rows = await withTenant(tenantId, (tx) => tx.select().from(supplierInvoice).where(eq(supplierInvoice.externalMessageId, body.messageId)));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("received");
  const docs = await withTenant(tenantId, (tx) => tx.select().from(document).where(eq(document.id, emitted[0].documentId)));
  expect(docs[0]!.kind).toBe("supplier_invoice");
});

it("is idempotent on a re-delivered messageId", async () => {
  const emitted: any[] = [];
  const body = pdf();
  await ingestSupplierInvoice(body, "s3cret", deps(async (e: any) => emitted.push(e)));
  await ingestSupplierInvoice(body, "s3cret", deps(async (e: any) => emitted.push(e)));
  const rows = await withTenant(tenantId, (tx) => tx.select().from(supplierInvoice).where(eq(supplierInvoice.externalMessageId, body.messageId)));
  expect(rows).toHaveLength(1);
});

it("202-ignores an email with no PDF attachment", async () => {
  const body = { ...pdf(), attachments: [{ filename: "note.txt", contentType: "text/plain", bytesBase64: "eA==" }] };
  const res = await ingestSupplierInvoice(body, "s3cret", deps(async () => {}));
  expect(res.status).toBe(202);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm exec vitest run src/lib/supplier-invoice-ingest.test.ts`
Expected: FAIL — cannot resolve `./supplier-invoice-ingest`. (Requires the migration on the test DB; CI-provided.)

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/supplier-invoice-ingest.ts`:

```ts
import "server-only";
import { randomUUID } from "node:crypto";
import { adminDb, withTenant, tenant, document, supplierInvoice, sql } from "@savvy/db";
import type { StorageGateway } from "@savvy/integrations";
import { parseInboxToken } from "@savvy/core";

export type InboundBody = {
  messageId: string;
  to: string;
  from?: string;
  attachments: { filename: string; contentType: string; bytesBase64: string }[];
};

type Deps = {
  expectedSecret: string;
  storage: StorageGateway;
  emit: (e: { tenantId: string; supplierInvoiceId: string; documentId: string }) => Promise<void>;
};

const isPdf = (a: InboundBody["attachments"][number]) =>
  a.contentType === "application/pdf" || a.filename.toLowerCase().endsWith(".pdf");

export async function ingestSupplierInvoice(body: InboundBody, secret: string, deps: Deps): Promise<{ status: number; body: unknown }> {
  if (secret !== deps.expectedSecret) return { status: 401, body: { error: "unauthorized" } };
  if (!body?.messageId || !body?.to || !Array.isArray(body.attachments)) return { status: 400, body: { error: "bad_payload" } };

  const token = parseInboxToken(body.to);
  if (!token) return { status: 404, body: { error: "unknown_inbox" } };

  // Resolve tenant by inbox token (pre-tenant-context → adminDb). Few tenants → jsonb scan is fine.
  const [t] = await adminDb
    .select({ id: tenant.id })
    .from(tenant)
    .where(sql`${tenant.settings}->'supplierInbox'->>'token' = ${token}`);
  if (!t) return { status: 404, body: { error: "unknown_inbox" } };
  const tenantId = t.id;

  const pdfs = body.attachments.filter(isPdf);
  if (pdfs.length === 0) return { status: 202, body: { ignored: true } };

  const supplierName = body.from ? body.from.split("@")[1] ?? null : null; // provisional; parse (13b) overwrites
  let received = 0;

  for (const att of pdfs) {
    const bytes = new Uint8Array(Buffer.from(att.bytesBase64, "base64"));
    const key = `tenant/${tenantId}/supplier-invoice/${randomUUID()}.pdf`;
    await deps.storage.putObject({ key, bytes, contentType: "application/pdf" });

    const inserted = await withTenant(tenantId, async (tx) => {
      const [doc] = await tx.insert(document).values({
        tenantId, kind: "supplier_invoice", r2Key: key, filename: att.filename,
        mime: "application/pdf", sizeBytes: bytes.byteLength, source: "inbound_email",
      }).returning({ id: document.id });

      const [inv] = await tx.insert(supplierInvoice).values({
        tenantId, documentId: doc!.id, supplierName, externalMessageId: body.messageId, status: "received",
      }).onConflictDoNothing({ target: [supplierInvoice.tenantId, supplierInvoice.externalMessageId] }).returning({ id: supplierInvoice.id });

      return inv ? { documentId: doc!.id, supplierInvoiceId: inv.id } : null; // null → already ingested (idempotent)
    });

    if (inserted) {
      await deps.emit({ tenantId, ...inserted });
      received += 1;
    }
  }

  return { status: 200, body: { received } };
}
```

Confirm `document` insert columns (`r2Key`, `mime`, `sizeBytes`, `source`) match `packages/db/src/schema/ops.ts` exactly; adjust names if the schema differs.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm exec vitest run src/lib/supplier-invoice-ingest.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @savvy/web typecheck
git add apps/web/src/lib/supplier-invoice-ingest.ts apps/web/src/lib/supplier-invoice-ingest.test.ts
git commit -m "feat(web): ingestSupplierInvoice — resolve tenant, store PDF, insert + emit (idempotent)"
```

---

### Task 4: Web — inbound webhook route + Inngest event + env

**Files:**
- Create: `apps/web/src/app/api/inbound/supplier-invoice/route.ts`
- Modify: `packages/agents/src/client.ts` (register `supplier-invoice/received` event type)
- Modify: `.env.example` (add `INBOUND_EMAIL_SECRET`, `INBOX_DOMAIN`)
- Create: `apps/web/tests/e2e/supplier-invoice-ingest.spec.ts`

**Interfaces:**
- Consumes: `ingestSupplierInvoice`, `InboundBody` (Task 3); `inngest`, `r2Storage`.
- Produces: `POST /api/inbound/supplier-invoice`; event `"supplier-invoice/received": { data: { tenantId: string; supplierInvoiceId: string; documentId: string } }` in the Inngest registry.

- [ ] **Step 1: Register the Inngest event**

In `packages/agents/src/client.ts`, add to the event-type map (mirror the existing `"photo/ingested"` entry):

```ts
"supplier-invoice/received": { data: { tenantId: string; supplierInvoiceId: string; documentId: string } };
```

- [ ] **Step 2: Write the route (delegates to the lib, sitesnap pattern)**

Create `apps/web/src/app/api/inbound/supplier-invoice/route.ts`:

```ts
import { NextResponse } from "next/server";
import { inngest } from "@savvy/agents";
import { r2Storage } from "@savvy/integrations";
import { ingestSupplierInvoice, type InboundBody } from "@/lib/supplier-invoice-ingest";
import { log } from "@/lib/log";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
  const secret = req.headers.get("x-inbound-secret") ?? "";
  let body: InboundBody;
  try { body = (await req.json()) as InboundBody; } catch { return NextResponse.json({ error: "bad_payload" }, { status: 400 }); }

  const res = await ingestSupplierInvoice(body, secret, {
    expectedSecret: process.env.INBOUND_EMAIL_SECRET ?? "",
    storage: r2Storage,
    emit: (e) => inngest.send({ name: "supplier-invoice/received", data: e }),
  });
  if (res.status >= 500) log.error("supplier-invoice ingest failed", { route: "/api/inbound/supplier-invoice", status: res.status });
  return NextResponse.json(res.body, { status: res.status });
}
```

- [ ] **Step 3: Add env docs**

Append to `.env.example`:

```
# Inbound supplier-invoice email webhook (Cloudflare Email Routing → Worker → this route)
INBOUND_EMAIL_SECRET=
INBOX_DOMAIN=inbox.getsavvy.com
```

- [ ] **Step 4: Write the e2e**

Create `apps/web/tests/e2e/supplier-invoice-ingest.spec.ts` (drives the real route; seeds the inbox token on the e2e tenant via `adminDb`; posts a fake inbound payload):

```ts
import { test, expect, request } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, tenant, supplierInvoice, withTenant, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };
const TOKEN = "e2eguard";

test.beforeAll(async () => {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const settings = { ...(t?.settings as object ?? {}), supplierInbox: { token: TOKEN } };
  await adminDb.update(tenant).set({ settings }).where(eq(tenant.id, tenantId));
});

test("a forwarded supplier invoice lands as a document + supplier_invoice and emits", async ({ baseURL }) => {
  const messageId = `e2e-${randomUUID()}`;
  const api = await request.newContext();
  const res = await api.post(`${baseURL}/api/inbound/supplier-invoice`, {
    headers: { "x-inbound-secret": process.env.INBOUND_EMAIL_SECRET ?? "test-inbound-secret", "content-type": "application/json" },
    data: { messageId, to: `inv-${TOKEN}@inbox.getsavvy.com`, from: "billing@abcsupply.com",
      attachments: [{ filename: "abc.pdf", contentType: "application/pdf", bytesBase64: Buffer.from("%PDF-1.4 e2e").toString("base64") }] },
  });
  expect(res.status()).toBe(200);
  const rows = await withTenant(tenantId, (tx) => tx.select().from(supplierInvoice).where(eq(supplierInvoice.externalMessageId, messageId)));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("received");
});
```

Ensure `INBOUND_EMAIL_SECRET` is set in the Playwright webServer env (`apps/web/playwright.config.ts`) to a known test value; add it there (`INBOUND_EMAIL_SECRET: "test-inbound-secret"`) alongside `TEST_MODE`.

- [ ] **Step 5: Typecheck + lint + commit**

```bash
pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint && pnpm --filter @savvy/agents typecheck
git add apps/web/src/app/api/inbound/supplier-invoice/route.ts packages/agents/src/client.ts .env.example apps/web/tests/e2e/supplier-invoice-ingest.spec.ts apps/web/playwright.config.ts
git commit -m "feat(web): inbound supplier-invoice webhook + supplier-invoice/received event"
```

---

### Task 5: Settings — ensure inbox token + show the forwarding address

**Files:**
- Create: `apps/web/src/lib/supplier-inbox.ts` (`ensureSupplierInboxAddress`)
- Modify: `apps/web/src/app/(app)/library/page.tsx` (add the forwarding address to the Tenant Settings card OR a small settings row) — or create a focused settings sub-view; pick the smallest change that surfaces the address.
- Create: `apps/web/tests/e2e/supplier-inbox.spec.ts`

**Interfaces:**
- Consumes: `adminDb`, `tenant`, `getTenantId`.
- Produces: `ensureSupplierInboxAddress(): Promise<string>` — returns `inv-<token>@<INBOX_DOMAIN>`, generating + persisting a token in `tenant.settings.supplierInbox` on first call.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/supplier-inbox.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { adminDb, tenant, eq } from "@savvy/db";
import { deriveInboxAddress } from "./supplier-inbox";

describe("deriveInboxAddress", () => {
  it("builds the address from a token + domain", () => {
    expect(deriveInboxAddress("abc123", "inbox.getsavvy.com")).toBe("inv-abc123@inbox.getsavvy.com");
  });
});
```

(The token-persistence path `ensureSupplierInboxAddress` reads `getTenantId()` which needs request context — cover it in the e2e, not the unit test. Keep the pure `deriveInboxAddress` unit-tested.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm exec vitest run src/lib/supplier-inbox.test.ts`
Expected: FAIL — cannot resolve `./supplier-inbox`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/supplier-inbox.ts`:

```ts
import "server-only";
import { randomBytes } from "node:crypto";
import { adminDb, tenant, eq } from "@savvy/db";
import { getTenantId } from "./tenant";

const DOMAIN = process.env.INBOX_DOMAIN ?? "inbox.getsavvy.com";

export function deriveInboxAddress(token: string, domain = DOMAIN): string {
  return `inv-${token}@${domain}`;
}

/** Returns the tenant's supplier-invoice forwarding address, minting + persisting a token on first use. */
export async function ensureSupplierInboxAddress(): Promise<string> {
  const tenantId = await getTenantId();
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const settings = (t?.settings ?? {}) as { supplierInbox?: { token?: string } };
  let token = settings.supplierInbox?.token;
  if (!token) {
    token = randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
    await adminDb.update(tenant).set({ settings: { ...settings, supplierInbox: { token } } }).where(eq(tenant.id, tenantId));
  }
  return deriveInboxAddress(token);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm exec vitest run src/lib/supplier-inbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Surface the address in the Library › Tenant Settings card**

In `apps/web/src/app/(app)/library/page.tsx`, call `ensureSupplierInboxAddress()` in the page's data load and render it (read-only, copyable, `data-testid="supplier-inbox-address"`) inside the Tenant Settings card body, e.g. append to that card's `body`: `Forward supplier invoices to <address>.`

- [ ] **Step 6: Write the e2e**

Create `apps/web/tests/e2e/supplier-inbox.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("Library surfaces the tenant's supplier-invoice forwarding address", async ({ page }) => {
  await page.goto("/library");
  await expect(page.getByTestId("supplier-inbox-address")).toContainText(/inv-[A-Za-z0-9]+@/);
});
```

- [ ] **Step 7: Typecheck + lint + commit**

```bash
pnpm --filter @savvy/web typecheck && pnpm --filter @savvy/web lint
git add apps/web/src/lib/supplier-inbox.ts apps/web/src/lib/supplier-inbox.test.ts "apps/web/src/app/(app)/library/page.tsx" apps/web/tests/e2e/supplier-inbox.spec.ts
git commit -m "feat(web): per-tenant supplier-invoice forwarding address in Library settings"
```

---

## Slice 13a — Definition of Done

- [ ] `supplier_invoice` table live with RLS; migration generated + green in CI.
- [ ] Forwarding a PDF to `inv-<token>@inbox.getsavvy.com` lands a `document(kind=supplier_invoice)` + `supplier_invoice(status=received)`, idempotent on Message-Id, and emits `supplier-invoice/received`.
- [ ] Tenant's forwarding address visible in Library settings.
- [ ] `pnpm typecheck` + `pnpm lint` clean; e2e green; PR squash-merged.
- [ ] **Next:** run writing-plans for slice 13b (parse → real costing) against the now-merged shapes.

## Self-Review

- **Spec coverage (§3–§4):** `supplier_invoice` table ✓ (Task 2); `document.kind='supplier_invoice'` ✓ (text column, used in Task 3 — no enum change); forwarding address + token in `tenant.settings` ✓ (Task 5); provider-agnostic webhook + secret + tenant-resolve + R2 + idempotent insert + emit ✓ (Tasks 3–4); `.env.example` ✓ (Task 4). `credit_request` table + parse/guard are **out of 13a scope** (13b/13c) — correct.
- **Placeholder scan:** every code step carries real code; no TBD/TODO. The two "confirm column names match ops.ts / _rls" notes are verification steps, not placeholders.
- **Type consistency:** `InboundBody`/`Deps`/`ingestSupplierInvoice` signatures match between Task 3 (definition) and Task 4 (consumption); event shape `{tenantId, supplierInvoiceId, documentId}` matches between Task 3 emit, Task 4 registration, and the route. `SUPPLIER_INVOICE_STATUS` defined in Task 1, consumed in Task 2.
- **Scope:** one mergeable slice (ingestion), 5 right-sized tasks each ending in a tested deliverable.
