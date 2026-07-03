import { describe, it, expect } from "vitest";
import { adminDb, tenant, customer, property, job, appointment, user, crew, crewMember } from "../index";
import { getCrewBusyStarts, getCrewContacts } from "../index";

async function seed() {
  const [t] = await adminDb.insert(tenant).values({ name: "CR", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` }).returning();
  const tenantId = t!.id;
  const [cr] = await adminDb.insert(crew).values({ tenantId, name: "Blue Crew" }).returning();
  const [u] = await adminDb.insert(user).values({ tenantId, email: `crew-${crypto.randomUUID()}@ex.com`, phone: "+15551230000", role: "crew", name: "Lead Hand" }).returning();
  await adminDb.insert(crewMember).values({ tenantId, crewId: cr!.id, userId: u!.id });
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "C" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 A St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  return { tenantId, crewId: cr!.id, jobId: j!.id, customerId: c!.id, email: u!.email };
}

describe("crew readers", () => {
  it("getCrewBusyStarts returns scheduled crew appt starts, excluding one", async () => {
    const { tenantId, crewId, jobId, customerId } = await seed();
    const base = new Date(Date.now() + 3 * 86_400_000);
    const [keep] = await adminDb.insert(appointment).values({ tenantId, jobId, customerId, crewId, type: "crew", status: "scheduled", startsAt: base, endsAt: new Date(base.getTime() + 3_600_000) }).returning();
    const excl = new Date(base.getTime() + 86_400_000);
    const [drop] = await adminDb.insert(appointment).values({ tenantId, jobId, customerId, crewId, type: "crew", status: "scheduled", startsAt: excl, endsAt: new Date(excl.getTime() + 3_600_000) }).returning();

    const starts = await getCrewBusyStarts({ tenantId, crewId, from: new Date(Date.now()), to: new Date(Date.now() + 30 * 86_400_000), excludeAppointmentId: drop!.id });
    expect(starts.map((d) => d.getTime())).toContain(keep!.startsAt.getTime());
    expect(starts.map((d) => d.getTime())).not.toContain(drop!.startsAt.getTime());
  });

  it("getCrewContacts returns member users' phone + email", async () => {
    const { tenantId, crewId, email } = await seed();
    const contacts = await getCrewContacts({ tenantId, crewId });
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.email).toBe(email);
    expect(contacts[0]!.phone).toBe("+15551230000");
  });
});
