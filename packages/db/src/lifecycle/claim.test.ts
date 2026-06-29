import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { tenant, customer, property, job, appointment, claim } from "../schema/index.js";
import { bookAdjusterMeeting, getAdjusterAppointmentForJob } from "./claim.js";
import { getClaimForJob } from "./claim.js";

let tId: string;
let custId: string;
let jobId: string;

// A second tenant used for cross-tenant isolation checks.
let tId2: string;
let jobId2: string;

const T0 = new Date("2026-09-10T14:00:00.000Z");
const T1 = new Date("2026-09-10T15:00:00.000Z");

beforeAll(async () => {
  // Tenant 1 — primary
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "ClaimTest", publicKey: `pk-claim-${crypto.randomUUID()}`, clerkOrgId: `org-claim-${crypto.randomUUID()}` })
    .returning();
  tId = t!.id;

  const [c] = await adminDb
    .insert(customer)
    .values({ tenantId: tId, name: "Cust Claim", email: `claim-${crypto.randomUUID()}@x.com` })
    .returning();
  custId = c!.id;

  const [p] = await adminDb
    .insert(property)
    .values({ tenantId: tId, customerId: custId, address: "1 Claim St" })
    .returning();

  const [j] = await adminDb
    .insert(job)
    .values({ tenantId: tId, customerId: custId, propertyId: p!.id })
    .returning();
  jobId = j!.id;

  // Tenant 2 — for cross-tenant isolation tests
  const [t2] = await adminDb
    .insert(tenant)
    .values({ name: "ClaimTest2", publicKey: `pk-claim2-${crypto.randomUUID()}`, clerkOrgId: `org-claim2-${crypto.randomUUID()}` })
    .returning();
  tId2 = t2!.id;

  const [c2] = await adminDb
    .insert(customer)
    .values({ tenantId: tId2, name: "Cust2", email: `claim2-${crypto.randomUUID()}@x.com` })
    .returning();

  const [p2] = await adminDb
    .insert(property)
    .values({ tenantId: tId2, customerId: c2!.id, address: "2 Claim St" })
    .returning();

  const [j2] = await adminDb
    .insert(job)
    .values({ tenantId: tId2, customerId: c2!.id, propertyId: p2!.id })
    .returning();
  jobId2 = j2!.id;
});

afterAll(async () => {
  await adminDb.delete(appointment).where(eq(appointment.tenantId, tId));
  await adminDb.delete(appointment).where(eq(appointment.tenantId, tId2));
  await adminDb.delete(claim).where(eq(claim.tenantId, tId));
  await adminDb.delete(claim).where(eq(claim.tenantId, tId2));
  await adminDb.delete(job).where(eq(job.tenantId, tId));
  await adminDb.delete(job).where(eq(job.tenantId, tId2));
  await adminDb.delete(property).where(eq(property.tenantId, tId));
  await adminDb.delete(property).where(eq(property.tenantId, tId2));
  await adminDb.delete(customer).where(eq(customer.tenantId, tId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tId2));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId2));
  await pool.end();
  await adminPool.end();
});

describe("bookAdjusterMeeting", () => {
  it("creates an adjuster appointment with status=scheduled AND creates the claim when none exists", async () => {
    // Use a fresh job so we get a clean claim-less starting state
    const [p] = await adminDb
      .insert(property)
      .values({ tenantId: tId, customerId: custId, address: "3 Claim St" })
      .returning();
    const [j] = await adminDb
      .insert(job)
      .values({ tenantId: tId, customerId: custId, propertyId: p!.id })
      .returning();
    const freshJobId = j!.id;

    const result = await bookAdjusterMeeting({
      tenantId: tId,
      jobId: freshJobId,
      customerId: custId,
      startsAt: T0,
      endsAt: T1,
    });

    expect(result).toHaveProperty("appointmentId");
    expect(typeof result.appointmentId).toBe("string");

    // Verify the appointment row
    const appts = await adminDb
      .select()
      .from(appointment)
      .where(eq(appointment.id, result.appointmentId));
    expect(appts).toHaveLength(1);
    expect(appts[0]!.type).toBe("adjuster");
    expect(appts[0]!.status).toBe("scheduled");
    expect(appts[0]!.jobId).toBe(freshJobId);

    // Verify the claim was created with adjuster_scheduled
    const claimRow = await getClaimForJob(tId, freshJobId);
    expect(claimRow).not.toBeNull();
    expect(claimRow!.status).toBe("adjuster_scheduled");
  });

  it("updates an existing claim to adjuster_scheduled, preserving other fields", async () => {
    // Use a fresh job with a pre-existing claim
    const [p] = await adminDb
      .insert(property)
      .values({ tenantId: tId, customerId: custId, address: "4 Claim St" })
      .returning();
    const [j] = await adminDb
      .insert(job)
      .values({ tenantId: tId, customerId: custId, propertyId: p!.id })
      .returning();
    const freshJobId = j!.id;

    // Pre-create a claim with extra fields
    await adminDb.insert(claim).values({
      tenantId: tId,
      jobId: freshJobId,
      claimNumber: "CLM-2026-001",
      carrierName: "State Farm",
      status: "filed",
    });

    await bookAdjusterMeeting({
      tenantId: tId,
      jobId: freshJobId,
      startsAt: T0,
      endsAt: T1,
    });

    const claimRow = await getClaimForJob(tId, freshJobId);
    expect(claimRow!.status).toBe("adjuster_scheduled");
    // Other fields must be preserved
    expect(claimRow!.claimNumber).toBe("CLM-2026-001");
    expect(claimRow!.carrierName).toBe("State Farm");
  });
});

