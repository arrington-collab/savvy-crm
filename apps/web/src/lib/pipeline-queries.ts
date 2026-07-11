import { withTenant, job, jobStageEvent, jobTask, taskRegistry, tenantTaskConfig, customer, property, invoice, tenant, gatherStageEvidence, eq, and, asc, desc, sql } from "@savvy/db";
import { JOB_STAGE, parseJobsConfig, deriveJobHealth, sumCardValues, weightedPipeline, wowPct, pipelineGrossAsOf, parsePipelineConfig, computeVelocity, jobStageToColumn, deriveWaitingOn, missingEvidenceFor, firstUnblockedIncomplete, effectiveMode, isManual, heartbeatState, SHOWCASE, PIPELINE_COLUMNS, type PipelineColumn, type WaitingOnTask, type JobHealth, type JobStage, type JobType, type HeartbeatState } from "@savvy/core";
import { getTenantId } from "./tenant";
import { getLeads } from "./leads-queries";
import { resolveAgentForStage, agentLabel, resolveTaskOwner } from "./agents";
import { lastTouchForJobs, lastTouchForLeads } from "./heartbeat-queries";

export type BoardCard = {
  id: string; stage: string; customerName: string; address: string;
  valueEstimate: number | null; stageEnteredAt: string;
  // Real owning agent = the most recent agent_run on this job (null if none yet).
  agent: string | null; taskKey: string | null;
  type: string; health: JobHealth; heartbeat: HeartbeatState;
};

export async function getBoard(): Promise<Record<string, BoardCard[]>> {
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({
      id: job.id, stage: job.stage, valueEstimate: job.valueEstimate,
      stageEnteredAt: job.stageEnteredAt, type: job.type, createdAt: job.createdAt,
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
  const touch = await lastTouchForJobs(rows.map((r) => r.id));

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
      heartbeat: heartbeatState(touch.get(r.id) ?? null, new Date(r.createdAt as unknown as string), now, SHOWCASE.COLD_DAYS),
    });
  }
  return byStage;
}

export type PipelineBoardCard = {
  id: string; kind: "job" | "lead"; column: PipelineColumn;
  name: string; address: string; valueCents: number | null;
  isClaim: boolean; isStuck: boolean;
  waitingLabel: string; waitingOwner: string; waitingIsHuman: boolean;
  href: string; heartbeat: HeartbeatState;
};
export type PipelineBoardData = {
  columns: Record<PipelineColumn, PipelineBoardCard[]>;
  velocityDays: Record<string, number>;
};

// Pre-job leads that still belong on the board (won → became a job; lost → hidden).
const LEAD_WAITING: Record<string, string> = {
  new: "qualify & score", contacted: "awaiting reply", qualified: "book inspection", booked: "inspection booked",
};

/**
 * The merged Pipeline board — jobs (by stage) + open leads folded onto 7 columns
 * (lead→paid), each card carrying its waiting-on line. Read-mostly: the board is
 * an overview; actions happen from Today. Reuses getBoard()/getStageVelocity()
 * and the tested pure mapping/derivation in @savvy/core.
 */
