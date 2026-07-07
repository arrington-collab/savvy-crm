import { withTenant, adminDb, eq, appointment, measurement, tenant, recordAgentRun } from "@savvy/db";
import { parseSchedulingConfig } from "@savvy/core";
import { inngest } from "../client";

/**
 * Pure decision: should we auto-order a Roofr measurement for this appointment?
 * Only when the tenant opted in, the appointment is a SCHEDULED inspection, and
 * the property has no measurement yet (avoid re-ordering / paying twice).
 * Extracted so the decision is unit-testable without an Inngest/DB harness.
 */
export function shouldAutoOrderMeasurement(input: {
  enabled: boolean;
  apptType: string;
  apptStatus: string;
  hasMeasurement: boolean;
}): boolean {
  return (
    input.enabled &&
    input.apptType === "inspection" &&
    input.apptStatus === "scheduled" &&
    !input.hasMeasurement
  );
}

/**
 * Inngest: on `appointment/booked`, if the tenant enabled auto-ordering and an
 * inspection was just booked for a property with no measurement, emit
 * `roofr/order.requested` — reusing the existing order→persist→estimate pipeline.
 * Dormant by default (the `autoOrderMeasurement` toggle defaults off).
 */
export const autoOrderMeasurementOnInspection = inngest.createFunction(
  { id: "auto-order-measurement-on-inspection", concurrency: { limit: 5 } },
  { event: "appointment/booked" },
  async ({ event, step }) => {
    const { appointmentId, tenantId } = event.data;

    const ctx = await step.run("load", () =>
      withTenant(tenantId, async (tx) => {
        const [a] = await tx
          .select({ type: appointment.type, status: appointment.status, jobId: appointment.jobId, leadId: appointment.leadId, propertyId: appointment.propertyId })
          .from(appointment)
          .where(eq(appointment.id, appointmentId));
        if (!a || !a.propertyId) return null;
        const existing = await tx
          .select({ id: measurement.id })
          .from(measurement)
          .where(eq(measurement.propertyId, a.propertyId))
          .limit(1);
        return { apptType: a.type, apptStatus: a.status, jobId: a.jobId, leadId: a.leadId, propertyId: a.propertyId, hasMeasurement: existing.length > 0 };
      }),
    );
    if (!ctx) return { skipped: "not_found" as const };

    // Cheap gate first — most bookings aren't fresh inspections. Short-circuit before
    // the per-tenant settings read so we don't touch the DB (or log) on every booking.
    if (ctx.apptType !== "inspection" || ctx.apptStatus !== "scheduled" || ctx.hasMeasurement) {
      return { skipped: "not_applicable" as const };
    }

    // Tenant toggle lives on the tenant row (RLS isolation root → adminDb, like other settings reads).
    const enabled = await step.run("config", async () => {
      const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
      return parseSchedulingConfig((t?.settings as { scheduling?: unknown } | null)?.scheduling).autoOrderMeasurement;
    });

    if (!shouldAutoOrderMeasurement({ enabled, apptType: ctx.apptType, apptStatus: ctx.apptStatus, hasMeasurement: ctx.hasMeasurement })) {
      return { skipped: "disabled" as const };
    }

    await step.sendEvent("request-order", {
      name: "roofr/order.requested",
      data: { tenantId, propertyId: ctx.propertyId, jobId: ctx.jobId ?? undefined, leadId: ctx.leadId ?? undefined },
    });
    await step.run("record-ok", () =>
      recordAgentRun({ tenantId, agent: "scheduling", taskKey: "measurement.auto_order", jobId: ctx.jobId ?? undefined, status: "ok" }),
    );
    return { ordered: true as const };
  },
);
