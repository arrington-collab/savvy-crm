import { afterAll, describe, it, expect } from "vitest";
import { inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { tenant, customer, property, job, appointment, license } from "../schema/index.js";
import { bookAppointment, LicenseRequiredError } from "./appointments.js";

const tenantIds: string[] = [];

// Inserts tenant → customer → property (with optional state) → job, returns { tenantId, jobId }
async function makeJob(state: string | null) {
  const [t] = await adminDb
    .insert(tenant)
    .values({
      name: "LicTest",
      publicKey: `pk-lic-${crypto.randomUUID()}`,
      clerkOrgId: `org-lic-${crypto.randomUUID()}`,
    })
    .returning();
  const tenantId = t!.id;
  tenantIds.push(tenantId);

  const [c] = await adminDb
    .insert(customer)
    .values({ tenantId, name: "Lic Cust" })
    .returning();

  const [p] = await adminDb
    .insert(property)
    .values({ tenantId, customerId: c!.id, address: "1 Lic St", state: state ?? undefined })
    .returning();

  const [j] = await adminDb
    .insert(job)
    .values({ tenantId, customerId: c!.id, propertyId: p!.id })
    .returning();

  return { tenantId, jobId: j!.id };
}

afterAll(async () => {
  if (tenantIds.length) {
    await adminDb.delete(appointment).where(inArray(appointment.tenantId, tenantIds));
    await adminDb.delete(license).where(inArray(license.tenantId, tenantIds));
    await adminDb.delete(job).where(inArray(job.tenantId, tenantIds));
    await adminDb.delete(property).where(inArray(property.tenantId, tenantIds));
    await adminDb.delete(customer).where(inArray(customer.tenantId, tenantIds));
    await adminDb.delete(tenant).where(inArray(tenant.id, tenantIds));
  }
  await pool.end();
  await adminPool.end();
});

describe("bookAppointment license block (cell 17a)", () => {
  it("throws LicenseRequiredError for a CO property with no CO license", async () => {
    const { tenantId, jobId } = await makeJob("CO");
    await expect(
      bookAppointment({
        tenantId,
        jobId,
        type: "inspection",
        assigneeUserId: null,
        startsAt: new Date("2027-08-01T15:00:00Z"),
        endsAt: new Date("2027-08-01T16:00:00Z"),
      }),
    ).rejects.toBeInstanceOf(LicenseRequiredError);
  });

  it("succeeds once an active CO license (state-level) exists", async () => {
    const { tenantId, jobId } = await makeJob("CO");

    await adminDb.insert(license).values({
      tenantId,
      state: "CO",
      city: null,
      authority: "CO SoS",
      licenseNumber: "CO-1",
      status: "active",
    });

    const res = await bookAppointment({
      tenantId,
      jobId,
      type: "inspection",
      assigneeUserId: null,
      startsAt: new Date("2027-08-02T15:00:00Z"),
      endsAt: new Date("2027-08-02T16:00:00Z"),
    });
    expect(res.id).toBeTruthy();
  });

  it("does NOT block a property with a null state (escape valve)", async () => {
    const { tenantId, jobId } = await makeJob(null);
    const res = await bookAppointment({
      tenantId,
      jobId,
      type: "crew",
      assigneeUserId: null,
      startsAt: new Date("2027-08-03T15:00:00Z"),
      endsAt: new Date("2027-08-03T16:00:00Z"),
    });
    expect(res.id).toBeTruthy();
  });

  it("succeeds for an AZ property with an active AZ state-level license", async () => {
    const { tenantId, jobId } = await makeJob("AZ");

    await adminDb.insert(license).values({
      tenantId,
      state: "AZ",
      city: null,
      authority: "AZ ROC",
      licenseNumber: "AZ-ROC-123",
      status: "active",
    });

    const res = await bookAppointment({
      tenantId,
      jobId,
      type: "inspection",
      assigneeUserId: null,
      startsAt: new Date("2027-08-04T15:00:00Z"),
      endsAt: new Date("2027-08-04T16:00:00Z"),
    });
    expect(res.id).toBeTruthy();
  });
});
