import { renderTemplate, dripGateOpen, parseEstimateConfig, type DripStep, parseEmailConfig, REGISTRY_TASK } from "@savvy/core";
import * as ai from "@savvy/ai";
import {
  withTenant, eq, and, customer, communication, agentRun, dripEnrollment, drip, messageTemplate, tenant as tenantTbl,
  markLeadTaskDoneTx, estimate, desc, ensureEstimateLink, adminDb, recordEstimateEvent, isSuppressed,
} from "@savvy/db";
import type { SmsSender, EmailSender } from "@savvy/integrations";
import { getTenantSms, isOutboundThrottled, resolveA2pApproved } from "../telephony";
import { getTenantEmail } from "../email";
import { guardedSms, type GuardedSmsDeps } from "../comms-gateway";
import { inngest } from "../client";

export type DripContext = { name: string; firstName: string } & Record<string, string>;

export type DraftedMessage = { body: string; aiHandled: boolean; model?: string };

/**
 * Produces the message body for a drip step. Template step -> {{var}} render;
 * AI step -> capability-gateway draft. Pure: `aiClient` is injectable for tests.
 */
export async function draftMessage(
  input: { step: DripStep; templateBody?: string; ctx: DripContext },
  aiClient: Pick<typeof ai, "complete"> = ai,
): Promise<DraftedMessage> {
  const { step, templateBody, ctx } = input;
  if (step.aiPrompt) {
    const { text, model } = await aiClient.complete({
      capability: step.aiCapability ?? "workhorse",
      system: "You write short, friendly roofing-company follow-up messages. No placeholders.",
      prompt: `${step.aiPrompt}\n\nContact: ${ctx.name}. Keep it concise for ${step.channel}.`,
    });
    return { body: text, aiHandled: true, model };
  }
  // All ctx entries are template vars — estimate touches add {{estimateLink}},
  // {{validUntil}}, etc. beyond the base name/firstName pair.
  return { body: renderTemplate(templateBody ?? "", { ...ctx }), aiHandled: false };
}

export type SendDeps = {
  sms: SmsSender;
  from: string;
  email: EmailSender;
  ai?: Pick<typeof ai, "complete">;
  /** Injectable throttle check — defaults to the DB-backed isOutboundThrottled. */
  isThrottled?: (tenantId: string) => Promise<boolean>;
  /** Injectable global-suppression check — defaults to the DB-backed @savvy/db isSuppressed. */
  isSuppressed?: GuardedSmsDeps["isSuppressed"];
  /**
   * Resolved A2P-campaign approval for the active sender. Defaults to `true`
   * when omitted (tests / callers that don't route through getTenantSms).
   * Production (dripRun) resolves this via resolveA2pApproved(tenantId, from)
   * from the sender getTenantSms actually returned.
   */
  a2pApproved?: boolean;
};

