// Production Pulse slice 2: the phase-completion homeowner update — the good
// kind of noise. AI-drafted (cheap capability, Library rubric: warm, concrete,
// zero jargon, zero hype), sent WITH photos that passed BOTH gates (QC +
// customer-safe). AUTO-SEND by design: the double gate is the approval; no
// per-message human sign-off. Quiet hours defer; the max-N/day throttle,
// opt-outs, and demo-mute suppress WITH a ledger row (production.ho_updates:
// every customer-visible completion produced an update or a logged reason).

import * as ai from "@savvy/ai";
import {
  adminDb, withTenant, eq, and, customer, job, tenant as tenantTbl, messageTemplate,
  productionPhase, productionUpdate,
  doubleGatedPhotosForPhase, recordProductionUpdate, countUpdatesSentToday,
  createStatusLink, isDemoTenant, withAgentRun,
} from "@savvy/db";
import { parseFinanceConfig, parseHomeownerConfig, isWithinQuietHours, nextAllowedSendTime, signPayloadToken } from "@savvy/core";
import { inngest } from "../client";
import { getTenantSms } from "../telephony";

export const HO_UPDATE_RUBRIC_KEY = "production-update-rubric";
export const HO_UPDATE_RUBRIC_V1 =
  "Write like a good foreman texting the homeowner: warm, concrete, zero jargon, " +
  "zero hype. One or two short sentences: what just finished and (when known) " +
  "what happens next. Never oversell, never alarm.";

const DEFAULT_MAX_UPDATES_PER_DAY = 3;

type FallbackCopy = (label: string) => string;
const FALLBACK: FallbackCopy = (label) => `${label} is done — your crew is moving right along. Photos on your status page.`;

export type SendPhaseUpdateResult =
  | { sent: true; photoCount: number }
  | { sent: false; suppressed: string }
  | { deferUntil: Date };

export async function sendPhaseCompleteUpdate(
  input: { tenantId: string; jobId: string; phaseKey: string },
  deps: { getTenantSms: typeof getTenantSms; ai?: Pick<typeof ai, "complete">; now?: () => Date } = { getTenantSms },
): Promise<SendPhaseUpdateResult> {
  const now = deps.now?.() ?? new Date();
  const aiClient = deps.ai ?? ai;

  // Once per phase, ever — send OR suppression.
  const [already] = await withTenant(input.tenantId, (tx) => tx.select({ id: productionUpdate.id })
    .from(productionUpdate)
    .where(and(eq(productionUpdate.jobId, input.jobId), eq(productionUpdate.kind, "phase_complete"), eq(productionUpdate.phaseKey, input.phaseKey))));
  if (already) return { sent: false, suppressed: "already_updated" };

  const suppress = async (reason: string): Promise<SendPhaseUpdateResult> => {
    await recordProductionUpdate({ tenantId: input.tenantId, jobId: input.jobId, kind: "phase_complete", phaseKey: input.phaseKey, suppressedReason: reason });
    return { sent: false, suppressed: reason };
  };

  const [phase] = await withTenant(input.tenantId, (tx) => tx.select().from(productionPhase)
    .where(and(eq(productionPhase.jobId, input.jobId), eq(productionPhase.phaseKey, input.phaseKey))));
  if (!phase || (phase.status !== "done" && phase.status !== "verified")) return { sent: false, suppressed: "phase_not_done" };
  if (!phase.customerVisible) return { sent: false, suppressed: "not_customer_visible" };

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
  const settings = t?.settings as { finance?: unknown; homeowner?: unknown; production?: { maxHomeownerUpdatesPerDay?: number } } | null;
  const tz = parseFinanceConfig(settings?.finance).timezone;
  const qh = parseHomeownerConfig(settings?.homeowner).quietHours;
  if (isWithinQuietHours(now, tz, qh)) return { deferUntil: nextAllowedSendTime(now, tz, qh) };

  const maxPerDay = settings?.production?.maxHomeownerUpdatesPerDay ?? DEFAULT_MAX_UPDATES_PER_DAY;
  if ((await countUpdatesSentToday({ tenantId: input.tenantId, jobId: input.jobId, now })) >= maxPerDay) {
    return suppress("throttle");
  }

  const photos = await doubleGatedPhotosForPhase({ tenantId: input.tenantId, jobId: input.jobId, phaseKey: input.phaseKey, limit: 3 });
  if (photos.length === 0) return suppress("no_safe_photos");

  // Library rubric first; language per the customer's preference.
  const [tpl] = await adminDb.select({ body: messageTemplate.body }).from(messageTemplate)
    .where(and(eq(messageTemplate.tenantId, input.tenantId), eq(messageTemplate.key, HO_UPDATE_RUBRIC_KEY)));
  const rubric = tpl?.body?.trim() || HO_UPDATE_RUBRIC_V1;
  const language = cust.preferredLanguage === "es" ? "Write in Spanish." : "Write in English.";

  let draft: string;
  try {
    const { text } = await aiClient.complete({
      capability: "workhorse",
      system: `${rubric}\n${language}`,
      prompt: `Phase just completed: ${phase.label}. Evidence photos: ${photos.length}. Homeowner first name: ${cust.name.split(/\s+/)[0]}.`,
    });
    draft = text.trim() || FALLBACK(phase.label);
  } catch {
    draft = FALLBACK(phase.label);
  }

  // The photos travel via the status page story (the link is the gallery).
  const token = signPayloadToken({ tenantId: input.tenantId, jobId: input.jobId }, process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret");
  const { code } = await createStatusLink({ tenantId: input.tenantId, token });
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const body = `${draft} ${base}/b/${code}`;

  return withAgentRun(
    { tenantId: input.tenantId, agent: "comms", taskKey: "production_pulse.ho_update", jobId: input.jobId, leadId: null },
    async () => {
      const { sender, from } = await deps.getTenantSms(input.tenantId);
      await sender.sendSms({ to: cust.phone!, from, body });
      await recordProductionUpdate({
        tenantId: input.tenantId, jobId: input.jobId, kind: "phase_complete", phaseKey: input.phaseKey,
        body, photoIds: photos.map((p) => p.documentId), sentAt: new Date(),
      });
      return { sent: true as const, photoCount: photos.length };
    },
  );
}

/** Rides the slice-1 event; quiet hours defer durably, everything else logs. */
export const productionHoUpdate = inngest.createFunction(
  { id: "production-ho-update", retries: 2 },
  { event: "production/media.ingested" },
  async ({ event, step }) => {
    const { tenantId, jobId, phaseKey, justCompleted } = event.data;
    if (!justCompleted) return { skipped: "not_a_completion" };
    let res = await step.run("send", () => sendPhaseCompleteUpdate({ tenantId, jobId, phaseKey }));
    if ("deferUntil" in res) {
      await step.sleepUntil("after-quiet-hours", new Date(res.deferUntil));
      res = await step.run("send-after-quiet", () => sendPhaseCompleteUpdate({ tenantId, jobId, phaseKey }));
    }
    return res;
  },
);
