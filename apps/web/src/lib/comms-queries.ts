import {
  withTenant, messageTemplate, drip, dripEnrollment, customer, eq, desc,
} from "@savvy/db";
import { getTenantId } from "./tenant";

export async function listTemplates() {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx.select().from(messageTemplate).orderBy(desc(messageTemplate.updatedAt)),
  );
}

export async function listDrips() {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) => tx.select().from(drip).orderBy(desc(drip.createdAt)));
}

export type EnrollmentRow = {
  id: string; status: string; stoppedReason: string | null; currentStep: number;
  customerName: string; dripName: string; enrolledAt: string;
};

export async function listEnrollments(): Promise<EnrollmentRow[]> {
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({
      id: dripEnrollment.id, status: dripEnrollment.status, stoppedReason: dripEnrollment.stoppedReason,
      currentStep: dripEnrollment.currentStep, enrolledAt: dripEnrollment.enrolledAt,
      customerName: customer.name, dripName: drip.name,
    })
      .from(dripEnrollment)
      .leftJoin(customer, eq(customer.id, dripEnrollment.customerId))
      .leftJoin(drip, eq(drip.id, dripEnrollment.dripId))
      .orderBy(desc(dripEnrollment.enrolledAt)),
  );
  return rows.map((r) => ({
    id: r.id, status: r.status, stoppedReason: r.stoppedReason, currentStep: r.currentStep,
    customerName: r.customerName ?? "—", dripName: r.dripName ?? "—",
    enrolledAt: (r.enrolledAt as Date).toISOString(),
  }));
}
