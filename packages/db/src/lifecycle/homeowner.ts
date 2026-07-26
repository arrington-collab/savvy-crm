import { and, eq, gte, isNull, inArray, asc, sql } from "drizzle-orm";
import { jobStageEvent, job, customer, property, appointment, tenant } from "../schema/index";
import { withTenant } from "../tenant";
import type { JobStage } from "@savvy/core";

export type HomeownerStatus = {
  tenantId: string;
  jobId: string;
  companyName: string;
  customerName: string | null;
  address: string | null;
  currentStage: JobStage;
  events: { toStage: JobStage; enteredAt: Date }[];
  nextAppointment: { type: string; startsAt: Date } | null;
};

export async function getHomeownerStatus(tenantId: string, jobId: string): Promise<HomeownerStatus | null> {
  return withTenant(tenantId, async (tx) => {
    const [j] = await tx.select({ stage: job.stage, customerName: customer.name, address: property.address })
      .from(job)
      .leftJoin(customer, eq(customer.id, job.customerId))
      .leftJoin(property, eq(property.id, job.propertyId))
      .where(eq(job.id, jobId));
    if (!j) return null;
    const [t] = await tx.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, tenantId));
    const events = await tx.select({ toStage: jobStageEvent.toStage, enteredAt: jobStageEvent.enteredAt })
      .from(jobStageEvent).where(and(eq(jobStageEvent.tenantId, tenantId), eq(jobStageEvent.jobId, jobId))).orderBy(asc(jobStageEvent.enteredAt));
    const [next] = await tx.select({ type: appointment.type, startsAt: appointment.startsAt })
      .from(appointment)
      .where(and(eq(appointment.tenantId, tenantId), eq(appointment.jobId, jobId), eq(appointment.status, "scheduled"), gte(appointment.startsAt, new Date())))
      .orderBy(asc(appointment.startsAt)).limit(1);
    return {
      tenantId,
      jobId,
      companyName: t?.name ?? "Your contractor",
      customerName: j.customerName,
      address: j.address,
      currentStage: j.stage as JobStage,
      events: events.map((e) => ({ toStage: e.toStage as JobStage, enteredAt: e.enteredAt })),
      nextAppointment: next ? { type: next.type, startsAt: next.startsAt } : null,
    };
  });
}

export type NotifiableEvent = { eventId: string; jobId: string; toStage: JobStage; customerId: string | null; phone: string | null; email: string | null; smsOptOut: boolean; emailOptOut: boolean; smsConsentAt: Date | null };

export async function listStageEventsToNotify(
  tenantId: string, opts: { stages: JobStage[]; sinceMs: number; now: Date },
): Promise<NotifiableEvent[]> {
  if (opts.stages.length === 0) return [];
  const cutoff = new Date(opts.now.getTime() - opts.sinceMs);
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.select({
      eventId: jobStageEvent.id, jobId: jobStageEvent.jobId, toStage: jobStageEvent.toStage,
      customerId: customer.id, phone: customer.phone, email: customer.email,
      smsOptOut: customer.smsOptOut, emailOptOut: customer.emailOptOut, smsConsentAt: customer.smsConsentAt,
    })
      .from(jobStageEvent)
      .leftJoin(job, eq(job.id, jobStageEvent.jobId))
      .leftJoin(customer, eq(customer.id, job.customerId))
      .where(and(
        eq(jobStageEvent.tenantId, tenantId),
        inArray(jobStageEvent.toStage, opts.stages),
        isNull(jobStageEvent.homeownerNotifiedAt),
        gte(jobStageEvent.enteredAt, cutoff),
      ));
    return rows.map((r) => ({
      eventId: r.eventId, jobId: r.jobId, toStage: r.toStage as JobStage,
      customerId: r.customerId, phone: r.phone, email: r.email,
      smsOptOut: r.smsOptOut ?? false, emailOptOut: r.emailOptOut ?? false, smsConsentAt: r.smsConsentAt ?? null,
    }));
  });
}

export async function markStageEventNotified(tenantId: string, eventId: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.update(jobStageEvent).set({ homeownerNotifiedAt: sql`now()` }).where(eq(jobStageEvent.id, eventId)));
}
