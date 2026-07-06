import { describe, it, expect } from "vitest";
import { bookAppointment } from "../src/lifecycle/appointments.js";
import { adminDb, appointment, eq } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

/**
 * Slice 1: an inspection is booked against the LEAD before any job exists. The
 * appointment carries lead_id + property_id and job_id stays null until the
 * accepted estimate creates the job.
 */
describe("bookAppointment — lead-scoped inspection", () => {
  it("books an inspection against a lead with job_id null", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId, customerId } = await makeLeadWithProperty(tenantId);

    const { id } = await bookAppointment({
      tenantId,
      leadId,
      customerId,
      type: "inspection",
      assigneeUserId: null,
      startsAt: new Date(Date.now() + 3600_000),
      endsAt: new Date(Date.now() + 7200_000),
    });

    const [a] = await adminDb.select().from(appointment).where(eq(appointment.id, id));
    expect(a!.jobId).toBeNull();
    expect(a!.leadId).toBe(leadId);
    expect(a!.propertyId).toBe(propertyId);
  });
});
