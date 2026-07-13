import { randomUUID } from "node:crypto";
import { withTenant, communication } from "@savvy/db";
import type { SmsSender, EmailSender, VoiceGateway } from "@savvy/integrations";

async function logMock(
  tenantId: string,
  row: { channel: "sms" | "email" | "call"; to: string | null; from: string | null; body: string | null },
): Promise<string> {
  const id = `mock:${randomUUID()}`;
  await withTenant(tenantId, (tx) =>
    tx.insert(communication).values({
      tenantId,
      channel: row.channel,
      direction: "outbound",
      to: row.to,
      from: row.from,
      body: row.body,
      twilioSid: id,
      deliveryStatus: "mock",
    }),
  );
  return id;
}

/** SMS sender for demo tenants: logs a mock communication row, never hits a provider. */
export function makeMockSms(tenantId: string): SmsSender {
  return {
    async sendSms({ to, from, body }) {
      const sid = await logMock(tenantId, { channel: "sms", to, from, body });
      return { sid };
    },
  };
}

/** Email sender for demo tenants: logs a mock row (subject+html collapsed into body). */
export function makeMockEmail(tenantId: string): EmailSender {
  return {
    async sendEmail({ to, from, subject, html }) {
      const id = await logMock(tenantId, { channel: "email", to, from, body: `${subject}\n${html}` });
      return { id };
    },
  };
}

/** Voice gateway for demo tenants: logs a mock call row, never dials. */
export function makeMockVoice(tenantId: string): VoiceGateway {
  return {
    async placeOutboundCall({ toPhone }) {
      const callId = await logMock(tenantId, { channel: "call", to: toPhone, from: null, body: null });
      return { callId };
    },
  };
}
