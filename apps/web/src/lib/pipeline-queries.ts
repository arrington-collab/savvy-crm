import { withTenant, job, jobStageEvent, customer, property, invoice, tenant, eq, and, desc, sql } from "@savvy/db";
import { JOB_STAGE, parseJobsConfig, deriveJobHealth, sumCardValues, weightedPipeline, wowPct, pipelineGrossAsOf, parsePipelineConfig, computeVelocity, type JobHealth, type JobStage, type JobType } from "@savvy/core";
import { getTenantId } from "./tenant";

export type BoardCard = {
  id: string; stage: string; customerName: string; address: string;
  valueEstimate: number | null; stageEnteredAt: string;
  // Real owning agent = the most recent agent_run on this job (null if none yet).
  agent: string | null; taskKey: string | null;
  type: string; health: JobHealth;
};

export async function getBoard(): Promise<Record<string, BoardCard[]>> {
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({
      id: job.id, stage: job.stage, valueEstimate: job.valueEstimate,
      stageEnteredAt: job.stageEnteredAt, type: job.type,
      customerName: customer.name, address: property.address,
      agent: sql<string | null>`(select agent from agent_run where job_id = ${job.id} order by started_at desc limit 1)`,
      taskKey: sql<string | null>`(select task_key from agent_run where job_id = ${job.id} order by started_at desc limit 1)`,
      approvedAt: sql<string | null>`(select entered_at from job_stage_event where job_id = ${job.id} and to_stage = 'approved' order by entered_at asc limit 1)`,
      pastDue: sql<boolean>`exists (select 1 from invoice where job_id = ${job.id} and status in ('sent','overdue') and due_at is not null and due_at < now() and coalesce(amount_paid,0) < coalesce(amount_due,0))`,
    }).from(job)
      .leftJoin(customer, eq(customer.id, job.customerId))
      .leftJoin(property, eq(property.id, job.propertyId))
      .orderBy(desc(job.stageEnteredAt)),
  );

  const [t] = await withTenant(tenantId, (tx) =>
    tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId)),
  );
  const config = parseJobsConfig((t?.settings as { jobs?: unknown } | undefined)?.jobs);
  const now = new Date();

  const byStage: Record<string, BoardCard[]> = Object.fromEntries(JOB_STAGE.map((s) => [s, []]));
  for (const r of rows) {
    const health = deriveJobHealth(
      {
        stage: r.stage as JobStage,
        stageEnteredAt: new Date(r.stageEnteredAt as unknown as string),
        type: r.type as JobType,
        approvedAt: r.approvedAt ? new Date(r.approvedAt) : null,
        hasPastDueInvoice: !!r.pastDue,
      },
      config,
      now,
    );
    (byStage[r.stage] ??= []).push({
      id: r.id, stage: r.stage, customerName: r.customerName ?? "—", address: r.address ?? "—",
      valueEstimate: r.valueEstimate, stageEnteredAt: (r.stageEnteredAt as Date).toISOString(),
      agent: r.agent ?? null, taskKey: r.taskKey ?? null,
      type: r.type, health,
    });
  }
  return byStage;
}

/** Jobs with a DRAFT (unsent) invoice — feeds the Jobs "Sage suggestions" rail. */
export async function getDraftInvoicesByJob(): Promise<{ jobId: string; customerName: string }[]> {
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({ jobId: invoice.jobId, customerName: customer.name })
      .from(invoice)
      .leftJoin(customer, eq(customer.id, invoice.customerId))
      .where(and(eq(invoice.tenantId, tenantId), eq(invoice.status, "draft"))),
  );
  return rows.filter((r): r is { jobId: string; customerName: string } => r.jobId != null)
    .map((r) => ({ jobId: r.jobId, customerName: r.customerName ?? "a customer" }));
}

export async function getStageVelocity(): Promise<Record<string, number>> {
  const tenantId = await getTenantId();
  const result = await withTenant(tenantId, (tx) =>
    tx.execute(sql`
      with ordered as (
        select job_id, to_stage, entered_at,
               lead(entered_at) over (partition by job_id order by entered_at) as next_at
        from job_stage_event
      )
      select to_stage as stage,
             avg(extract(epoch from (next_at - entered_at)) / 86400.0) as avg_days
      from ordered
      where next_at is not null
      group by to_stage
    `),
  );
  // node-postgres returns a QueryResult with `.rows`. Drizzle's tx.execute may
  // return that object OR the rows array depending on version — handle both.
  const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as
    { stage: string; avg_days: string | number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.stage] = Math.round(Number(r.avg_days) * 10) / 10;
  return out;
}

export type PipelineSummary = {
  stages: { stage: JobStage; grossCents: number; expectedCents: number; probability: number; grossLastWeekCents: number; wowPct: number | null }[];
  totals: { grossCents: number; expectedCents: number; grossLastWeekCents: number; wowPct: number | null; atRiskCents: number; avgCycleDays: number };
};

const OPEN_STAGES = JOB_STAGE.filter((s) => s !== "complete" && s !== "lost");

/** Weighted-pipeline rollup for the Command Center. Reuses getBoard for current
 *  gross + at-risk; reconstructs last-week gross from stage events. Read-only. */
export async function getPipelineSummary(): Promise<PipelineSummary> {
  const tenantId = await getTenantId();
  const board = await getBoard();

  const [t] = await withTenant(tenantId, (tx) =>
    tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId)),
  );
  const config = parsePipelineConfig((t?.settings as { pipeline?: unknown } | undefined)?.pipeline);

  const perStage = OPEN_STAGES.map((stage) => ({ stage, grossCents: sumCardValues(board[stage] ?? []) }));
  const weighted = weightedPipeline(perStage, config);
  const atRiskCents = sumCardValues(Object.values(board).flat().filter((c) => c.health.stuck || c.health.late));

  const { jobs, events } = await withTenant(tenantId, async (tx) => {
    const jobs = await tx.select({ id: job.id, valueEstimate: job.valueEstimate, openedAt: job.openedAt }).from(job).where(eq(job.tenantId, tenantId));
    const events = await tx
      .select({ jobId: jobStageEvent.jobId, toStage: jobStageEvent.toStage, enteredAt: jobStageEvent.enteredAt })
      .from(jobStageEvent)
      .where(eq(jobStageEvent.tenantId, tenantId));
    return { jobs, events };
  });

  const avgCycleDays = Math.round(computeVelocity(events.map((e) => ({ jobId: e.jobId, toStage: e.toStage as string, enteredAt: e.enteredAt }))).cycleTimeDays);

  const now = new Date();
  const lastWeek = pipelineGrossAsOf(
    jobs.map((j) => ({ id: j.id, valueEstimate: j.valueEstimate, openedAt: j.openedAt })),
    events.map((e) => ({ jobId: e.jobId, toStage: e.toStage as JobStage, enteredAt: e.enteredAt })),
    new Date(now.getTime() - 7 * 86_400_000),
  );

  const stages = weighted.stages.map((s) => {
    const grossLastWeekCents = lastWeek[s.stage] ?? 0;
    return { ...s, grossLastWeekCents, wowPct: wowPct(s.grossCents, grossLastWeekCents) };
  });
  const grossLastWeekCents = OPEN_STAGES.reduce((a, st) => a + (lastWeek[st] ?? 0), 0);

  return {
    stages,
    totals: {
      grossCents: weighted.grossCents,
      expectedCents: weighted.expectedCents,
      grossLastWeekCents,
      wowPct: wowPct(weighted.grossCents, grossLastWeekCents),
      atRiskCents,
      avgCycleDays,
    },
  };
}
