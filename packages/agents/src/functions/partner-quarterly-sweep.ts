import { adminDb, tenant as tenantTbl, generateQuarterlyPartnerReports, duePartnerEmailTouches, markTouchSent, markTouchSuppressed } from "@savvy/db";
import { tenantsDueAtHour, parseFinanceConfig, parseHomeownerConfig, parseEmailConfig, isWithinQuietHours } from "@savvy/core";
import { inngest } from "../client";
import { getTenantEmail } from "../email";

const SWEEP_HOUR = 10; // 10:00 tenant-local, the shared service-touch slot

function reportEmailHtml(input: { partnerName: string; companyName: string; quarterKey: string; url: string }): string {
  return `
    <p>Hi ${input.partnerName.split(/\s+/)[0]},</p>
    <p>Thank you for the referrals last quarter — here's your ${input.quarterKey} summary from ${input.companyName}:</p>
    <p><a href="${input.url}">${input.url}</a></p>
    <p>We appreciate the trust. — ${input.companyName}</p>`;
}

/**
 * Partner Ledger slice 5: the quarterly report engine. Daily at 10am
 * tenant-local it (re)runs generation — idempotent, so day 1 of the quarter
 * does the real work and every later day is a catch-up for partners graded
 * A/B mid-quarter. Then it delivers due partner email touches through the
 * governor's ledger: demo tenants get the mock sender, quiet hours defer to
 * the next pass, and a partner with no email on file gets a LOGGED
 * suppression — partner.quarterly evidence accepts generated-or-suppressed,
 * never silence.
 */
export const partnerQuarterlySweep = inngest.createFunction(
  { id: "partner-quarterly-sweep" },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const due = await step.run("due-tenants", async () => {
      const tenants = await adminDb.select({ id: tenantTbl.id, name: tenantTbl.name, timezone: tenantTbl.timezone, settings: tenantTbl.settings }).from(tenantTbl);
      return tenantsDueAtHour(tenants, new Date(), SWEEP_HOUR).map((t) => ({ id: t.id, name: t.name, settings: t.settings }));
    });

    let generated = 0;
    let sent = 0;
    let suppressed = 0;
    for (const t of due) {
      const r = await step.run(`sweep:${t.id}`, async () => {
        const now = new Date();
        const gen = await generateQuarterlyPartnerReports(t.id, now);

        const settings = t.settings as { finance?: unknown; homeowner?: unknown; email?: unknown } | null;
        const tz = parseFinanceConfig(settings?.finance).timezone;
        const qh = parseHomeownerConfig(settings?.homeowner).quietHours;
        if (isWithinQuietHours(now, tz, qh)) return { generated: gen.generated, sent: 0, suppressed: 0 };

        const dueTouches = await duePartnerEmailTouches(t.id, now);
        let sentHere = 0;
        let suppressedHere = 0;
        for (const d of dueTouches) {
          if (!d.email) {
            await markTouchSuppressed({ tenantId: t.id, touchId: d.touchId, reason: "no_email" });
            suppressedHere++;
            continue;
          }
          if (!d.reportCode) continue; // stamps still settling — next pass
          try {
            const sender = await getTenantEmail(t.id, { gmailConnectionId: parseEmailConfig(settings?.email).gmailConnectionId ?? null });
            const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
            await sender.sendEmail({
              to: d.email,
              from: process.env.EMAIL_FROM ?? "noreply@example.com",
              subject: `Your ${d.quarterKey ?? "quarterly"} referral summary`,
              html: reportEmailHtml({ partnerName: d.partnerName, companyName: t.name, quarterKey: d.quarterKey ?? "", url: `${base}/partner-report/${d.reportCode}` }),
            });
            await markTouchSent({ tenantId: t.id, touchId: d.touchId });
            sentHere++;
          } catch {
            // fail-soft: stays unsent, retried next pass
          }
        }
        return { generated: gen.generated, sent: sentHere, suppressed: suppressedHere };
      });
      generated += r.generated;
      sent += r.sent;
      suppressed += r.suppressed;
    }
    return { tenants: due.length, generated, sent, suppressed };
  },
);