export async function getPipelineBoard(): Promise<PipelineBoardData> {
  const tenantId = await getTenantId();
  const [board, velocityDays, ledgerRows, leads] = await Promise.all([
    getBoard(),
    getStageVelocity(),
    // Every job_task for the tenant, joined to the registry (name/phase/mode) and
    // the tenant's mode override, ordered by execution order (phase, then task id)
    // — a single batched query, not one per job.
    withTenant(tenantId, (tx) =>
      tx
        .select({
          jobId: jobTask.jobId,
          taskId: jobTask.taskId,
          phase: taskRegistry.phase,
          status: jobTask.status,
          blockedBy: jobTask.blockedBy,
          title: taskRegistry.name,
          owner: jobTask.owner,
          defaultOwner: taskRegistry.defaultOwner,
          defaultMode: taskRegistry.defaultMode,
          overrideMode: tenantTaskConfig.mode,
        })
        .from(jobTask)
        .innerJoin(taskRegistry, eq(taskRegistry.id, jobTask.taskId))
        .leftJoin(tenantTaskConfig, and(eq(tenantTaskConfig.tenantId, tenantId), eq(tenantTaskConfig.taskId, jobTask.taskId)))
        .where(eq(jobTask.tenantId, tenantId))
        .orderBy(asc(taskRegistry.phase), asc(taskRegistry.id)),
    ),
    getLeads(),
  ]);

  const now = new Date();
  const leadTouch = await lastTouchForLeads(leads.map((l) => l.id));

  // Group in memory (still phase/taskId-ordered within each group, since the
  // query's global order is preserved under per-jobId filtering) and pick the
  // first unblocked incomplete task per job.
  const ledgerByJob = new Map<string, typeof ledgerRows>();
  for (const r of ledgerRows) {
    const arr = ledgerByJob.get(r.jobId);
    if (arr) arr.push(r);
    else ledgerByJob.set(r.jobId, [r]);
  }
  const nextByJob = new Map<string, WaitingOnTask>();
  for (const [jobId, rows] of ledgerByJob) {
    const winner = firstUnblockedIncomplete(rows);
    if (!winner) continue;
    nextByJob.set(jobId, {
      title: winner.title,
      ownerAgent: winner.owner ?? winner.defaultOwner,
      isHuman: isManual(effectiveMode(winner.defaultMode, winner.overrideMode ?? null)),
    });
  }

  // Missing-evidence label for the NEXT stage after each job's current one — only
  // computed for jobs with no pending task (deriveWaitingOn prefers the task).
  // Board is tenant-bounded, so a per-job gather is acceptable here.
  const missingByJob = new Map<string, string | null>();
  await Promise.all(
    Object.values(board).flat().map(async (c) => {
      if (nextByJob.has(c.id)) return; // a pending task wins; skip the evidence lookup
      const nextStage = JOB_STAGE[JOB_STAGE.indexOf(c.stage as JobStage) + 1] ?? (c.stage as JobStage);
      const ev = await withTenant(tenantId, (tx) => gatherStageEvidence(tx, { tenantId, jobId: c.id }));
      missingByJob.set(c.id, missingEvidenceFor(nextStage, ev));
    }),
  );

  const columns = Object.fromEntries(PIPELINE_COLUMNS.map((c) => [c, [] as PipelineBoardCard[]])) as Record<PipelineColumn, PipelineBoardCard[]>;

  // Jobs
  for (const [stage, cards] of Object.entries(board)) {
    const column = jobStageToColumn(stage as JobStage);
    if (!column) continue; // lost — hidden
    for (const c of cards) {
      const nextTask = nextByJob.get(c.id) ?? null;
      const w = deriveWaitingOn({ nextTask, column, missingEvidence: missingByJob.get(c.id) ?? null });
      const owner = w.isHuman
        ? "You"
        : w.ownerAgent
          ? resolveTaskOwner(w.ownerAgent).label
          : agentLabel(resolveAgentForStage(c.stage));
      columns[column].push({
        id: c.id, kind: "job", column,
        name: c.customerName, address: c.address, valueCents: c.valueEstimate,
        isClaim: c.type === "insurance", isStuck: c.health.stuck || c.health.late,
        waitingLabel: w.label, waitingOwner: owner, waitingIsHuman: w.isHuman,
        href: `/jobs/${c.id}`, heartbeat: c.heartbeat,
      });
    }
  }

  // Open leads (pre-job) land in the lead column.
  for (const l of leads) {
    if (!(l.status in LEAD_WAITING)) continue; // won/lost excluded
    columns.lead.push({
      id: l.id, kind: "lead", column: "lead",
      name: l.customerName ?? "—", address: l.address ?? "—", valueCents: null,
      isClaim: false, isStuck: false,
      waitingLabel: LEAD_WAITING[l.status], waitingOwner: "agents", waitingIsHuman: false,
      href: `/leads/${l.id}`,
      heartbeat: heartbeatState(leadTouch.get(l.id) ?? null, new Date(l.createdAt), now, SHOWCASE.COLD_DAYS),
    });
  }

  // Stuck cards first within each column, then by value desc.
  for (const col of PIPELINE_COLUMNS) {
    columns[col].sort((a, b) => Number(b.isStuck) - Number(a.isStuck) || (b.valueCents ?? 0) - (a.valueCents ?? 0));
  }
  return { columns, velocityDays };
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
