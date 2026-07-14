// Production Pulse slice 2: the end-of-day homeowner wrap — one photo +
// tomorrow's plan, sourced from the crew's EOD report ("Crew's done for today —
// here's where we left it. Tomorrow: ridge caps and cleanup."). Once per
// job-day; quiet hours defer durably; suppressions log (production.ho_updates
// family). The EOD report itself is REQUIRED to close the crew day — the
// missing-by-cutoff exception is slice 3's detector on eodGaps.

import * as ai from "@savvy/ai";
import {
  adminDb, withTenant, eq, and, customer, job, tenant as tenantTbl, crewEodReport, productionUpdate, productionMedia, document,
  recordProductionUpdate, createStatusLink, isDemoTenant, withAgentRun, sql, desc,
} from "@savvy/db";
import { parseFinanceConfig, parseHomeownerConfig, isWithinQuietHours, nextAllowedSendTime, signPayloadToken } from "@savvy/core";
import { inngest } from "../client";
import { getTenantSms } from "../telephony";

export type EodWrapResult = { sent: true } | { sent: false; suppressed: string } | { deferUntil: Date };

export async function sendEodWrap(
  input: { tenantId: string; jobId: string; dayKey: string },
  deps: { getTenantSms: typeof getTenantSms; ai?: Pick<typeof ai, "complete">; now?: () => Date } = { getTenantSms },
): Promise<EodWrapResult> {
  const now = deps.now?.() ?? new Date();
  const aiClient = deps.ai ?? ai;
  const ledgerKey = input.dayKey; // one wrap per job-day rides phaseKey

  const [already] = await withTenant(input.tenantId, (tx) => tx.select({ id: productionUpdate.id }).from(productionUpdate)
    .where(and(eq(productionUpdate.jobId, input.jobId), eq(productionUpdate.kind, "eod_wrap"), eq(productionUpdate.phaseKey, ledgerKey))));
  if (already) return { sent: false, suppressed: "already_wrapped" };

  const suppress = async (reason: string): Promise<EodWrapResult> => {
    await recordProductionUpdate({ tenantId: input.tenantId, jobId: input.jobId, kind: "eod_wrap", phaseKey: ledgerKey, suppressedReason: reason });
    return { sent: false, suppressed: reason };
  };

  const [report] = await withTenant(input.tenantId, (tx) => tx.select().from(crewEodReport)
    .where(and(eq(crewEodReport.jobId, input.jobId), eq(crewEodReport.dayKey, input.dayKey))));
  if (!report) return { sent: false, suppressed: "no_report" };

  if (await isDemoTenant(input.tenantId)) return suppress("demo_mute");

  const cust = await withTenant(input.tenantId, async (tx) => {
    const [j] = await tx.select({ customerId: job.customerId }).from(job).where(eq(job.id, input.jobId));
    if (!j?.customerId) return null;
    const [c] = await tx.select({ name: customer.name, phone: customer.phone, smsOptOut: customer.smsOptOut, preferredLanguage: customer.preferredLanguage })
      .from(customer).where(eq(customer.id, j.customerId));
    return c ?? null;
  });
  if (!cust?.phone) return suppress("no_phone");
  if (cust.smsOptOut) return suppress("opt_out");

  const [t] = await adminDb.select({ settings: tenantTbl.settings }).from(tenantTbl).where(eq(tenantTbl.id, input.tenantId));
  const settings = t?.settings as { finance?: unknown; homeowner?: unknown } | null;
  const tz = parseFinanceConfig(settings?.finance).timezone;
  const qh = parseHomeownerConfig(settings?.homeowner).quietHours;
  if (isWithinQuietHours(now, tz, qh)) return { deferUntil: nextAllowedSendTime(now, tz, qh) };

  // Today's best double-gated photo (any phase) rides via the status story.
  const [photo] = await withTenant(input.tenantId, (tx) => tx.select({ documentId: productionMedia.documentId })
    .from(productionMedia)
    .innerJoin(document, eq(productionMedia.documentId, document.id))
    .where(and(
      eq(productionMedia.jobId, input.jobId),
      eq(document.qcStatus, "passed"),
      sql`${document.sharedWith} @> '["homeowner"]'::jsonb`,
    ))
    .orderBy(desc(productionMedia.createdAt))
    .limit(1));

  const language = cust.preferredLanguage === "es" ? "Write in Spanish." : "Write in English.";
  let draft: string;
  try {
    const { text } = await aiClient.complete({
      capability: "workhorse",
      system: `Write like a good foreman texting the homeowner at day's end: warm, concrete, zero jargon. Two short sentences: where the day ended, and tomorrow's plan. ${language}`,
      prompt: `What got done: ${report.whatGotDone}. Tomorrow: ${report.tomorrowPlan ?? "we'll confirm in the morning"}. First name: ${cust.name.split(/\s+/)[0]}.`,
    });
    draft = text.trim();
  } catch {
    draft = `Crew's done for today — here's where we left it. Tomorrow: ${report.tomorrowPlan ?? "we'll confirm the plan in the morning"}.`;
  }

  const token = signPayloadToken({ tenantId: input.tenantId, jobId: input.jobId }, process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret");
  const code = await createStatusLink({ tenantId: input.tenantId, token });
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const body = `${draft} ${base}/b/${code}`;

  return withAgentRun(
    { tenantId: input.tenantId, agent: "comms", taskKey: "production_pulse.eod_wrap", jobId: input.jobId, leadId: null },
    async () => {
      const { sender, from } = await deps.getTenantSms(input.tenantId);
      await sender.sendSms({ to: cust.phone!, from, body });
      await recordProductionUpdate({
        tenantId: input.tenantId, jobId: input.jobId, kind: "eod_wrap", phaseKey: ledgerKey,
        body, photoIds: photo ? [photo.documentId] : [], sentAt: new Date(),
      });
      return { sent: true as const };
    },
  );
}

export const productionEodWrap = inngest.createFunction(
  { id: "production-eod-wrap", retries: 2 },
  { event: "production/eod.reported" },
  async ({ event, step }) => {
    const { tenantId, jobId, dayKey } = event.data;
    let res = await step.run("wrap", () => sendEodWrap({ tenantId, jobId, dayKey }));
    if ("deferUntil" in res) {
      await step.sleepUntil("after-quiet-hours", new Date(res.deferUntil));
      res = await step.run("wrap-after-quiet", () => sendEodWrap({ tenantId, jobId, dayKey }));
    }
    return res;
  },
);