describe("getAdjusterAppointmentForJob", () => {
  it("returns the scheduled adjuster appointment, NOT a cm or inspection appointment", async () => {
    const [p] = await adminDb
      .insert(property)
      .values({ tenantId: tId, customerId: custId, address: "5 Claim St" })
      .returning();
    const [j] = await adminDb
      .insert(job)
      .values({ tenantId: tId, customerId: custId, propertyId: p!.id })
      .returning();
    const freshJobId = j!.id;

    // Insert a CM appointment (should NOT be returned)
    await adminDb.insert(appointment).values({
      tenantId: tId,
      jobId: freshJobId,
      type: "cm",
      status: "scheduled",
      startsAt: T0,
      endsAt: T1,
    });

    // Insert an inspection appointment (should NOT be returned)
    await adminDb.insert(appointment).values({
      tenantId: tId,
      jobId: freshJobId,
      type: "inspection",
      status: "scheduled",
      startsAt: T0,
      endsAt: T1,
    });

    // No adjuster appt yet — should return null
    const nullResult = await getAdjusterAppointmentForJob(tId, freshJobId);
    expect(nullResult).toBeNull();

    // Now add the adjuster appointment
    const adjResult = await bookAdjusterMeeting({
      tenantId: tId,
      jobId: freshJobId,
      startsAt: T0,
      endsAt: T1,
    });

    const found = await getAdjusterAppointmentForJob(tId, freshJobId);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(adjResult.appointmentId);
    expect(found!.startsAt).toEqual(T0);
    expect(found!.endsAt).toEqual(T1);
  });

  it("returns null when the job has no adjuster appointment", async () => {
    // Use a completely empty job with only a crew appointment (not adjuster)
    const [p] = await adminDb
      .insert(property)
      .values({ tenantId: tId, customerId: custId, address: "6 Claim St" })
      .returning();
    const [j] = await adminDb
      .insert(job)
      .values({ tenantId: tId, customerId: custId, propertyId: p!.id })
      .returning();
    const freshJobId = j!.id;

    await adminDb.insert(appointment).values({
      tenantId: tId,
      jobId: freshJobId,
      type: "crew",
      status: "scheduled",
      startsAt: T0,
      endsAt: T1,
    });

    const result = await getAdjusterAppointmentForJob(tId, freshJobId);
    expect(result).toBeNull();
  });

  it("returns null when the adjuster appointment is canceled (not scheduled)", async () => {
    const [p] = await adminDb
      .insert(property)
      .values({ tenantId: tId, customerId: custId, address: "7 Claim St" })
      .returning();
    const [j] = await adminDb
      .insert(job)
      .values({ tenantId: tId, customerId: custId, propertyId: p!.id })
      .returning();
    const freshJobId = j!.id;

    await adminDb.insert(appointment).values({
      tenantId: tId,
      jobId: freshJobId,
      type: "adjuster",
      status: "canceled",
      startsAt: T0,
      endsAt: T1,
    });

    const result = await getAdjusterAppointmentForJob(tId, freshJobId);
    expect(result).toBeNull();
  });
});

describe("cross-tenant isolation", () => {
  it("tenant 2 cannot read tenant 1 adjuster appointment via getAdjusterAppointmentForJob", async () => {
    // Book an adjuster meeting for tenant 1's job
    await bookAdjusterMeeting({
      tenantId: tId,
      jobId: jobId,
      startsAt: T0,
      endsAt: T1,
    });

    // Tenant 2 tries to read tenant 1's job — should get null
    const result = await getAdjusterAppointmentForJob(tId2, jobId);
    expect(result).toBeNull();
  });

  it("tenant 2 cannot read tenant 1 claim via getClaimForJob", async () => {
    // Ensure tenant 1 has a claim on jobId
    await bookAdjusterMeeting({
      tenantId: tId,
      jobId: jobId,
      startsAt: new Date("2026-09-11T14:00:00.000Z"),
      endsAt: new Date("2026-09-11T15:00:00.000Z"),
    });

    // Tenant 2 tries to read it — should get null (RLS)
    const result = await getClaimForJob(tId2, jobId);
    expect(result).toBeNull();
  });
});
