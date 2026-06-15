import { withTenant, job, customer, property, eq, desc, sql } from "@savvy/db";
import { JOB_STAGE } from "@savvy/core";
import { getTenantId } from "./tenant";

export type BoardCard = {
  id: string; stage: string; customerName: string; address: string;
  valueEstimate: number | null; stageEnteredAt: string;
};

export async function getBoard(): Promise<Record<string, BoardCard[]>> {
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({
      id: job.id, stage: job.stage, valueEstimate: job.valueEstimate,
      stageEnteredAt: job.stageEnteredAt, customerName: customer.name, address: property.address,
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
    });
  }
  return byStage;
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