function firstNameOf(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

/**
 * Renders + sends one drip step, then logs a communication and advances
 * current_step. On a real send attempt it also logs an agent_run (agent
 * "comms"). Suppresses the send — logging a "[suppressed: ...]" note and
 * advancing the step, but writing NO agent_run — when the contact is opted out
 * of the channel OR has no address for it. Senders are injected + fail-soft (a
 * missing-creds throw still logs the comm with a mock provider id). Tenant-scoped.
 */
export async function sendDripStep(
  input: {
    tenantId: string; enrollmentId: string; customerId: string;
    step: DripStep; templateBody?: string; jobId?: string; leadId?: string;
  },
  deps: SendDeps,
): Promise<{ sent: boolean }> {
  const { tenantId, enrollmentId, customerId, step, templateBody, jobId, leadId } = input;

  const c = await withTenant(tenantId, async (tx) => {
    const [row] = await tx.select().from(customer).where(eq(customer.id, customerId));
    return row!;
  });

  const to = step.channel === "sms" ? c.phone : c.email;
  const optedOut = step.channel === "sms" ? c.smsOptOut : c.emailOptOut;
  // Suppress when opted out OR no address for the channel: log a note + advance, no send.
  // Appended (data-broker) emails are transactional-only: never used for marketing
  // drip. Booking/reminder emails are sent elsewhere and are unaffected.
  const suppressReason = optedOut
    ? `${step.channel} opt-out`
    : !to
      ? `no ${step.channel} address`
      : step.channel === "email" && c.emailSource === "appended"
        ? "appended email (transactional-only)"
        : null;
  if (suppressReason) {
    await withTenant(tenantId, async (tx) => {
      await tx.insert(communication).values({
        tenantId, customerId, jobId: jobId ?? null, channel: step.channel, direction: "outbound",
        to: to ?? null, body: `[suppressed: ${suppressReason}]`, aiHandled: false,
      });
      await tx.update(dripEnrollment).set({ currentStep: step.stepNum }).where(eq(dripEnrollment.id, enrollmentId));
    });
    return { sent: false };
  }

  // Slice 6: gated steps — sequence slots for machinery that isn't live yet
  // (financing, the color render). Closed gate = suppressed + advance; the
  // slot activates itself the day the feature ships.
  const gateEnv = {
    financingLive: process.env.FINANCING_LIVE === "1", // swap to tenant config when the vendor adapter wires (#148)
    features: new Set((process.env.FEATURE_FLAGS ?? "").split(",").map((f) => f.trim()).filter(Boolean)),
  };
  if (!dripGateOpen(step.gate, gateEnv)) {
    await withTenant(tenantId, async (tx) => {
      await tx.insert(communication).values({
        tenantId, customerId, jobId: jobId ?? null, channel: step.channel, direction: "outbound",
        to: to ?? null, body: `[suppressed: gate ${step.gate}]`, aiHandled: false,
      });
      await tx.update(dripEnrollment).set({ currentStep: step.stepNum }).where(eq(dripEnrollment.id, enrollmentId));
    });
    return { sent: false };
  }

  // Slice 6: estimate context — the follow-up sequence's touches carry the
  // live page link and the real validity date, resolved at send time.
  let estimateVars: Record<string, string> = {};
  let followupEstimateId: string | null = null;
  if (leadId) {
    try {
      const [est] = await withTenant(tenantId, (tx) =>
        tx.select().from(estimate).where(eq(estimate.leadId, leadId)).orderBy(desc(estimate.createdAt)).limit(1),
      );
      if (est?.sentAt) {
        const [t2] = await adminDb.select({ settings: tenantTbl.settings }).from(tenantTbl).where(eq(tenantTbl.id, tenantId));
        const validityDays = parseEstimateConfig((t2?.settings as { estimate?: unknown } | null)?.estimate).validityDays;
        const base = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
        const { code } = await ensureEstimateLink({ tenantId, estimateId: est.id });
        followupEstimateId = est.id;
        estimateVars = {
          estimateLink: `${base}/estimate/${code}`,
          validUntil: new Date(est.sentAt.getTime() + validityDays * 86_400_000).toLocaleDateString("en-US", { month: "long", day: "numeric" }),
        };
      }
    } catch {
      /* fail-soft: touches still render, {{estimateLink}} empties w/ a console warn */
    }
  }

  const ctx = { name: c.name, firstName: firstNameOf(c.name), ...estimateVars };
  const drafted = await draftMessage({ step, templateBody, ctx }, deps.ai ?? ai);

  let providerId = "mock";
  // Throttle: when the tenant's SMS delivery rate is below the floor, skip the
  // actual send (mirroring the fail-soft mock-SID path) so we don't deepen a
  // carrier-filtering problem. Email is unaffected. Fail-soft ⇒ false.
  const smsThrottled = step.channel === "sms" && await (deps.isThrottled ?? isOutboundThrottled)(tenantId);
  let blockedReason: string | null = null;
  try {
    if (step.channel === "sms" && !smsThrottled) {
      // to is non-null here: the suppress guard returned when the address was missing.
      // guardedSms is the single chokepoint: it re-checks global suppression
      // (the compliance bypass this closes), consent/opt-out, and A2P approval
      // before the sender is ever invoked.
      const result = await guardedSms(
        { isSuppressed: deps.isSuppressed ?? isSuppressed, sms: deps.sms, smsFrom: () => deps.from },
        {
          tenantId, channel: "sms", to: to!, from: deps.from, body: drafted.body,
          consent: { smsOptOut: c.smsOptOut, emailOptOut: c.emailOptOut, smsConsentAt: c.smsConsentAt },
          a2pApproved: deps.a2pApproved ?? true,
          contactId: customerId,
        },
      );
      if (result.status === "sent") providerId = result.sid;
      else blockedReason = result.status === "blocked" ? `blocked: ${result.reason}` : `deferred: ${result.untilIso}`;
    } else if (step.channel === "email") {
      ({ id: providerId } = await deps.email.sendEmail({
        to: to!, from: process.env.EMAIL_FROM ?? "noreply@example.com",
        subject: "A note from your roofing team", html: drafted.body,
      }));
    }
  } catch {
    // No creds in dev/test — still log the comm with a mock id (fail-soft).
  }

  if (blockedReason) {
    // blocked/deferred: don't send. Log + advance the step, same shape as the
    // opt-out/no-address suppress guard above. A later Slice B task turns
    // `blocked` into a compliance-block escalation — for now, just log.
    await withTenant(tenantId, async (tx) => {
      await tx.insert(communication).values({
        tenantId, customerId, jobId: jobId ?? null, channel: step.channel, direction: "outbound",
        to: to ?? null, body: `[${blockedReason}]`, aiHandled: false,
      });
      await tx.update(dripEnrollment).set({ currentStep: step.stepNum }).where(eq(dripEnrollment.id, enrollmentId));
    });
    return { sent: false };
  }

  await withTenant(tenantId, async (tx) => {
    const [comm] = await tx.insert(communication).values({
      tenantId, customerId, jobId: jobId ?? null, channel: step.channel, direction: "outbound",
      to, body: drafted.body,
      twilioSid: step.channel === "sms" ? providerId : null, aiHandled: drafted.aiHandled,
    }).returning({ id: communication.id });
    await tx.insert(agentRun).values({
      tenantId, agent: "comms", jobId: jobId ?? null, leadId: leadId ?? null, status: "ok", modelUsed: drafted.model ?? null,
    });
    await tx.update(dripEnrollment).set({ currentStep: step.stepNum }).where(eq(dripEnrollment.id, enrollmentId));
    // Lead-scoped drip: record the follow-up sequence executing (proof, latest touch).
    if (leadId) {
      await markLeadTaskDoneTx(tx, tenantId, {
        leadId, taskId: REGISTRY_TASK.FOLLOW_UP_SEQUENCE, owner: "comms",
        evidence: { type: "communication", ref: comm!.id },
      });
    }
  });

  // Slice 6: stamp the touch on the estimate — sends + opens feed slice 7's
  // close-rate report.
  if (followupEstimateId) {
    try {
      await recordEstimateEvent({
        tenantId,
        estimateId: followupEstimateId,
        kind: "followup_sent",
        meta: { stepNum: step.stepNum, templateKey: step.templateKey ?? null },
      });
    } catch {
      /* telemetry is best-effort */
    }
  }

  return { sent: true };
}

/**
 * One run per enrollment. Creates the enrollment, then walks the drip's steps:
 * sleep -> re-check status (stopped? exit) -> send. Cancellation: drip/stop
 * matched on customerId kills the run mid-sleep; the stop SOURCE has already
 * set status='stopped' in the DB, and the per-step re-check is the backstop.
 */
export const dripRun = inngest.createFunction(
  {
    id: "drip-run",
    concurrency: { limit: 5 },
    // cancelOn matches customerId (NOT enrollmentId — the enrollment row is created
    // inside this run, so its id doesn't exist when the trigger fires). A single
    // drip/stop therefore halts ALL of a customer's drips, which is the intended
    // behavior for reply/convert/opt-out/manual stops. `match` is the inngest v3
    // shorthand; migrate to the `if` expression form when upgrading to inngest v4.
    cancelOn: [{ event: "drip/stop", match: "data.customerId" }],
  },
  { event: "drip/enroll" },
  async ({ event, step, runId }) => {
    const { tenantId, dripKey, customerId, jobId, leadId } = event.data;

    const setup = await step.run("create-enrollment", async () =>
      withTenant(tenantId, async (tx) => {
        const [d] = await tx.select().from(drip).where(and(eq(drip.key, dripKey), eq(drip.active, true)));
        if (!d) return null;
        // Idempotent: if two drip/enroll events race, the loser's insert hits the
        // partial unique index (drip_id, customer_id) WHERE status='active' and throws;
        // Inngest retries the step, this guard then returns null, and the retry exits cleanly.
        const existing = await tx.select().from(dripEnrollment).where(and(
          eq(dripEnrollment.dripId, d.id),
          eq(dripEnrollment.customerId, customerId),
          eq(dripEnrollment.status, "active"),
        ));
        if (existing.length > 0) return null;
        const [enr] = await tx.insert(dripEnrollment).values({
          tenantId, dripId: d.id, customerId, jobId: jobId ?? null, leadId: leadId ?? null,
          status: "active", inngestRunId: runId,
        }).returning();
        const [t] = await tx.select().from(tenantTbl).where(eq(tenantTbl.id, tenantId));
        const gmailConnectionId = parseEmailConfig((t?.settings as { email?: unknown } | undefined)?.email).gmailConnectionId ?? null;
        return { enrollmentId: enr!.id, steps: d.steps, gmailConnectionId };
      }),
    );
    if (!setup) return { skipped: true };

    for (const s of setup.steps) {
      if (s.delayHours > 0) await step.sleep(`step-${s.stepNum}`, `${s.delayHours}h`);

      const stillActive = await step.run(`check-${s.stepNum}`, async () =>
        withTenant(tenantId, async (tx) => {
          const [enr] = await tx.select().from(dripEnrollment).where(eq(dripEnrollment.id, setup.enrollmentId));
          return enr?.status === "active";
        }),
      );
      if (!stillActive) return { stopped: true, atStep: s.stepNum };

      await step.run(`send-${s.stepNum}`, async () => {
        let templateBody: string | undefined;
        if (s.templateKey) {
          templateBody = await withTenant(tenantId, async (tx) => {
            const [t] = await tx.select().from(messageTemplate).where(eq(messageTemplate.key, s.templateKey!));
            return t?.body;
          });
        }
        const { sender, from } = await getTenantSms(tenantId);
        const email = await getTenantEmail(tenantId, { gmailConnectionId: setup.gmailConnectionId });
        return sendDripStep(
          { tenantId, enrollmentId: setup.enrollmentId, customerId, step: s, templateBody, jobId, leadId },
          { sms: sender, from, email, a2pApproved: resolveA2pApproved(tenantId, from) },
        );
      });
    }

    await step.run("complete", async () =>
      withTenant(tenantId, (tx) =>
        tx.update(dripEnrollment)
          .set({ status: "completed", completedAt: new Date() })
          .where(and(eq(dripEnrollment.id, setup.enrollmentId), eq(dripEnrollment.status, "active"))),
      ),
    );
    return { completed: true };
  },
);
