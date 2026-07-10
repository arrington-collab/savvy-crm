import { withTenant } from "../tenant";
import { lead } from "../schema/crm";
import { job } from "../schema/jobs";
import { invoice } from "../schema/finance";
import { eq, sql } from "drizzle-orm";

/** Counts leads grouped by their source (e.g. "web", "referral", "insurance_agent"). */
export async function leadSourceSummary(
  tenantId: string,
): Promise<{ source: string; leadCount: number }[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select({
        source: sql<string>`coalesce(${lead.source}, 'unknown')`,
        leadCount: sql<number>`count(*)::int`,
      })
      .from(lead)
      .groupBy(lead.source),
  );
}

/**
 * Groups revenue (paid invoice amounts) by the referring person's name for
 * leads sourced from a person-attributed channel (referral, insurance agent,
 * realtor, or partner). The person's name is pulled from `lead.source_detail`
 * (referrer_name, agent_name, or name — whichever is present).
 */
export async function referredRevenueByPerson(
  tenantId: string,
): Promise<{ name: string; source: string; jobCount: number; revenueCents: number }[]> {
  return withTenant(tenantId, async (tx) => {
    const nameExpr = sql<string>`coalesce(${lead.sourceDetail}->>'referrer_name', ${lead.sourceDetail}->>'agent_name', ${lead.sourceDetail}->>'name')`;
    return tx
      .select({
        name: nameExpr,
        source: sql<string>`${lead.source}`,
        jobCount: sql<number>`count(distinct ${job.id})::int`,
        revenueCents: sql<number>`coalesce(sum(${invoice.amountPaid}), 0)::int`,
      })
      .from(lead)
      .innerJoin(job, eq(job.leadId, lead.id))
      .leftJoin(invoice, eq(invoice.jobId, job.id))
      .where(
        sql`${lead.source} in ('referral', 'insurance_agent', 'realtor', 'partner') and ${nameExpr} is not null`,
      )
      .groupBy(nameExpr, lead.source);
  });
}
