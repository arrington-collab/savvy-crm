import { z, signPayloadToken } from "@savvy/core";
import {
  withTenant, lead, customer, communication, recordAgentRun, eq,
} from "@savvy/db";
import * as ai from "@savvy/ai";
import { twilioSms, type SmsSender } from "@savvy/integrations";
import { inngest } from "../client";

const qualifySchema = z.object({ score: z.number().min(0).max(100), reason: z.string().max(200) });

// Pure, unit-testable AI qualification. `aiClient` is injectable for tests.
export async function qualifyLead(
  input: { name: string; address: string; source: string },
  aiClient: Pick<typeof ai, "completeObject"> = ai,
): Promise<{ score: number; reason: string; model: string }> {
  const { object, model } = await aiClient.completeObject({
    capability: "reflex",
    schema: qualifySchema,
    system: "You score roofing leads 0-100 by likelihood to close. Be terse.",
    prompt: `Lead: ${input.name}, ${input.address}, source=${input.source}. Score it.`,
  });
  return { score: object.score, reason: object.reason, model };
}

export function buildBookingSms(opts: { name: string; bookingUrl: string }): string {
  return `Hi ${opts.name}, thanks for reaching out! Book your free roof inspection here: ${opts.bookingUrl}`;
}

// Placeholder business-hours check (per-tenant tz comes in Phase 3). Returns
// true outside ~8am-6pm UTC. Deterministic, non-critical for Phase 0.
function isAfterHours(d: Date): boolean {
  const h = d.getUTCHours();
  return h < 8 || h >= 18;
}

export const leadIntake = inngest.createFunction(
  { id: "lead-intake", concurrency: { limit: 20 } },
  { event: "lead/created" },
  async ({ event, step }) => {
    const { leadId, tenantId } = event.data;

    const ctx = await step.run("load-lead", async () =>
      withTenant(tenantId, async (tx) => {
        const [l] = await tx.select().from(lead).where(eq(lead.id, leadId));
        const [c] = await tx.select().from(customer).where(eq(customer.id, l!.customerId!));
        return { name: c!.name, phone: c!.phone ?? "", source: l!.source ?? "web", address: "unknown" };
      }),
    );

    const scored = await step.run("ai-qualify", async () => {
      const r = await qualifyLead({ name: ctx.name, address: ctx.address, source: ctx.source }, ai);
      await withTenant(tenantId, (tx) =>
        tx.update(lead).set({ score: r.score, scoreReason: r.reason, status: "contacted" }).where(eq(lead.id, leadId)),
      );
      await recordAgentRun({
        tenantId, agent: "comms", taskKey: "lead.qualify", status: "ok",
        modelUsed: r.model, inngestRunId: event.id ?? null,
      });
      return r;
    });

    await step.run("send-sms", async () => {
      const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
      const secret = process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret";
      const token = signPayloadToken({ leadId, tenantId, type: "inspection" }, secret);
      const body = buildBookingSms({ name: ctx.name, bookingUrl: `${base}/book/${token}` });
      const sender: SmsSender = twilioSms;
      let sid = "mock";
      try {
        ({ sid } = await sender.sendSms({ to: ctx.phone, from: process.env.TWILIO_FROM ?? "+15555550000", body }));
      } catch {
        // No Twilio creds in dev/test — log the comm anyway with a mock sid.
      }
      await withTenant(tenantId, (tx) =>
        tx.insert(communication).values({
          tenantId, channel: "sms", direction: "outbound", to: ctx.phone, body,
          twilioSid: sid, aiHandled: isAfterHours(new Date()),
        }),
      );
      return { sid };
    });

    return { leadId, score: scored.score };
  },
);
