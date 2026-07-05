import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { db, pool } from "../src/client.js";
import { withTenant } from "../src/tenant.js";
import { tenant, user, customer, property, job, jobStageEvent, messageTemplate, drip, dripEnrollment, document, esignRequest, supplierInvoice, creditRequest, supplierAllowlist } from "../src/schema/index.js";
import { commission, invoice, changeOrder } from "../src/schema/finance.js";
import { priceBookItem } from "../src/schema/pricing.js";
import { usageSnapshot } from "../src/schema/billing.js";

let tenantAId: string;
let tenantBId: string;
let custBId: string;
let propBId: string;
let jobBId: string;
let commissionBId: string;
let documentBId: string;
let usageSnapshotBId: string;

beforeAll(async () => {
  // Seed two isolated tenants directly via the admin (RLS-bypassing) connection.
  const [a] = await adminDb.insert(tenant).values({ name: "ISO-A", publicKey: "iso-a", clerkOrgId: "org_iso_a" }).returning();
  const [b] = await adminDb.insert(tenant).values({ name: "ISO-B", publicKey: "iso-b", clerkOrgId: "org_iso_b" }).returning();
  tenantAId = a!.id; tenantBId = b!.id;
  await adminDb.insert(customer).values({ tenantId: a!.id, name: "A-cust" });
  const [cb] = await adminDb.insert(customer).values({ tenantId: b!.id, name: "B-cust" }).returning();
  custBId = cb!.id;

  // Give tenant B a property + job + stage event so A has something it must NOT see.
  const [pb] = await adminDb
    .insert(property)
    .values({ tenantId: b!.id, customerId: cb!.id, address: "B-property" })
    .returning();
  propBId = pb!.id;
  const [jb] = await adminDb
    .insert(job)
    .values({ tenantId: b!.id, customerId: cb!.id, propertyId: pb!.id })
    .returning();
  jobBId = jb!.id;
  await adminDb
    .insert(jobStageEvent)
    .values({ tenantId: b!.id, jobId: jb!.id, toStage: "inspected" });

  await adminDb.insert(messageTemplate).values({ tenantId: b!.id, key: "b-tmpl", name: "B tmpl", channel: "sms", body: "hi" });
  const [bDrip] = await adminDb.insert(drip).values({ tenantId: b!.id, key: "b-drip", name: "B drip", steps: [] }).returning();
  await adminDb.insert(dripEnrollment).values({ tenantId: b!.id, dripId: bDrip!.id, customerId: cb!.id, status: "active" });

  // Give tenant B a user + invoice + commission so A has something it must NOT see.
  const id = crypto.randomUUID();
  const [ub] = await adminDb
    .insert(user)
    .values({ tenantId: b!.id, name: "B-rep", email: `b-rep-${id}@test.example`, role: "rep" })
    .returning();
  const [inv] = await adminDb
    .insert(invoice)
    .values({ tenantId: b!.id, jobId: jb!.id, customerId: cb!.id, status: "draft" })
    .returning();
  const [comm] = await adminDb
    .insert(commission)
    .values({
      tenantId: b!.id,
      invoiceId: inv!.id,
      userId: ub!.id,
      model: "flat",
      basisCents: 100000,
      rate: 5,
      amountCents: 5000,
      periodKey: "2026-01",
    })
    .returning();
  commissionBId = comm!.id;

  // Give tenant B a price book item so A has something it must NOT see.
  await adminDb.insert(priceBookItem).values({
    tenantId: b!.id, key: "field-shingles", name: "B shingles", category: "material",
    unit: "square", unitPriceCents: 12000, sourceFields: ["squares"], wasteApplies: true,
  });

  // Give tenant B a document (on B's job) so A has something it must NOT see.
  const [doc] = await adminDb
    .insert(document)
    .values({
      tenantId: b!.id,
      jobId: jb!.id,
      kind: "contract",
      r2Key: "test/b-doc.pdf",
      source: "upload",
    })
    .returning();
  documentBId = doc!.id;

  // Give tenant B a usage_snapshot so A has something it must NOT see.
  const [snap] = await adminDb
    .insert(usageSnapshot)
    .values({
      tenantId: b!.id,
      periodKey: "2026-06",
      jobsProcessed: 0,
      aiSpendCents: 0,
      aiVoiceMinutes: 0,
      storageBytes: 0,
      bandKey: "starter",
      basePriceCents: 49900,
      overageCents: 0,
      totalCents: 49900,
    })
    .returning();
  usageSnapshotBId = snap!.id;
});

