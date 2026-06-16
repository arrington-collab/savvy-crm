import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

export interface DocusealGateway {
  createSubmission(o: { estimateId: string; signerEmail: string; total: number }): Promise<{ submissionId: string; signUrl: string }>;
  parseEvent(payload: unknown): { submissionId: string; status: "completed" | "other" } | null;
  /**
   * Verifies a webhook's HMAC signature against the raw request body.
   * Returns true when no `DOCUSEAL_WEBHOOK_SECRET` is configured (dev/test/fake);
   * when a secret IS set, requires a valid signature.
   */
  verifyWebhook(rawBody: string, signature: string | null): boolean;
}

const BASE = () => process.env.DOCUSEAL_BASE_URL ?? "https://api.docuseal.com";

function hmacVerify(rawBody: string, signature: string | null): boolean {
  const secret = process.env.DOCUSEAL_WEBHOOK_SECRET;
  // Fail CLOSED in production if the secret is missing; allow only in dev/test
  // (so the fake-first e2e works without configuring a secret).
  if (!secret) return process.env.NODE_ENV !== "production";
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const httpDocuseal: DocusealGateway = {
  async createSubmission({ estimateId, signerEmail }) {
    const res = await fetch(`${BASE()}/submissions`, {
      method: "POST",
      headers: { "X-Auth-Token": process.env.DOCUSEAL_API_KEY ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: process.env.DOCUSEAL_TEMPLATE_ID,
        send_email: true,
        submitters: [{ role: "Customer", email: signerEmail, metadata: { estimateId } }],
      }),
    });
    if (!res.ok) throw new Error(`docuseal create -> ${res.status}`);
    const j = (await res.json()) as Array<{ submission_id?: number; slug?: string }>;
    const submissionId = String(j[0]?.submission_id ?? "");
    return { submissionId, signUrl: `${BASE()}/s/${j[0]?.slug ?? submissionId}` };
  },
  parseEvent(payload) {
    const p = payload as { event_type?: string; data?: { submission_id?: string | number } };
    const submissionId = String(p.data?.submission_id ?? "");
    if (!submissionId) return null;
    return { submissionId, status: p.event_type === "form.completed" ? "completed" : "other" };
  },
  verifyWebhook(rawBody, signature) {
    return hmacVerify(rawBody, signature);
  },
};

export function makeFakeDocuseal(): DocusealGateway & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async createSubmission() {
      // Globally unique so webhook lookups by submissionId never collide across
      // estimates/runs (a per-instance counter would repeat "ds_sub_1").
      const submissionId = `ds_sub_${randomUUID().replace(/-/g, "")}`;
      calls.push(submissionId);
      return { submissionId, signUrl: `https://docuseal.test/s/${submissionId}` };
    },
    parseEvent(payload) {
      const p = payload as { event_type?: string; data?: { submission_id?: string } };
      const submissionId = String(p.data?.submission_id ?? "");
      if (!submissionId) return null;
      return { submissionId, status: p.event_type === "form.completed" ? "completed" : "other" };
    },
    verifyWebhook(rawBody, signature) {
      return hmacVerify(rawBody, signature);
    },
  };
}
