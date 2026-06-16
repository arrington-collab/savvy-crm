import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { tenant, customer, property, job, changeOrder, invoice } from "../schema/index.js";
import { createChangeOrder, sendChangeOrder, markChangeOrderBySubmission, approveChangeOrder } from "./change-order.js";

let tId: string, custId: string, jobId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "CO", publicKey: "co", clerkOrgId: "org_co" }).returning();
  tId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tId, name: "Pat", email: "pat@x.com" }).returning();
  custId = c!.id;
  const [p] = await adminDb.insert(property).values({ tenantId: tId, customerId: custId, address: "1 Main St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: tId, customerId: custId, propertyId: p!.id }).returning();
  jobId = j!.id;
});

afterAll(async () => {
  await adminDb.delete(changeOrder).where(eq(changeOrder.tenantId, tId));
  await adminDb.delete(invoice).where(eq(invoice.tenantId, tId));
  await adminDb.delete(job).where(eq(job.tenantId, tId));
  await adminDb.delete(property).where(eq(property.tenantId, tId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

describe("createChangeOrder", () => {
  it("inserts a draft with computed subtotal/total", async () => {
    const co = await createChangeOrder({
      tenantId: tId, jobId, customerId: custId, reason: "extra vents",
      lineItems: [{ amountCents: 12000 }, { amountCents: 8000 }],
    });
    expect(co.status).toBe("draft");
    expect(co.total).toBe(20000);
    expect(co.subtotal).toBe(20000);
  });
});

describe("sendChangeOrder", () => {
  it("records submission id + url and flips to sent", async () => {
    const co = await createChangeOrder({ tenantId: tId, jobId, customerId: custId, reason: "r", lineItems: [{ amountCents: 5000 }] });
    await sendChangeOrder({ tenantId: tId, changeOrderId: co.id, docusealSubmissionId: "co_sub_send", signingUrl: "https://x/s/1" });
    const [row] = await adminDb.select().from(changeOrder).where(eq(changeOrder.id, co.id));
    expect(row!.status).toBe("sent");
    expect(row!.docusealSubmissionId).toBe("co_sub_send");
    expect(row!.signingUrl).toBe("https://x/s/1");
    expect(row!.sentAt).not.toBeNull();
  });
});

describe("markChangeOrderBySubmission", () => {
  it("flips a sent change order to approved + approvedAt; idempotent on replay", async () => {
    const co = await createChangeOrder({ tenantId: tId, jobId, customerId: custId, reason: "r", lineItems: [{ amountCents: 9000 }] });
    await sendChangeOrder({ tenantId: tId, changeOrderId: co.id, docusealSubmissionId: "co_mark_1", signingUrl: "u" });

    const first = await markChangeOrderBySubmission({ submissionId: "co_mark_1" });
    expect(first?.changed).toBe(true);
    expect(first?.tenantId).toBe(tId);
    const [row] = await adminDb.select().from(changeOrder).where(eq(changeOrder.id, co.id));
    expect(row!.status).toBe("approved");
    expect(row!.approvedAt).not.toBeNull();

    const second = await markChangeOrderBySubmission({ submissionId: "co_mark_1" });
    expect(second?.changed).toBe(false);
  });

  it("returns null for an unknown submission", async () => {
    expect(await markChangeOrderBySubmission({ submissionId: "nope" })).toBeNull();
  });
});

describe("approveChangeOrder", () => {
  it("bumps job.valueFinal by total + creates ONE draft invoice (total>0); idempotent", async () => {
    const [c2] = await adminDb.insert(customer).values({ tenantId: tId, name: "C2", email: "c2@x.com" }).returning();
    const [p2] = await adminDb.insert(property).values({ tenantId: tId, customerId: c2!.id, address: "2 St" }).returning();
    const [j2] = await adminDb.insert(job).values({ tenantId: tId, customerId: c2!.id, propertyId: p2!.id, valueFinal: 100000 }).returning();
    const co = await createChangeOrder({ tenantId: tId, jobId: j2!.id, customerId: c2!.id, reason: "r", lineItems: [{ amountCents: 25000 }] });

    const r1 = await approveChangeOrder({ tenantId: tId, changeOrderId: co.id });
    expect(r1.invoiceCreated).toBe(true);
    const [jobAfter] = await adminDb.select().from(job).where(eq(job.id, j2!.id));
    expect(jobAfter!.valueFinal).toBe(125000);
    const invs = await adminDb.select().from(invoice).where(eq(invoice.jobId, j2!.id));
    expect(invs.length).toBe(1);
    expect(invs[0]!.amountDue).toBe(25000);
    expect(invs[0]!.status).toBe("draft");
    expect(r1.invoiceId).toBe(invs[0]!.id);
    const [coAfter] = await adminDb.select().from(changeOrder).where(eq(changeOrder.id, co.id));
    expect(coAfter!.applied).toBe(true);
    expect(coAfter!.invoiceId).toBe(invs[0]!.id);

    const r2 = await approveChangeOrder({ tenantId: tId, changeOrderId: co.id });
    expect(r2.invoiceCreated).toBe(false);
    const [jobAfter2] = await adminDb.select().from(job).where(eq(job.id, j2!.id));
    expect(jobAfter2!.valueFinal).toBe(125000);
    const invs2 = await adminDb.select().from(invoice).where(eq(invoice.jobId, j2!.id));
    expect(invs2.length).toBe(1);
  });

  it("credit/zero delta bumps value but creates no invoice", async () => {
    const [c3] = await adminDb.insert(customer).values({ tenantId: tId, name: "C3" }).returning();
    const [p3] = await adminDb.insert(property).values({ tenantId: tId, customerId: c3!.id, address: "3 St" }).returning();
    const [j3] = await adminDb.insert(job).values({ tenantId: tId, customerId: c3!.id, propertyId: p3!.id, valueFinal: 100000 }).returning();
    const co = await createChangeOrder({ tenantId: tId, jobId: j3!.id, customerId: c3!.id, reason: "credit", lineItems: [{ amountCents: -5000 }] });
    const r = await approveChangeOrder({ tenantId: tId, changeOrderId: co.id });
    expect(r.invoiceCreated).toBe(false);
    const [jobAfter] = await adminDb.select().from(job).where(eq(job.id, j3!.id));
    expect(jobAfter!.valueFinal).toBe(95000);
    const invs = await adminDb.select().from(invoice).where(eq(invoice.jobId, j3!.id));
    expect(invs.length).toBe(0);
  });
});
