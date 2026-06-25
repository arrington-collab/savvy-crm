// CI-gated: requires Postgres. If ECONNREFUSED locally, this suite is expected
// to fail — rely on CI. The drive-time ranking math is already unit-tested in
// packages/core.
import { describe, it, expect, beforeAll } from "vitest";
import { adminDb, withTenant, tenant, user, customer, lead, property } from "@savvy/db";
import { getRecommendedSlots } from "./recommended-slots";

let tenantId: string;
let assignedLeadId: string;
let unassignedLeadId: string;

beforeAll(async () => {
  const [t] = await adminDb
    .insert(tenant)
    .values({
      name: "SlotsTest",
      clerkOrgId: `org_slots_${Date.now()}`,
      settings: {
        scheduling: {
          workdays: [1, 2, 3, 4, 5],
          startHour: 8,
          endHour: 17,
          slotMinutes: 60,
          bookingHorizonDays: 14,
          office: { lat: 33.4484, lng: -112.074 },
        },
      },
    })
    .returning();
  tenantId = t!.id;

  await withTenant(tenantId, async (tx) => {
    const [rep] = await tx
      .insert(user)
      .values({
        tenantId,
        name: "Slots Rep",
        email: `slots-${Date.now()}@x.com`,
        role: "rep",
        baseLat: 33.45,
        baseLng: -112.07,
      })
      .returning();

    const [c] = await tx.insert(customer).values({ tenantId, name: "Slots Cust" }).returning();
    const [p] = await tx
      .insert(property)
      .values({ tenantId, customerId: c!.id, address: "200 Slot St", lat: 33.5, lng: -112.1 })
      .returning();

    // Lead assigned to the rep
    const [assigned] = await tx
      .insert(lead)
      .values({ tenantId, customerId: c!.id, propertyId: p!.id, status: "new", assignedUserId: rep!.id })
      .returning();
    assignedLeadId = assigned!.id;

    // Lead with no assignee
    const [unassigned] = await tx
      .insert(lead)
      .values({ tenantId, customerId: c!.id, propertyId: p!.id, status: "new" })
      .returning();
    unassignedLeadId = unassigned!.id;
  });
});

describe("getRecommendedSlots", () => {
  it("returns up to 3 ranked slots each with a driveMinutes value (fake provider active)", async () => {
    const result = await getRecommendedSlots(assignedLeadId, { limit: 3 });
    expect("error" in result).toBe(false);
    if ("error" in result) return; // type narrowing for TS
    expect(result.slots.length).toBeGreaterThan(0);
    expect(result.slots.length).toBeLessThanOrEqual(3);
    for (const slot of result.slots) {
      expect(typeof slot.startsAt).toBe("string");
      expect(typeof slot.endsAt).toBe("string");
      // fake distance provider returns a number, not null
      expect(typeof slot.driveMinutes).toBe("number");
    }
  });

  it("returns no_assignee for an unassigned lead", async () => {
    const result = await getRecommendedSlots(unassignedLeadId);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe("no_assignee");
    }
  });

  it("returns no_lead for a nonexistent lead id", async () => {
    const result = await getRecommendedSlots("00000000-0000-0000-0000-000000000000");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe("no_lead");
    }
  });
});
