import { describe, it, expect, beforeAll } from "vitest";
import { withTenant } from "../src/tenant.js";
import { appointment } from "../src/schema/comms.js";
import { eq } from "drizzle-orm";
import { makeTenant, makeUser, makeJobWithCustomer } from "./helpers.js";
import { bookAppointment, reassignAppointment, SlotTakenError } from "../src/lifecycle/appointments.js";

describe("reassignAppointment", () => {
  let tenantId: string;
  let jobId: string;
  let userAId: string;   // original assignee
  let userBFreeId: string; // target with no conflicts
  let userBBusyId: string; // target with an overlapping appt
  let apptAId: string;    // the appt we will reassign (09:00-10:00)

  beforeAll(async () => {
    ({ tenantId } = await makeTenant());
    ({ jobId } = await makeJobWithCustomer(tenantId));
    ({ userId: userAId } = await makeUser(tenantId));
    ({ userId: userBFreeId } = await makeUser(tenantId));
    ({ userId: userBBusyId } = await makeUser(tenantId));

    // apptA: userA has 09:00-10:00 on 2026-09-01
    const a = await bookAppointment({
      tenantId, jobId, type: "inspection", assigneeUserId: userAId,
      startsAt: new Date("2026-09-01T16:00:00Z"), endsAt: new Date("2026-09-01T17:00:00Z"),
    });
    apptAId = a.id;

    // seed userBBusy with an overlapping scheduled appt (09:00-10:00 same window)
    await withTenant(tenantId, (tx) => tx.insert(appointment).values({
      tenantId, jobId, type: "inspection", assigneeUserId: userBBusyId,
      startsAt: new Date("2026-09-01T16:00:00Z"), endsAt: new Date("2026-09-01T17:00:00Z"),
    }));
  });

  it("reassigns a scheduled appointment to a free user", async () => {
    await reassignAppointment({ tenantId, appointmentId: apptAId, assigneeUserId: userBFreeId });

    const [row] = await withTenant(tenantId, (tx) =>
      tx.select({ assigneeUserId: appointment.assigneeUserId })
        .from(appointment)
        .where(eq(appointment.id, apptAId)),
    );
    expect(row?.assigneeUserId).toBe(userBFreeId);
  });

  it("throws SlotTakenError when target user already has an overlapping scheduled appt", async () => {
    // Re-assign apptA back to userA first so it's not on userBFree (free slot for clean test)
    await withTenant(tenantId, (tx) =>
      tx.update(appointment)
        .set({ assigneeUserId: userAId })
        .where(eq(appointment.id, apptAId)),
    );

    await expect(
      reassignAppointment({ tenantId, appointmentId: apptAId, assigneeUserId: userBBusyId }),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });

  it("does not change anything when appointmentId belongs to a different tenant", async () => {
    const { tenantId: otherTenantId } = await makeTenant();

    // Try to reassign apptA using the wrong tenantId (cross-tenant isolation)
    await reassignAppointment({ tenantId: otherTenantId, appointmentId: apptAId, assigneeUserId: userBFreeId });

    // apptA should still be assigned to userAId (no change due to tenant mismatch)
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select({ assigneeUserId: appointment.assigneeUserId })
        .from(appointment)
        .where(eq(appointment.id, apptAId)),
    );
    expect(row?.assigneeUserId).toBe(userAId);
  });
});
