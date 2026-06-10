import {
  withTenant, appointment, job, property, customer, user, eq, and, desc,
} from "@savvy/db";
import { getTenantId } from "./tenant";

export async function listAppointments(filter?: { assigneeUserId?: string; type?: string }) {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) => {
    const wheres = [
      eq(appointment.tenantId, tenantId),
      ...(filter?.assigneeUserId ? [eq(appointment.assigneeUserId, filter.assigneeUserId)] : []),
    ];
    return tx.select({
      id: appointment.id,
      type: appointment.type,
      status: appointment.status,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      assigneeUserId: appointment.assigneeUserId,
      customerName: customer.name,
      address: property.address,
    })
      .from(appointment)
      .leftJoin(customer, eq(appointment.customerId, customer.id))
      .leftJoin(job, eq(appointment.jobId, job.id))
      .leftJoin(property, eq(job.propertyId, property.id))
      .where(and(...wheres))
      .orderBy(desc(appointment.startsAt));
  });
}

export async function listUsers() {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx.select({ id: user.id, name: user.name }).from(user),
  );
}
