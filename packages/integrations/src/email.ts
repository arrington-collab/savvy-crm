import { nangoProxy } from "./nango";

export interface EmailSender {
  sendEmail(opts: { to: string; from: string; subject: string; html: string }): Promise<{ id: string }>;
}

/** Factory so tests inject apiKey + fetch. Real export reads env below. */
export function makeResendEmail(cfg: { apiKey: string; fetchImpl?: typeof fetch }): EmailSender {
  const doFetch = cfg.fetchImpl ?? fetch;
  return {
    async sendEmail({ to, from, subject, html }) {
      const res = await doFetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({ to, from, subject, html }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`resend send failed: ${res.status} ${detail}`);
      }
      const data = (await res.json()) as { id: string };
      return { id: data.id };
    },
  };
}

// Real implementation bound to env. Feature code imports `resendEmail`.
export const resendEmail: EmailSender = makeResendEmail({
  apiKey: process.env.RESEND_API_KEY ?? "",
});

type NangoProxy = typeof nangoProxy;

// RFC822 header values must be single-line; collapse CR/LF to a space to prevent header injection.
const headerSafe = (v: string) => v.replace(/[\r\n]+/g, " ");

/** Per-tenant Gmail sender via Nango's google-mail connection. `proxyImpl` is
 *  injectable for tests; defaults to the real nangoProxy. Gmail sends from the
 *  authorized account regardless of the From header. */
export function makeGmailEmail(cfg: { connectionId: string; integrationId?: string; proxyImpl?: NangoProxy }): EmailSender {
  const proxy = cfg.proxyImpl ?? nangoProxy;
  const integrationId = cfg.integrationId ?? process.env.NANGO_GMAIL_INTEGRATION_ID ?? "google-mail";
  return {
    async sendEmail({ to, from, subject, html }) {
      const raw = Buffer.from(
        [
          `To: ${headerSafe(to)}`,
          `From: ${headerSafe(from)}`,
          `Subject: ${headerSafe(subject)}`,
          "MIME-Version: 1.0",
          'Content-Type: text/html; charset="UTF-8"',
          "",
          html,
        ].join("\r\n"),
      ).toString("base64url");
      const res = await proxy({
        connectionId: cfg.connectionId,
        integrationId,
        method: "POST",
        endpoint: "/gmail/v1/users/me/messages/send",
        body: { raw },
      });
      return { id: (res as { id: string }).id };
    },
  };
}

/** Resolve the email sender for a tenant: Gmail when connected, else shared Resend. */
export function getEmailSender(o: { gmailConnectionId?: string | null }): EmailSender {
  return o.gmailConnectionId ? makeGmailEmail({ connectionId: o.gmailConnectionId }) : resendEmail;
}
