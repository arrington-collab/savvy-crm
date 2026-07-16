import { adminDb, tenant, recomputePartnerGrades, hasUngradedPartners } from "@savvy/db";
import { tenantsDueAtHour, dayOfMonthInTimeZone } from "@savvy/core";
import { inngest } from "../client";

const RECOMPUTE_HOUR = 10; // 10:00 tenant-local, same slot as the other sweeps

/**
 * Partner Ledger slice 3: the monthly grade stamp (partner.grades_current
 * evidence). Ticks hourly; a tenant runs at 10am local on the FIRST of its
 * month — plus a daily catch-up when a partner was created since the last
 * pass (so new partners never sit ungraded for weeks). Grades produce cards,
 * never cutoffs.
 */
export const partnerGradeRecompute = inngest.createFunction(
  { id: "partner-grade-recompute" },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const due = await step.run("due-tenants", async () => {
      const tenants = await adminDb.select({ id: tenant.id, timezone: tenant.timezone }).from(tenant);
      const now = new Date();
      const atHour = tenantsDueAtHour(tenants, now, RECOMPUTE_HOUR);
      const out: string[] = [];
      for (const t of atHour) {
        if (dayOfMonthInTimeZone(now, t.timezone) === 1 || (await hasUngradedPartners(t.id))) out.push(t.id);
      }
      return out;
    });
    let graded = 0;
    for (const id of due) {
      const r = await step.run(`recompute:${id}`, () => recomputePartnerGrades(id, new Date()));
      graded += r.graded;
    }
    return { tenants: due.length, graded };
  },
);
