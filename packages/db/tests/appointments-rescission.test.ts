import { beforeAll, afterAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookAppointment, RescissionHoldError } from "../src/index.js";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, job, license, appointment } from "../src/schema/index.js";

let tid: string, heldJob: string, freeJob: string;
const future = new Date(Date.now() + 3 * 86_400_000);
const past = new Date(Date.now() - 86_400_000);

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "RH", publicKey: `rh-${Date.now()}`, clerkOrgId: `org_rh_${Date.now()}` }).returning();
  tid = t!.id;
  await adminDb.insert(license).values({ tenantId: tid, state: "AZ", city: null, authority: "ROC", licenseNumber: `L-${tid}`, status: "active", expiresAt: null });
  const [c] = await adminDb.insert(customer).values({ tenantId: tid, name: "c" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: tid, customerId: c!.id, address: `a-${crypto.randomUUID()}`, state: "AZ" }).returning();
  const [h] = await adminDb.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead", rescissionHoldUntil: future }).returning();
  const [f] = await adminDb.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead", rescissionHoldUntil: past }).returning();
  heldJob = h!.id; freeJob = f!.id;
});
afterAll(async () => {
  await adminDb.delete(appointment).where(eq(appointment.tenantId, tid));
  await adminDb.delete(job).where(eq(job.tenantId, tid));
  await adminDb.delete(license).where(eq(license.tenantId, tid));
  await adminDb.delete(property).where(eq(property.tenantId, tid));
  await adminDb.delete(customer).where(eq(customer.tenantId, tid));
  await adminDb.delete(tenant).where(eq(tenant.id, tid));
  await adminPool.end();
});

const slot = () => ({ startsAt: new Date(Date.now() + 7 * 86_400_000), endsAt: new Date(Date.now() + 7 * 86_400_000 + 3_600_000) });

it("crew booking is BLOCKED while the job is under a rescission hold (RED PATH #3)", async () => {
  await expect(bookAppointment({ tenantId: tid, jobId: heldJob, type: "crew", assigneeUserId: null, ...slot() }))
    .rejects.toBeInstanceOf(RescissionHoldError);
});
it("non-crew (inspection) booking is allowed during the hold", async () => {
  const r = await bookAppointment({ tenantId: tid, jobId: heldJob, type: "inspection", assigneeUserId: null, ...slot() });
  expect(r.id).toBeTruthy();
});
it("crew booking is allowed once the hold has elapsed (auto-release)", async () => {
  const r = await bookAppointment({ tenantId: tid, jobId: freeJob, type: "crew", assigneeUserId: null, ...slot() });
  expect(r.id).toBeTruthy();
});
