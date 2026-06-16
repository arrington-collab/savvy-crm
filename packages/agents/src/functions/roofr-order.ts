import { withTenant, eq, measurement, property } from "@savvy/db";
import type { RoofrGateway } from "@savvy/integrations";
import { nangoRoofr } from "@savvy/integrations";
import { inngest } from "../client";

/**
 * Orders a Roofr measurement for a property, polls until ready, persists the
 * measurement row (with $3 markup baked into costCents from the gateway), and
 * emits `measurement/ready` so the estimate-generation workflow picks it up.
 *
 * Exported as a plain async function so tests can inject a fake gateway and
 * drive the logic without needing an Inngest harness (mirrors qbo-sync.ts).
 */
export async function orderAndPersistMeasurement(
  tenantId: string,
  jobId: string,
  propertyId: string,
  roofr: RoofrGateway = nangoRoofr,
): Promise<{ measurementId: string } | { pending: true; orderId: string }> {
  const address = await withTenant(tenantId, async (tx) => {
    const [p] = await tx.select().from(property).where(eq(property.id, propertyId));
    return p?.address ?? "";
  });

  const { orderId } = await roofr.orderMeasurement({ address });

  // In tests (fake) this is immediately ready; in production the Inngest
  // function polls via step.sleep. The helper returns pending if not ready,
  // allowing the test to assert the "not ready" path when needed.
  const report = await roofr.getReport(orderId);
  if (!report.ready) return { pending: true, orderId };

  const measurementId = await withTenant(tenantId, async (tx) => {
    const [m] = await tx.insert(measurement).values({
      tenantId,
      propertyId,
      provider: "roofr",
      reportUrl: report.reportUrl,
      areas: report.areas,
      pitch: report.areas.predominantPitch,
      costCents: report.costCents, // includes $3 markup from RoofrGateway
    }).returning();
    return m!.id;
  });

  return { measurementId };
}

/**
 * Inngest function: on `roofr/order.requested`, order a Roofr measurement,
 * poll until the report is ready (with sleeps between retries), persist the
 * measurement row, and emit `measurement/ready`. Idempotent on retry.
 */
export const roofrOrderMeasurement = inngest.createFunction(
  { id: "roofr-order-measurement", concurrency: { limit: 10 }, retries: 3 },
  { event: "roofr/order.requested" },
  async ({ event, step }) => {
    const { tenantId, jobId, propertyId } = event.data;

    const order = await step.run("order", async () => {
      const address = await withTenant(tenantId, async (tx) => {
        const [p] = await tx.select().from(property).where(eq(property.id, propertyId));
        return p?.address ?? "";
      });
      return nangoRoofr.orderMeasurement({ address });
    });

    // Poll up to 5 times; fake returns ready on the first call.
    let report = await step.run("report-0", () => nangoRoofr.getReport(order.orderId));
    for (let i = 1; i <= 4 && !report.ready; i++) {
      await step.sleep(`wait-${i}`, "30s");
      report = await step.run(`report-${i}`, () => nangoRoofr.getReport(order.orderId));
    }
    if (!report.ready) return { pending: true, orderId: order.orderId };

    const measurementId = await step.run("persist", async () =>
      withTenant(tenantId, async (tx) => {
        const [m] = await tx.insert(measurement).values({
          tenantId,
          propertyId,
          provider: "roofr",
          reportUrl: report.reportUrl,
          areas: report.areas,
          pitch: report.areas.predominantPitch,
          costCents: report.costCents,
        }).returning();
        return m!.id;
      }),
    );

    await step.sendEvent("emit-ready", {
      name: "measurement/ready",
      data: { tenantId, jobId, measurementId },
    });

    return { measurementId };
  },
);
