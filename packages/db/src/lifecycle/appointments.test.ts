import { afterAll, describe, it, expect } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { tenant, customer, property, job, appointment, crew } from "../schema/index.js";
import { bookAppointment, SlotTakenError } from "./appointments.js";

const tenantIds: string[] = [];

async function seedContext() {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "ApptTest", publicKey: `pk-appt-${crypto.randomUUID()}`, clerkOrgId: `org-appt-${crypto.randomUUID()}` })
    .returning();
  tenantIds.push(t!.id);
  const tenantId = t!.id;

  const [c] = await adminDb
    .insert(customer)
    .values({ tenantId, name: "Appt Cust" })
    .returning();

  const [p] = await adminDb
    .insert(property)
    .values({ tenantId, customerId: c!.id, address: "1 Appt St" })
    .returning();

  const [j] = await adminDb
    .insert(job)
    .values({ tenantId, customerId: c!.id, propertyId: p!.id })
    .returning();

  const [cr] = await adminDb
    .insert(crew)
    .values({ tenantId, name: "Install Crew A" })
    .returning();

  const [cr2] = await adminDb
    .insert(crew)
    .values({ tenantId, name: "Install Crew B" })
    .returning();

  return { tenantId, jobId: j!.id, crewId: cr!.id, crewId2: cr2!.id };
}

afterAll(async () => {
  if (tenantIds.length) {
    await adminDb.delete(appointment).where(inArray(appointment.tenantId, tenantIds));
    await adminDb.delete(crew).where(inArray(crew.tenantId, tenantIds));
    await adminDb.delete(job).where(inArray(job.tenantId, tenantIds));
    await adminDb.delete(property).where(inArray(property.tenantId, tenantIds));
    await adminDb.delete(customer).where(inArray(customer.tenantId, tenantIds));
    await adminDb.delete(tenant).where(inArray(tenant.id, tenantIds));
  }
  await pool.end();
  await adminPool.end();
});

// Base times for crew overlap tests — far in the future to avoid collisions with other test files
const T0 = new Date("2027-03-15T08:00:00.000Z");
const T1 = new Date("2027-03-15T12:00:00.000Z");
const T_MID = new Date("2027-03-15T10:00:00.000Z");
const T2 = new Date("2027-03-15T14:00:00.000Z");

describe("bookAppointment crew overlap", () => {
  it("two overlapping type='crew' appointments for the same crewId → second throws SlotTakenError", async () => {
    const { tenantId, jobId, crewId } = await seedContext();

    // Book the first appointment for the crew
    await bookAppointment({
      tenantId,
      jobId,
      type: "crew",
      assigneeUserId: null,
      startsAt: T0,
      endsAt: T1,
      crewId,
    });

    // Overlapping appointment for the same crew should throw
    await expect(
      bookAppointment({
        tenantId,
        jobId,
        type: "crew",
        assigneeUserId: null,
        startsAt: T_MID,
        endsAt: T2,
        crewId,
      }),
    ).rejects.toThrow(SlotTakenError);
  });

  it("non-overlapping time for same crewId succeeds", async () => {
    const { tenantId, jobId, crewId } = await seedContext();

    // First booking: T0 → T1
    await bookAppointment({
      tenantId,
      jobId,
      type: "crew",
      assigneeUserId: null,
      startsAt: T0,
      endsAt: T1,
      crewId,
    });

    // Non-overlapping: starts exactly when first ends (adjacent, not overlapping)
    const result = await bookAppointment({
      tenantId,
      jobId,
      type: "crew",
      assigneeUserId: null,
      startsAt: T1,
      endsAt: T2,
      crewId,
    });
    expect(typeof result.id).toBe("string");
  });

  it("different crewId succeeds even with same overlapping time", async () => {
    const { tenantId, jobId, crewId, crewId2 } = await seedContext();

    // Book crew1 at T0–T1
    await bookAppointment({
      tenantId,
      jobId,
      type: "crew",
      assigneeUserId: null,
      startsAt: T0,
      endsAt: T1,
      crewId,
    });

    // Book crew2 at same overlapping time — should succeed (different crew)
    const result = await bookAppointment({
      tenantId,
      jobId,
      type: "crew",
      assigneeUserId: null,
      startsAt: T0,
      endsAt: T1,
      crewId: crewId2,
    });
    expect(typeof result.id).toBe("string");
  });

  it("persisted appointment row has the expected crewId", async () => {
    const { tenantId, jobId, crewId } = await seedContext();

    const { id } = await bookAppointment({
      tenantId,
      jobId,
      type: "crew",
      assigneeUserId: null,
      startsAt: new Date("2027-04-01T08:00:00.000Z"),
      endsAt: new Date("2027-04-01T12:00:00.000Z"),
      crewId,
    });

    const [row] = await adminDb
      .select()
      .from(appointment)
      .where(eq(appointment.id, id));

    expect(row!.crewId).toBe(crewId);
  });
});
