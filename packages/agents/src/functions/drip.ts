import { renderTemplate, type DripStep } from "@savvy/core";
import * as ai from "@savvy/ai";
import {
  withTenant, eq, and, customer, communication, agentRun, dripEnrollment, drip, messageTemplate,
} from "@savvy/db";
import type { SmsSender, EmailSender } from "@savvy/integrations";
import { twilioSms, resendEmail } from "@savvy/integrations";
import { inngest } from "../client";

export type DripContext = { name: string; firstName: string };

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
      capability: step.aiCapability ?? "summarize",
      system: "You write short, friendly roofing-company follow-up messages. No placeholders.",
      prompt: `${step.aiPrompt}\n\nContact: ${ctx.name}. Keep it concise for ${step.channel}.`,
    });
    return { body: text, aiHandled: true, model };
  }
  const vars: Record<string, string> = { name: ctx.name, firstName: ctx.firstName };
  return { body: renderTemplate(templateBody ?? "", vars), aiHandled: false };
}

export type SendDeps = { sms: SmsSender; email: EmailSender; ai?: Pick<typeof ai, "complete"> };

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
    step: DripStep; templateBody?: string; jobId?: string;
  },
  deps: SendDeps,
): Promise<{ sent: boolean }> {
  const { tenantId, enrollmentId, customerId, step, templateBody, jobId } = input;

  const c = await withTenant(tenantId, async (tx) => {
    const [row] = await tx.select().from(customer).where(eq(customer.id, customerId));
    return row!;
  });

  const to = step.channel === "sms" ? c.phone : c.email;
  const optedOut = step.channel === "sms" ? c.smsOptOut : c.emailOptOut;
  // Suppress when opted out OR no address for the channel: log a note + advance, no send.
  const suppressReason = optedOut
    ? `${step.channel} opt-out`
    : !to
      ? `no ${step.channel} address`
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

  const ctx = { name: c.name, firstName: firstNameOf(c.name) };
  const drafted = await draftMessage({ step, templateBody, ctx }, deps.ai ?? ai);

  let providerId = "mock";
  try {
    if (step.channel === "sms") {
      // to is non-null here: the suppress guard returned when the address was missing.
      ({ sid: providerId } = await deps.sms.sendSms({
        to: to!, from: process.env.TWILIO_FROM ?? "+15555550000", body: drafted.body,
      }));
    } else {
      ({ id: providerId } = await deps.email.sendEmail({
        to: to!, from: process.env.EMAIL_FROM ?? "noreply@example.com",
        subject: "A note from your roofing team", html: drafted.body,
      }));
    }
  } catch {
    // No creds in dev/test — still log the comm with a mock id (fail-soft).
  }

  await withTenant(tenantId, async (tx) => {
    await tx.insert(communication).values({
      tenantId, customerId, jobId: jobId ?? null, channel: step.channel, direction: "outbound",
      to, body: drafted.body,
      twilioSid: step.channel === "sms" ? providerId : null, aiHandled: drafted.aiHandled,
    });
    await tx.insert(agentRun).values({
      tenantId, agent: "comms", jobId: jobId ?? null, status: "ok", modelUsed: drafted.model ?? null,
    });
    await tx.update(dripEnrollment).set({ currentStep: step.stepNum }).where(eq(dripEnrollment.id, enrollmentId));
  });

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
    concurrency: { limit: 20 },
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
        return { enrollmentId: enr!.id, steps: d.steps };
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
        return sendDripStep(
          { tenantId, enrollmentId: setup.enrollmentId, customerId, step: s, templateBody, jobId },
          { sms: twilioSms, email: resendEmail },
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