afterAll(async () => {
  // Remove child rows first (FK order: stage event -> job -> property) before tenant deletes.
  await adminDb.delete(dripEnrollment).where(eq(dripEnrollment.tenantId, tenantBId));
  await adminDb.delete(drip).where(eq(drip.tenantId, tenantBId));
  await adminDb.delete(messageTemplate).where(eq(messageTemplate.tenantId, tenantBId));
  await adminDb.delete(jobStageEvent).where(eq(jobStageEvent.tenantId, tenantBId));
  await adminDb.delete(priceBookItem).where(eq(priceBookItem.tenantId, tenantBId));
  // commission -> invoice must go before job/customer (FK chain)
  await adminDb.delete(commission).where(eq(commission.tenantId, tenantBId));
  await adminDb.delete(invoice).where(eq(invoice.tenantId, tenantBId));
  // document references job + tenant; must go before job delete
  await adminDb.delete(document).where(eq(document.tenantId, tenantBId));
  // usage_snapshot references tenant; must go before tenant delete
  await adminDb.delete(usageSnapshot).where(eq(usageSnapshot.tenantId, tenantBId));
  await adminDb.delete(user).where(eq(user.tenantId, tenantBId));
  await adminDb.delete(job).where(eq(job.tenantId, tenantBId));
  await adminDb.delete(property).where(eq(property.tenantId, tenantBId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantAId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantBId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantAId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantBId));
  await pool.end();
  await adminPool.end();
});

