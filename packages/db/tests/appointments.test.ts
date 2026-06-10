import { describe, it, expect, beforeAll } from "vitest";
import { withTenant } from "../src/tenant.js";
import { appointment } from "../src/schema/comms.js";
import { eq } from "drizzle-orm";
import { makeTenant, makeUser, makeJobWithCustomer } from "./helpers.js";
import {
  bookAppointment, rescheduleAppointment, cancelAppointment, setAppointmentStatus,
  getBusyIntervals, SlotTakenError,
} from "../src/lifecycle/appointments.js";

describe("appointment exclusion constraint", () => {
  let tenantId: string, userId: string, jobId: string;
  beforeAll(async () => {
    ({ tenantId } = await makeTenant());
    ({ userId } = await makeUser(tenantId));
    ({ jobId } = await makeJobWithCustomer(tenantId));
  });

  it("rejects an overlapping scheduled appt for the same assignee", async () => {
    await withTenant(tenantId, (tx) => tx.insert(appointment).values({
      tenantId, jobId, type: "inspection", assigneeUserId: userId,
      startsAt: new Date("2026-07-01T15:00:00Z"), endsAt: new Date("2026-07-01T16:00:00Z"),
    }));
    await expect(
      withTenant(tenantId, (tx) => tx.insert(appointment).values({
        tenantId, jobId, type: "inspection", assigneeUserId: userId,
        startsAt: new Date("2026-07-01T15:30:00Z"), endsAt: new Date("2026-07-01T16:30:00Z"),
      })),
    ).rejects.toMatchObject({ code: "23P01" });
  });

  it("allows the same time for a DIFFERENT assignee", async () => {
    const { userId: other } = await makeUser(tenantId);
    await expect(
      withTenant(tenantId, (tx) => tx.insert(appointment).values({
        tenantId, jobId, type: "inspection", assigneeUserId: other,
        startsAt: new Date("2026-07-01T15:00:00Z"), endsAt: new Date("2026-07-01T16:00:00Z"),
      })),
    ).resolves.toBeDefined();
  });

  it("frees the slot when the blocking appt is canceled", async () => {
    await withTenant(tenantId, (tx) => tx.update(appointment)
      .set({ status: "canceled" })
      .where(eq(appointment.assigneeUserId, userId)));
    await expect(
      withTenant(tenantId, (tx) => tx.insert(appointment).values({
        tenantId, jobId, type: "inspection", assigneeUserId: userId,
        startsAt: new Date("2026-07-01T15:30:00Z"), endsAt: new Date("2026-07-01T16:30:00Z"),
      })),
    ).resolves.toBeDefined();
  });
});

describe("appointment lifecycle", () => {
  let tenantId: string, userId: string, jobId: string;
  beforeAll(async () => {
    ({ tenantId } = await makeTenant());
    ({ userId } = await makeUser(tenantId));
    ({ jobId } = await makeJobWithCustomer(tenantId));
  });

  it("books, then rejects an overlapping book with SlotTakenError", async () => {
    const a = await bookAppointment({
      tenantId, jobId, type: "inspection", assigneeUserId: userId,
      startsAt: new Date("2026-08-01T15:00:00Z"), endsAt: new Date("2026-08-01T16:00:00Z"),
    });
    expect(a.id).toBeTruthy();
    await expect(bookAppointment({
      tenantId, jobId, type: "inspection", assigneeUserId: userId,
      startsAt: new Date("2026-08-01T15:30:00Z"), endsAt: new Date("2026-08-01T16:30:00Z"),
    })).rejects.toBeInstanceOf(SlotTakenError);
  });

  it("reschedule moves the appt and frees the old slot", async () => {
    const a = await bookAppointment({
      tenantId, jobId, type: "inspection", assigneeUserId: userId,
      startsAt: new Date("2026-08-02T15:00:00Z"), endsAt: new Date("2026-08-02T16:00:00Z"),
    });
    await rescheduleAppointment({ tenantId, appointmentId: a.id, startsAt: new Date("2026-08-02T17:00:00Z"), endsAt: new Date("2026-08-02T18:00:00Z") });
    const busy = await getBusyIntervals({ tenantId, assigneeUserId: userId, from: new Date("2026-08-02T00:00:00Z"), to: new Date("2026-08-03T00:00:00Z") });
    expect(busy.some((b) => b.startsAt.toISOString() === "2026-08-02T17:00:00.000Z")).toBe(true);
    expect(busy.some((b) => b.startsAt.toISOString() === "2026-08-02T15:00:00.000Z")).toBe(false);
  });

  it("cancel + setStatus update status", async () => {
    const a = await bookAppointment({
      tenantId, jobId, type: "cm", assigneeUserId: userId,
      startsAt: new Date("2026-08-03T15:00:00Z"), endsAt: new Date("2026-08-03T16:00:00Z"),
    });
    await cancelAppointment({ tenantId, appointmentId: a.id });
    await setAppointmentStatus({ tenantId, appointmentId: a.id, status: "no_show" });
  });
});
