import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { tenant, customer, property, job, estimate, appointment, materialOrder } from "../schema/index.js";
import { createMaterialOrderFromEstimate, setMaterialOrderStatus, getJobInstallDate } from "./material-order.js";

let tId: string, custId: string, jobId: string;

const LINE_ITEMS = [
  { key: "shingles", name: "Shingles", category: "material", unit: "square", quantity: 30, unitPriceCents: 12000, amountCents: 360000 },
  { key: "labor", name: "Install", category: "labor", unit: "square", quantity: 30, unitPriceCents: 9000, amountCents: 270000 },
];

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "MO", publicKey: "mo", clerkOrgId: "org_mo" }).returning();
  tId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tId, name: "Mo", email: "mo@x.com" }).returning();
  custId = c!.id;
  const [p] = await adminDb.insert(property).values({ tenantId: tId, customerId: custId, address: "1 Mat St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: tId, customerId: custId, propertyId: p!.id }).returning();
  jobId = j!.id;
});

afterAll(async () => {
  await adminDb.delete(materialOrder).where(eq(materialOrder.tenantId, tId));
  await adminDb.delete(appointment).where(eq(appointment.tenantId, tId));
  await adminDb.delete(estimate).where(eq(estimate.tenantId, tId));
  await adminDb.delete(job).where(eq(job.tenantId, tId));
  await adminDb.delete(property).where(eq(property.tenantId, tId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

async function newEstimate() {
  const [e] = await adminDb.insert(estimate).values({
    tenantId: tId, jobId, status: "accepted", lineItems: LINE_ITEMS, total: 630000,
  }).returning();
  return e!;
}

describe("createMaterialOrderFromEstimate", () => {
  it("creates a draft order from material lines only, no install -> neededByAt null", async () => {
    const e = await newEstimate();
    const order = await createMaterialOrderFromEstimate({ tenantId: tId, estimateId: e.id });
    expect(order).not.toBeNull();
    expect(order!.status).toBe("draft");
    expect(order!.lineItems.map((l) => l.key)).toEqual(["shingles"]);
    expect(order!.subtotalCents).toBe(360000);
    expect(order!.neededByAt).toBeNull();
  });

  it("is idempotent per estimate (returns the existing order)", async () => {
    const e = await newEstimate();
    const first = await createMaterialOrderFromEstimate({ tenantId: tId, estimateId: e.id });
    const second = await createMaterialOrderFromEstimate({ tenantId: tId, estimateId: e.id });
    expect(second!.id).toBe(first!.id);
    const rows = await adminDb.select().from(materialOrder).where(eq(materialOrder.estimateId, e.id));
    expect(rows.length).toBe(1);
  });

  it("aligns neededByAt to install date minus 2 days", async () => {
    const e = await newEstimate();
    const install = new Date("2026-08-20T15:00:00.000Z");
    await adminDb.insert(appointment).values({
      tenantId: tId, jobId, type: "crew", status: "scheduled",
      startsAt: install, endsAt: new Date(install.getTime() + 3_600_000),
    });
    const order = await createMaterialOrderFromEstimate({ tenantId: tId, estimateId: e.id });
    expect(order!.neededByAt?.toISOString()).toBe(new Date("2026-08-18T15:00:00.000Z").toISOString());
  });

  it("returns null for a missing estimate", async () => {
    expect(await createMaterialOrderFromEstimate({ tenantId: tId, estimateId: "00000000-0000-0000-0000-000000000000" })).toBeNull();
  });
});

describe("setMaterialOrderStatus", () => {
  it("ordered sets orderedAt; delivered sets deliveredAt", async () => {
    const e = await newEstimate();
    const order = await createMaterialOrderFromEstimate({ tenantId: tId, estimateId: e.id });
    const ordered = await setMaterialOrderStatus({ tenantId: tId, materialOrderId: order!.id, status: "ordered" });
    expect(ordered.status).toBe("ordered");
    expect(ordered.orderedAt).not.toBeNull();
    const delivered = await setMaterialOrderStatus({ tenantId: tId, materialOrderId: order!.id, status: "delivered" });
    expect(delivered.status).toBe("delivered");
    expect(delivered.deliveredAt).not.toBeNull();
  });
});

describe("getJobInstallDate", () => {
  it("returns null with no crew appointment", async () => {
    const [c] = await adminDb.insert(customer).values({ tenantId: tId, name: "NoInstall" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId: tId, customerId: c!.id, address: "9 St" }).returning();
    const [j] = await adminDb.insert(job).values({ tenantId: tId, customerId: c!.id, propertyId: p!.id }).returning();
    expect(await getJobInstallDate(tId, j!.id)).toBeNull();
  });

  it("returns the earliest scheduled crew appointment startsAt", async () => {
    const [c] = await adminDb.insert(customer).values({ tenantId: tId, name: "TwoAppts" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId: tId, customerId: c!.id, address: "10 St" }).returning();
    const [j] = await adminDb.insert(job).values({ tenantId: tId, customerId: c!.id, propertyId: p!.id }).returning();
    const early = new Date("2026-09-01T12:00:00.000Z");
    const late = new Date("2026-09-05T12:00:00.000Z");
    await adminDb.insert(appointment).values([
      { tenantId: tId, jobId: j!.id, type: "crew", status: "scheduled", startsAt: late, endsAt: new Date(late.getTime() + 3_600_000) },
      { tenantId: tId, jobId: j!.id, type: "crew", status: "scheduled", startsAt: early, endsAt: new Date(early.getTime() + 3_600_000) },
    ]);
    expect((await getJobInstallDate(tId, j!.id))?.toISOString()).toBe(early.toISOString());
  });
});
