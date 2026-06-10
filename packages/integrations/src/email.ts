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
