// Production Pulse slice 2: the crew end-of-day report — REQUIRED to close the
// crew day (a checked-in day with no report by cutoff is an office exception,
// not silence; slice 3's detector reads eodGaps). Sources the homeowner
// evening wrap: "here's where we left it — tomorrow: ridge caps and cleanup."

import { and, eq, gte, lt, sql } from "drizzle-orm";
import { withTenant } from "../tenant";
import { tenant, crewEodReport, crewCheckin } from "../schema/index";

function dayKeyInTz(now: Date, tz: string): string {
  return now.toLocaleDateString("en-CA", { timeZone: tz }); // yyyy-mm-dd
}

export type SubmitEodResult = { reportId: string; dayKey: string; created: boolean };

/** Upsert per (job, tenant-local day): the crew corrects, never duplicates. */
export async function submitCrewEodReport(input: {
  tenantId: string;
  jobId: string;
  whatGotDone: string;
  crewId?: string | null;
  blockers?: unknown[];
  tomorrowPlan?: string | null;
  source?: "form" | "voice";
  reportedByName?: string | null;
  now?: Date;
}): Promise<SubmitEodResult> {
  return withTenant(input.tenantId, async (tx) => {
    const [t] = await tx.select({ timezone: tenant.timezone }).from(tenant).where(eq(tenant.id, input.tenantId));
    const dayKey = dayKeyInTz(input.now ?? new Date(), t?.timezone ?? "America/Phoenix");

    const [existing] = await tx.select({ id: crewEodReport.id }).from(crewEodReport)
      .where(and(eq(crewEodReport.jobId, input.jobId), eq(crewEodReport.dayKey, dayKey)));
    if (existing) {
      await tx.update(crewEodReport).set({
        whatGotDone: input.whatGotDone,
        blockers: input.blockers ?? [],
        tomorrowPlan: input.tomorrowPlan ?? null,
        source: input.source ?? "form",
        reportedByName: input.reportedByName ?? null,
        crewId: input.crewId ?? null,
      }).where(eq(crewEodReport.id, existing.id));
      return { reportId: existing.id, dayKey, created: false };
    }

    const [row] = await tx.insert(crewEodReport).values({
      tenantId: input.tenantId,
      jobId: input.jobId,
      crewId: input.crewId ?? null,
      dayKey,
      whatGotDone: input.whatGotDone,
      blockers: input.blockers ?? [],
      tomorrowPlan: input.tomorrowPlan ?? null,
      source: input.source ?? "form",
      reportedByName: input.reportedByName ?? null,
    }).onConflictDoNothing().returning({ id: crewEodReport.id });
    if (row) return { reportId: row.id, dayKey, created: true };

    // Lost a race — the winner's row exists.
    const [winner] = await tx.select({ id: crewEodReport.id }).from(crewEodReport)
      .where(and(eq(crewEodReport.jobId, input.jobId), eq(crewEodReport.dayKey, dayKey)));
    return { reportId: winner!.id, dayKey, created: false };
  });
}

/** production.eod evidence + slice 3 detector: jobs whose crews checked in on
 *  the given tenant-local day but filed no EOD report. Must be empty by cutoff. */
export async function eodGaps(tenantId: string, dayKey: string): Promise<{ jobId: string }[]> {
  return withTenant(tenantId, async (tx) => {
    const dayStart = new Date(`${dayKey}T00:00:00Z`);
    const dayEnd = new Date(dayStart.getTime() + 36 * 3600_000); // generous window across tz offsets
    const rows = await tx.selectDistinct({ jobId: crewCheckin.jobId }).from(crewCheckin)
      .where(and(
        gte(crewCheckin.checkedInAt, new Date(dayStart.getTime() - 12 * 3600_000)),
        lt(crewCheckin.checkedInAt, dayEnd),
        sql`not exists (
          select 1 from ${crewEodReport} r
          where r.job_id = ${crewCheckin.jobId} and r.day_key = ${dayKey}
        )`,
      ));
    return rows;
  });
}
