import {
  withTenant, adminDb, tenant, appointment, job, property, customer, user, eq, and, desc, isNull,
} from "@savvy/db";
import { parseFinanceConfig } from "@savvy/core";
import { getTenantId } from "./tenant";

export type ScheduleFilter = { assigneeUserId?: string; type?: string; jobType?: string; city?: string };

export async function listAppointments(filter?: ScheduleFilter) {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) => {
    const wheres = [
      eq(appointment.tenantId, tenantId),
      ...(filter?.assigneeUserId ? [eq(appointment.assigneeUserId, filter.assigneeUserId)] : []),
      ...(filter?.type ? [eq(appointment.type, filter.type as "inspection" | "cm" | "crew")] : []),
      ...(filter?.jobType ? [eq(job.type, filter.jobType as "retail" | "insurance" | "repair" | "commercial")] : []),
      ...(filter?.city === "__unknown__" ? [isNull(property.city)] : filter?.city ? [eq(property.city, filter.city)] : []),
    ];
    return tx.select({
      id: appointment.id,
      type: appointment.type,
      status: appointment.status,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      assigneeUserId: appointment.assigneeUserId,
      assigneeName: user.name,
      customerName: customer.name,
      address: property.address,
      city: property.city,
      jobId: appointment.jobId,
      jobType: job.type,
    })
      .from(appointment)
      .leftJoin(customer, eq(appointment.customerId, customer.id))
      .leftJoin(job, eq(appointment.jobId, job.id))
      .leftJoin(property, eq(job.propertyId, property.id))
      .leftJoin(user, eq(appointment.assigneeUserId, user.id))
      .where(and(...wheres))
      .orderBy(desc(appointment.startsAt));
  });
}

export async function listUsers() {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx.select({ id: user.id, name: user.name }).from(user).where(isNull(user.deactivatedAt)),
  );
}

/** Distinct non-null cities for the filter dropdown, plus whether any property has a null city. */
export async function getScheduleCities(): Promise<{ cities: string[]; hasUnknown: boolean }> {
  const tenantId = await getTenantId();
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.selectDistinct({ city: property.city }).from(property).where(eq(property.tenantId, tenantId));
    const cities = rows.map((r) => r.city).filter((c): c is string => !!c).sort();
    return { cities, hasUnknown: rows.some((r) => !r.city) };
  });
}

/** Tenant scheduling timezone (finance.timezone; default America/Phoenix). tenant.settings has no RLS -> adminDb. */
export async function getTenantTimezone(): Promise<string> {
  const tenantId = await getTenantId();
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const settings = (t?.settings ?? {}) as { finance?: unknown };
  return parseFinanceConfig(settings.finance).timezone;
}
