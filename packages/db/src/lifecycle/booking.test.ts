import { describe, it, expect, beforeAll } from "vitest";
import { bookLeadSlot } from "./booking.js";
import { adminDb, withTenant, tenant, user, customer, property, lead, appointment, job, eq } from "../index.js";

let tenantId: string;
let leadId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "Book Test Co", publicKey: `book-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [u] = await adminDb.insert(user).values({ tenantId, role: "rep", name: "Rep", email: `rep-${Date.now()}@x.com` }).returning();
  await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Homeowner", phone: "+16025550000" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "1 Main" }).returning();
    const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, status: "new", assignedUserId: u!.id }).returning();
    leadId = l!.id;
  });
});

describe("bookLeadSlot", () => {
  it("books a lead-scoped inspection without creating a job", async () => {
    const startsAt = new Date(Date.now() + 86_400_000).toISOString();
    const endsAt = new Date(Date.now() + 86_400_000 + 3_600_000).toISOString();
    const res = await bookLeadSlot({ leadId, startsAt, endsAt });
    expect("appointmentId" in res).toBe(true);
    const appts = await adminDb.select().from(appointment).where(eq(appointment.tenantId, tenantId));
    expect(appts).toHaveLength(1);
    expect(appts[0]!.leadId).toBe(leadId);
    expect(appts[0]!.jobId).toBeNull();
    // Slice 1: no job is created at booking — it waits for an accepted estimate.
    const jobs = await adminDb.select().from(job).where(eq(job.leadId, leadId));
    expect(jobs).toHaveLength(0);
  });

  it("returns no_lead for an unknown lead id", async () => {
    expect(await bookLeadSlot({ leadId: "00000000-0000-0000-0000-000000000000", startsAt: new Date().toISOString(), endsAt: new Date().toISOString() }))
      .toEqual({ error: "no_lead" });
  });
});
