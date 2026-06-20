import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { appointment } from "../src/schema/comms.js";
import { eq } from "drizzle-orm";
import { makeTenant, makeJobWithCustomer } from "./helpers.js";
import { bookAppointment } from "../src/lifecycle/appointments.js";

describe("bookAppointment with a null assignee", () => {
  it("creates an unassigned scheduled appointment", async () => {
    const { tenantId } = await makeTenant();
    const { jobId, customerId } = await makeJobWithCustomer(tenantId);

    const { id } = await bookAppointment({
      tenantId,
      jobId,
      customerId,
      type: "inspection",
      assigneeUserId: null,
      startsAt: new Date("2026-07-01T17:00:00Z"),
      endsAt: new Date("2026-07-01T18:00:00Z"),
    });

    const [row] = await withTenant(tenantId, (tx) =>
      tx.select().from(appointment).where(eq(appointment.id, id)),
    );
    expect(row?.assigneeUserId).toBeNull();
    expect(row?.status).toBe("scheduled");
  });

  it("does NOT raise SlotTaken for two overlapping null-assignee appointments", async () => {
    const { tenantId } = await makeTenant();
    const { jobId, customerId } = await makeJobWithCustomer(tenantId);

    const at = {
      startsAt: new Date("2026-07-02T17:00:00Z"),
      endsAt: new Date("2026-07-02T18:00:00Z"),
    };

    await bookAppointment({
      tenantId,
      jobId,
      customerId,
      type: "inspection",
      assigneeUserId: null,
      ...at,
    });

    await expect(
      bookAppointment({
        tenantId,
        jobId,
        customerId,
        type: "inspection",
        assigneeUserId: null,
        ...at,
      }),
    ).resolves.toBeTruthy();
  });
});
