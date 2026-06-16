import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { tenant, customer, property, job, changeOrder } from "../schema/index.js";
import { createChangeOrder, sendChangeOrder } from "./change-order.js";

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
