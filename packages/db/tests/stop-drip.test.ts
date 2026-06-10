import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { pool } from "../src/client.js";
import { withTenant } from "../src/tenant.js";
import { stopDripEnrollments } from "../src/lifecycle/stop-drip.js";
import { tenant, customer, drip, dripEnrollment } from "../src/schema/index.js";

let tId: string, custId: string, dripId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "SD", publicKey: "sd", clerkOrgId: "org_sd" }).returning();
  tId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tId, name: "C" }).returning();
  custId = c!.id;
  const [d] = await adminDb.insert(drip).values({ tenantId: tId, key: "k", name: "D", steps: [] }).returning();
  dripId = d!.id;
  await adminDb.insert(dripEnrollment).values({ tenantId: tId, dripId, customerId: custId, status: "active" });
});

afterAll(async () => {
  await adminDb.delete(dripEnrollment).where(eq(dripEnrollment.tenantId, tId));
  await adminDb.delete(drip).where(eq(drip.tenantId, tId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

describe("stopDripEnrollments", () => {
  it("sets active enrollments for a customer to stopped + reason and returns their ids", async () => {
    const ids = await withTenant(tId, (tx) =>
      stopDripEnrollments(tx, { tenantId: tId, customerId: custId, reason: "reply" }),
    );
    expect(ids.length).toBe(1);
    const [row] = await adminDb.select().from(dripEnrollment).where(eq(dripEnrollment.id, ids[0]!));
    expect(row!.status).toBe("stopped");
    expect(row!.stoppedReason).toBe("reply");
  });

  it("is a no-op when there are no active enrollments", async () => {
    const ids = await withTenant(tId, (tx) =>
      stopDripEnrollments(tx, { tenantId: tId, customerId: custId, reason: "manual" }),
    );
    expect(ids).toEqual([]);
  });
});
