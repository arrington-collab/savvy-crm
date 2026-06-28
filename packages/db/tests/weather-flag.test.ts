import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { setAppointmentWeatherFlag } from "../src/lifecycle/appointments.js";
import { appointment } from "../src/schema/index.js";
import { adminDb } from "../src/admin-client.js";
import { eq } from "drizzle-orm";
import { makeTenant, makeJobWithCustomer } from "./helpers.js";

async function seedCrewAppt(): Promise<{ tenantId: string; appointmentId: string }> {
  const { tenantId } = await makeTenant();
  const { jobId, customerId } = await makeJobWithCustomer(tenantId);
  const now = new Date();
  const [a] = await adminDb.insert(appointment).values({
    tenantId, jobId, customerId, type: "crew", status: "scheduled",
    startsAt: new Date(now.getTime() + 2 * 86_400_000), endsAt: new Date(now.getTime() + 2 * 86_400_000 + 3_600_000),
  }).returning();
  return { tenantId, appointmentId: a!.id };
}

describe("setAppointmentWeatherFlag", () => {
  it("sets note + flagged_at, then clears on null", async () => {
    const { tenantId, appointmentId } = await seedCrewAppt();
    await setAppointmentWeatherFlag({ tenantId, appointmentId, note: "Rain 80%" });
    let [r] = await withTenant(tenantId, (tx) => tx.select({ n: appointment.weatherNote, f: appointment.weatherFlaggedAt }).from(appointment).where(eq(appointment.id, appointmentId)));
    expect(r!.n).toBe("Rain 80%");
    expect(r!.f).not.toBeNull();
    await setAppointmentWeatherFlag({ tenantId, appointmentId, note: null });
    [r] = await withTenant(tenantId, (tx) => tx.select({ n: appointment.weatherNote, f: appointment.weatherFlaggedAt }).from(appointment).where(eq(appointment.id, appointmentId)));
    expect(r!.n).toBeNull();
    expect(r!.f).toBeNull();
  });
});
