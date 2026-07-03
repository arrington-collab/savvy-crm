import "server-only";
import { withTenant, job, invoice, appointment, jobChecklistItem, customer, tenant, materialOrder, property, document, eq, or, and, inArray, sql } from "@savvy/db";
import { parseJobsConfig, parseProductionConfig, missingRequiredPhotos, computeJobMargin, deriveJobHealth, buildExceptionQueue, type JobStage, type JobType, type ExceptionQueue, type MaterialDeliveryInput, type TaskNeedsApprovalInput, type WeatherAtRiskInput, type RoofTypeNeededInput, type MarginOutlierInput, type PhotoIncompleteInput } from "@savvy/core";
import { getTenantId } from "./tenant";

const OPEN_STAGES: JobStage[] = ["inspected", "estimate", "approved", "production", "closeout", "billing"];

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
        valueEstimate: job.valueEstimate, valueFinal: job.valueFinal, costCents: job.costCents,
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
      .select({ id: jobChecklistItem.id, jobId: jobChecklistItem.jobId, title: jobChecklistItem.title, dueAt: jobChecklistItem.dueAt, customerName: customer.name })
      .from(jobChecklistItem)
      .leftJoin(job, eq(job.id, jobChecklistItem.jobId))
      .leftJoin(customer, eq(customer.id, job.customerId))
      .where(sql`${jobChecklistItem.dueAt} is not null and ${jobChecklistItem.dueAt} < now() and ${jobChecklistItem.status} not in ('done','skipped')`);
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

    // --- tasks an agent deferred to a human (deferred_at set, not yet resolved) ---
    const deferredRows = await tx
      .select({ taskId: jobChecklistItem.id, jobId: jobChecklistItem.jobId, title: jobChecklistItem.title, deferredAt: jobChecklistItem.deferredAt, customerName: customer.name })
      .from(jobChecklistItem)
      .leftJoin(job, eq(job.id, jobChecklistItem.jobId))
      .leftJoin(customer, eq(customer.id, job.customerId))
      .where(sql`${jobChecklistItem.deferredAt} is not null and ${jobChecklistItem.status} not in ('done','skipped')`);
    const taskNeedsApprovals: TaskNeedsApprovalInput[] = deferredRows.map((r) => ({
      taskId: r.taskId, jobId: r.jobId, title: r.title, customerName: r.customerName, deferredAt: r.deferredAt as Date,
    }));

    // --- crew appointments flagged for bad weather (proactive, future) ---
    const wxRows = await tx
      .select({ id: appointment.id, jobId: appointment.jobId, apptType: appointment.type, startsAt: appointment.startsAt, note: appointment.weatherNote, customerName: customer.name })
      .from(appointment)
      .leftJoin(customer, eq(customer.id, appointment.customerId))
      .where(sql`${appointment.weatherFlaggedAt} is not null and ${appointment.status} = 'scheduled' and ${appointment.startsAt} > now()`);
    const weatherAtRisks: WeatherAtRiskInput[] = wxRows.map((r) => ({
      appointmentId: r.id, jobId: r.jobId, apptType: r.apptType, startsAt: r.startsAt, customerName: r.customerName, note: r.note ?? "Weather risk",
    }));

    // --- roof type unknown on an active, post-inspection job (someone's engaged
    // the property, so we should have it — pressure a human to capture it) ---
    const roofRows = await tx
      .select({ jobId: job.id, leadId: job.leadId, propertyId: job.propertyId, customerName: customer.name, stageEnteredAt: job.stageEnteredAt })
      .from(job)
      .leftJoin(property, eq(property.id, job.propertyId))
      .leftJoin(customer, eq(customer.id, job.customerId))
      .where(sql`${property.roofType} is null and ${job.stage} in ('inspected','estimate','approved','production','closeout','billing')`);
    const roofTypeNeeded: RoofTypeNeededInput[] = roofRows.map((r) => ({
      jobId: r.jobId, leadId: r.leadId, propertyId: r.propertyId, customerName: r.customerName, occurredAt: r.stageEnteredAt,
    }));

    // --- margin outliers: open jobs whose real-time margin is at/below target (cost known) ---
    const marginTargetPct = config.marginTargetPct;
    const marginOutliers: MarginOutlierInput[] = jobRows
      .filter((r) => OPEN_STAGES.includes(r.stage as JobStage) && r.costCents != null && r.costCents > 0)
      .map((r) => {
        const m = computeJobMargin({ revenueCents: r.valueFinal ?? r.valueEstimate ?? 0, costCents: r.costCents });
        return { jobId: r.id, customerName: r.customerName, marginPct: m.marginPct, costKnown: m.costKnown };
      })
      .filter((r) => r.costKnown && r.marginPct != null && r.marginPct <= marginTargetPct)
      .map((r) => ({ jobId: r.jobId, customerName: r.customerName, marginPct: r.marginPct as number, occurredAt: null }));

    // --- photo checklist incomplete: production/closeout jobs missing required photos ---
    const prodCfg = parseProductionConfig((t?.settings as { production?: unknown } | undefined)?.production);
    const photoJobs = jobRows.filter((r) => r.stage === "production" || r.stage === "closeout");
    let photoIncomplete: PhotoIncompleteInput[] = [];
    if (photoJobs.length > 0) {
      const photoRows = await tx
        .select({ jobId: document.jobId, label: document.label })
        .from(document)
        .where(and(inArray(document.jobId, photoJobs.map((r) => r.id)), eq(document.kind, "photo")));
      const labelsByJob = new Map<string, Set<string>>();
      for (const row of photoRows) {
        if (!row.jobId || !row.label) continue;
        (labelsByJob.get(row.jobId) ?? labelsByJob.set(row.jobId, new Set()).get(row.jobId)!).add(row.label);
      }
      photoIncomplete = photoJobs
        .map((r) => {
          const required = prodCfg.requiredPhotos[r.type as JobType] ?? [];
          const present = [...(labelsByJob.get(r.id) ?? [])];
          return { jobId: r.id, customerName: r.customerName, missing: missingRequiredPhotos(required, present), occurredAt: new Date(r.stageEnteredAt as unknown as string) };
        })
        .filter((r) => r.missing.length > 0);
    }

    return buildExceptionQueue({ atRiskJobs, overdueInvoices, missedAppointments, overdueTasks, materialDeliveries, taskNeedsApprovals, weatherAtRisks, roofTypeNeeded, marginOutliers, photoIncomplete });
  });
}
