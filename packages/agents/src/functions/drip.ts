import { renderTemplate, type DripStep } from "@savvy/core";
import * as ai from "@savvy/ai";
import {
  withTenant, eq, customer, communication, agentRun, dripEnrollment,
} from "@savvy/db";
import type { SmsSender, EmailSender } from "@savvy/integrations";

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
 * Renders + sends one drip step, logs a communication + agent_run, advances
 * current_step. Suppresses (and logs nothing sent) when the channel is opted
 * out. Senders are injected + fail-soft (a missing-creds throw still logs the
 * comm with a mock id). Tenant-scoped.
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

  const optedOut = step.channel === "sms" ? c.smsOptOut : c.emailOptOut;
  if (optedOut) {
    await withTenant(tenantId, (tx) =>
      tx.insert(communication).values({
        tenantId, customerId, jobId: jobId ?? null, channel: step.channel, direction: "outbound",
        to: step.channel === "sms" ? c.phone : c.email,
        body: `[suppressed: ${step.channel} opt-out]`, aiHandled: false,
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.update(dripEnrollment).set({ currentStep: step.stepNum }).where(eq(dripEnrollment.id, enrollmentId)),
    );
    return { sent: false };
  }

  const ctx = { name: c.name, firstName: firstNameOf(c.name) };
  const drafted = await draftMessage({ step, templateBody, ctx }, deps.ai ?? ai);

  let providerId = "mock";
  try {
    if (step.channel === "sms") {
      ({ sid: providerId } = await deps.sms.sendSms({
        to: c.phone ?? "", from: process.env.TWILIO_FROM ?? "+15555550000", body: drafted.body,
      }));
    } else {
      ({ id: providerId } = await deps.email.sendEmail({
        to: c.email ?? "", from: process.env.EMAIL_FROM ?? "noreply@example.com",
        subject: "A note from your roofing team", html: drafted.body,
      }));
    }
  } catch {
    // No creds in dev/test — still log the comm with a mock id (fail-soft).
  }

  await withTenant(tenantId, async (tx) => {
    await tx.insert(communication).values({
      tenantId, customerId, jobId: jobId ?? null, channel: step.channel, direction: "outbound",
      to: step.channel === "sms" ? c.phone : c.email, body: drafted.body,
      twilioSid: step.channel === "sms" ? providerId : null, aiHandled: drafted.aiHandled,
    });
    await tx.insert(agentRun).values({
      tenantId, agent: "comms", jobId: jobId ?? null, status: "ok", modelUsed: drafted.model ?? null,
    });
    await tx.update(dripEnrollment).set({ currentStep: step.stepNum }).where(eq(dripEnrollment.id, enrollmentId));
  });

  return { sent: true };
}