describe("RLS tenant isolation (connected as savvy_app)", () => {
  it("SELECT sees only own tenant's rows", async () => {
    const rows = await withTenant(tenantAId, (tx) => tx.select().from(customer));
    expect(rows.length).toBe(1);
    expect(rows[0]!.name).toBe("A-cust");
    expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
  });

  it("UPDATE cannot touch another tenant's row", async () => {
    const res = await withTenant(tenantAId, (tx) =>
      tx.update(customer).set({ name: "HACKED" }).where(eq(customer.id, custBId)).returning(),
    );
    expect(res.length).toBe(0); // policy hides B's row from A
    const [bRow] = await adminDb.select().from(customer).where(eq(customer.id, custBId));
    expect(bRow!.name).toBe("B-cust");
  });

  it("DELETE cannot remove another tenant's row", async () => {
    const res = await withTenant(tenantAId, (tx) =>
      tx.delete(customer).where(eq(customer.id, custBId)).returning(),
    );
    expect(res.length).toBe(0);
    const [bRow] = await adminDb.select().from(customer).where(eq(customer.id, custBId));
    expect(bRow).toBeTruthy();
  });

  it("INSERT with mismatched tenant_id is rejected by WITH CHECK", async () => {
    await expect(
      withTenant(tenantAId, (tx) =>
        tx.insert(customer).values({ tenantId: tenantBId, name: "smuggled" }),
      ),
    ).rejects.toThrow();
  });

  it("SELECT on job_stage_event is tenant-scoped", async () => {
    const rows = await withTenant(tenantAId, (tx) => tx.select().from(jobStageEvent));
    expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
  });

  it("SELECT on comms tables is tenant-scoped (A cannot see B)", async () => {
    const tmpls = await withTenant(tenantAId, (tx) => tx.select().from(messageTemplate));
    expect(tmpls.some((r) => r.tenantId === tenantBId)).toBe(false);
    const drips = await withTenant(tenantAId, (tx) => tx.select().from(drip));
    expect(drips.some((r) => r.tenantId === tenantBId)).toBe(false);
    const enrs = await withTenant(tenantAId, (tx) => tx.select().from(dripEnrollment));
    expect(enrs.some((r) => r.tenantId === tenantBId)).toBe(false);
  });

  it("SELECT on commission is tenant-scoped (A cannot see B's commissions)", async () => {
    const rows = await withTenant(tenantAId, (tx) => tx.select().from(commission));
    expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
  });

  it("SELECT on price_book_item is tenant-scoped (A cannot see B's price book)", async () => {
    const rows = await withTenant(tenantAId, (tx) => tx.select().from(priceBookItem));
    expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
  });

  it("SELECT on document is tenant-scoped (A cannot see B's documents)", async () => {
    const rows = await withTenant(tenantAId, (tx) => tx.select().from(document));
    expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
  });

  it("SELECT on usage_snapshot is tenant-scoped (A cannot see B)", async () => {
    const rows = await withTenant(tenantAId, (tx) => tx.select().from(usageSnapshot));
    expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
  });

  it("SELECT on esign_request is tenant-scoped (A cannot see B's requests)", async () => {
    const [er] = await adminDb
      .insert(esignRequest)
      .values({
        tenantId: tenantBId,
        jobId: jobBId,
        customerId: custBId,
        docType: "lien_waiver",
        templateId: "tpl_b",
        docusealSubmissionId: "sub_b_iso_1",
        status: "sent",
      })
      .returning();
    try {
      const rows = await withTenant(tenantAId, (tx) => tx.select().from(esignRequest));
      expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
    } finally {
      await adminDb.delete(esignRequest).where(eq(esignRequest.id, er!.id));
    }
  });

  it("SELECT on supplier_invoice is tenant-scoped (A cannot see B's supplier invoices)", async () => {
    const [si] = await adminDb
      .insert(supplierInvoice)
      .values({ tenantId: tenantBId, jobId: jobBId, supplierName: "ABC Supply", externalMessageId: "iso-msg-b-1", status: "received" })
      .returning();
    try {
      const rows = await withTenant(tenantAId, (tx) => tx.select().from(supplierInvoice));
      expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
    } finally {
      await adminDb.delete(supplierInvoice).where(eq(supplierInvoice.id, si!.id));
    }
  });

  it("SELECT on change_order is tenant-scoped (A cannot see B's change orders)", async () => {
    const [co] = await adminDb
      .insert(changeOrder)
      .values({
        tenantId: tenantBId,
        jobId: jobBId,
        customerId: custBId,
        reason: "extra decking",
        status: "sent",
        lineItems: [],
        total: 50000,
        docusealSubmissionId: "co_sub_b_iso_1",
      })
      .returning();
    try {
      const rows = await withTenant(tenantAId, (tx) => tx.select().from(changeOrder));
      expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
    } finally {
      await adminDb.delete(changeOrder).where(eq(changeOrder.id, co!.id));
    }
  });

  it("SELECT on credit_request is tenant-scoped (A cannot see B's credit requests)", async () => {
    // Seed a supplier_invoice under B first (FK required by credit_request).
    const [si] = await adminDb
      .insert(supplierInvoice)
      .values({ tenantId: tenantBId, jobId: jobBId, externalMessageId: "iso-msg-cr-b-1", status: "parsed" })
      .returning();
    const [cr] = await adminDb
      .insert(creditRequest)
      .values({ tenantId: tenantBId, supplierInvoiceId: si!.id, claimedCents: 50000, status: "drafted", evidence: [] })
      .returning();
    try {
      const rows = await withTenant(tenantAId, (tx) => tx.select().from(creditRequest));
      expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
    } finally {
      await adminDb.delete(creditRequest).where(eq(creditRequest.id, cr!.id));
      await adminDb.delete(supplierInvoice).where(eq(supplierInvoice.id, si!.id));
    }
  });

  it("SELECT on supplier_allowlist is tenant-scoped (A cannot see B's domains)", async () => {
    const [al] = await adminDb
      .insert(supplierAllowlist)
      .values({ tenantId: tenantBId, domain: "b-supplier.com", label: "B Supplier" })
      .returning();
    try {
      const rows = await withTenant(tenantAId, (tx) => tx.select().from(supplierAllowlist));
      expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
    } finally {
      await adminDb.delete(supplierAllowlist).where(eq(supplierAllowlist.id, al!.id));
    }
  });
});
