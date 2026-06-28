import "server-only";
import { withTenant, job, invoice, appointment, jobTask, customer, tenant, materialOrder, eq, or, sql } from "@savvy/db";
import { parseJobsConfig, deriveJobHealth, buildExceptionQueue, type JobStage, type JobType, type ExceptionQueue, type MaterialDeliveryInput } from "@savvy/core";
import { getTenantId } from "./tenant";

// Gathers the five exception vectors for the tenant and normalizes them in core
// (jobs at risk, overdue invoices, missed appointments, overdue tasks, material
// delivery). NOTE (intentional): the same job can surface under more than one
// vector — e.g. a past-due invoice as BOTH a `job_at_risk` row (its job is `late`)
// and an `invoice_overdue` row, or a misaligned `material_delivery` alongside
// `job_at_risk` — distinct resolution paths (work the job vs. chase the invoice). The `invoice_overdue` branch trusts the
// `overdue` status as authoritative, so it is deliberately broader than
// getBoard's `pastDue` subquery (which also requires due_at<now + a balance).
// TODO(scale): no LIMIT yet — same all-rows-then-filter pattern as getBoard;
// cap/paginate before onboarding a large tenant.
export async function getExceptionQueue(): Promise<ExceptionQueue> {
  const tenantId = await getTenantId();
  return withTenant(tenantId, async (tx) => {
    // --- jobs (mirror getBoard's health inputs) ---
    const jobRows = await tx
      .select({
        id: job.id, stage: job.stage, type: job.type, stageEnteredAt: job.stageEnteredAt,
        customerName: customer.name,
        approvedAt: sql<string | null>`(select entered_at from job_stage_event where job_id = ${job.id} and to_stage = 'approved' order by entered_at asc limit 1)`,
        pastDue: sql<boolean>`exists (select 1 from invoice where job_id = ${job.id} and status in ('sent','overdue') and due_at is not null and due_at < now() and coalesce(amount_paid,0) < coalesce(amount_due,0))`,
      })
      .from(job)
      .leftJoin(customer, eq(customer.id, job.customerId));

    const [t] = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
    const config = parseJobsConfig((t?.settings as { jobs?: unknown } | undefined)?.jobs);
    const now = new Date();

    const atRiskJobs = jobRows
      .map((r) => {
        const health = deriveJobHealth(
          { stage: r.stage as JobStage, stageEnteredAt: new Date(r.stageEnteredAt as unknown as string), type: r.type as JobType, approvedAt: r.approvedAt ? new Date(r.approvedAt) : null, hasPastDueInvoice: !!r.pastDue },
          config, now,
        );
        return { jobId: r.id, customerName: r.customerName, stuck: health.stuck, late: health.late, reasons: health.reasons, stageEnteredAt: new Date(r.stageEnteredAt as unknown as string), health };
      })
      .filter((r) => r.health.stuck || r.health.late)
      .map(({ health: _h, ...rest }) => rest);

    // --- overdue invoices ---
    const invRows = await tx
      .select({ id: invoice.id, jobId: invoice.jobId, amountDue: invoice.amountDue, dueAt: invoice.dueAt, customerName: customer.name })
      .from(invoice)
      .leftJoin(customer, eq(customer.id, invoice.customerId))
      .where(or(
        eq(invoice.status, "overdue"),
        sql`${invoice.status} = 'sent' and ${invoice.dueAt} is not null and ${invoice.dueAt} < now() and coalesce(${invoice.amountPaid},0) < coalesce(${invoice.amountDue},0)`,
      ));
    const overdueInvoices = invRows.map((r) => ({ invoiceId: r.id, jobId: r.jobId, customerName: r.customerName, amountDueCents: r.amountDue, dueAt: r.dueAt }));

    // --- missed / overdue appointments ---
    const apptRows = await tx
      .select({ id: appointment.id, jobId: appointment.jobId, type: appointment.type, status: appointment.status, startsAt: appointment.startsAt, customerName: customer.name })
      .from(appointment)
      .leftJoin(customer, eq(customer.id, appointment.customerId))
      .where(or(
        eq(appointment.status, "no_show"),
        sql`${appointment.status} = 'scheduled' and ${appointment.startsAt} < now()`,
      ));
    const missedAppointments = apptRows.map((r) => ({ appointmentId: r.id, jobId: r.jobId, apptType: r.type, status: r.status, startsAt: r.startsAt, customerName: r.customerName }));

    // --- overdue tasks ---
    const taskRows = await tx
      .select({ id: jobTask.id, jobId: jobTask.jobId, title: jobTask.title, dueAt: jobTask.dueAt, customerName: customer.name })
      .from(jobTask)
      .leftJoin(job, eq(job.id, jobTask.jobId))
      .leftJoin(customer, eq(customer.id, job.customerId))
      .where(sql`${jobTask.dueAt} is not null and ${jobTask.dueAt} < now() and ${jobTask.status} not in ('done','skipped')`);
    const overdueTasks = taskRows.map((r) => ({ taskId: r.id, jobId: r.jobId, title: r.title, customerName: r.customerName, dueAt: r.dueAt }));

    // --- material-delivery risk (draft/ordered orders vs current crew-install date) ---
    const moRows = await tx
      .select({
        id: materialOrder.id,
        jobId: materialOrder.jobId,
        neededByAt: materialOrder.neededByAt,
        createdAt: materialOrder.createdAt,
        customerName: customer.name,
        installAt: sql<string | null>`(select min(starts_at) from appointment where job_id = ${materialOrder.jobId} and type = 'crew' and status = 'scheduled')`,
      })
      .from(materialOrder)
      .leftJoin(job, eq(job.id, materialOrder.jobId))
      .leftJoin(customer, eq(customer.id, job.customerId))
      .where(or(eq(materialOrder.status, "draft"), eq(materialOrder.status, "ordered")));
    const materialDeliveries: MaterialDeliveryInput[] = moRows.map((r) => ({
      materialOrderId: r.id,
      jobId: r.jobId,
      customerName: r.customerName,
      neededByAt: r.neededByAt,
      installAt: r.installAt ? new Date(r.installAt) : null,
      createdAt: r.createdAt,
    }));

    return buildExceptionQueue({ atRiskJobs, overdueInvoices, missedAppointments, overdueTasks, materialDeliveries });
  });
}
