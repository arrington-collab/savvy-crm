import { withTenant, job, customer, property, invoice, eq, and, desc, sql } from "@savvy/db";
import { JOB_STAGE } from "@savvy/core";
import { getTenantId } from "./tenant";

export type BoardCard = {
  id: string; stage: string; customerName: string; address: string;
  valueEstimate: number | null; stageEnteredAt: string;
  // Real owning agent = the most recent agent_run on this job (null if none yet).
  agent: string | null; taskKey: string | null;
};

export async function getBoard(): Promise<Record<string, BoardCard[]>> {
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({
      id: job.id, stage: job.stage, valueEstimate: job.valueEstimate,
      stageEnteredAt: job.stageEnteredAt, customerName: customer.name, address: property.address,
      agent: sql<string | null>`(select agent from agent_run where job_id = ${job.id} order by started_at desc limit 1)`,
      taskKey: sql<string | null>`(select task_key from agent_run where job_id = ${job.id} order by started_at desc limit 1)`,
    }).from(job)
      .leftJoin(customer, eq(customer.id, job.customerId))
      .leftJoin(property, eq(property.id, job.propertyId))
      .orderBy(desc(job.stageEnteredAt)),
  );
  const byStage: Record<string, BoardCard[]> = Object.fromEntries(JOB_STAGE.map((s) => [s, []]));
  for (const r of rows) {
    (byStage[r.stage] ??= []).push({
      id: r.id, stage: r.stage, customerName: r.customerName ?? "—", address: r.address ?? "—",
      valueEstimate: r.valueEstimate, stageEnteredAt: (r.stageEnteredAt as Date).toISOString(),
      agent: r.agent ?? null, taskKey: r.taskKey ?? null,
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
