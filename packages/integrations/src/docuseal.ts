import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

export interface DocusealGateway {
  /** Estimate signing (Phase 7): one Savvy estimate template, signer = customer. */
  createSubmission(o: { estimateId: string; signerEmail: string; total: number }): Promise<{ submissionId: string; signUrl: string }>;
  /** Closeout signing (Phase 6B): lien waiver / cert with a chosen template + prefilled fields. */
  createClosoutSubmission(o: {
    templateId: string;
    signer: { name: string; email: string };
    fields: { name: string; default_value: string }[];
    metadata: { tenantId: string; jobId: string; docType: string };
  }): Promise<{ submissionId: string; signingUrl: string }>;
  parseEvent(payload: unknown): { submissionId: string; status: "completed" | "other" } | null;
  /**
   * Verifies a webhook's HMAC signature against the raw request body.
   * Returns true when no `DOCUSEAL_WEBHOOK_SECRET` is configured (dev/test/fake);
   * when a secret IS set, requires a valid signature.
   */
  verifyWebhook(rawBody: string, signature: string | null): boolean;
  /** Fetches the signed PDF bytes for a submission (Phase 6B closeout finalize). */
  downloadSignedPdf(o: { submissionId: string }): Promise<{ bytes: Uint8Array; mime: string }>;
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

  async createClosoutSubmission({ templateId, signer, fields, metadata }) {
    const res = await fetch(`${BASE()}/submissions`, {
      method: "POST",
      headers: { "X-Auth-Token": process.env.DOCUSEAL_API_KEY ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: Number(templateId),
        send_email: true,
        submitters: [{ role: "Signer", name: signer.name, email: signer.email, fields }],
        metadata,
      }),
    });
    if (!res.ok) throw new Error(`docuseal createClosout -> ${res.status}`);
    const arr = (await res.json()) as Array<{ submission_id: number; slug: string; embed_src?: string }>;
    const first = arr[0];
    if (!first) throw new Error("docuseal createClosout: empty response");
    return {
      submissionId: String(first.submission_id),
      signingUrl: first.embed_src ?? `${BASE()}/s/${first.slug}`,
    };
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

  async downloadSignedPdf({ submissionId }) {
    const res = await fetch(`${BASE()}/submissions/${submissionId}`, {
      headers: { "X-Auth-Token": process.env.DOCUSEAL_API_KEY ?? "" },
    });
    if (!res.ok) throw new Error(`docuseal getSubmission -> ${res.status}`);
    const sub = (await res.json()) as { documents?: Array<{ url: string }>; combined_document_url?: string };
    const url = sub.combined_document_url ?? sub.documents?.[0]?.url;
    if (!url) throw new Error("docuseal: no signed document url");
    const pdfRes = await fetch(url);
    if (!pdfRes.ok) throw new Error(`docuseal download -> ${pdfRes.status}`);
    return { bytes: new Uint8Array(await pdfRes.arrayBuffer()), mime: "application/pdf" };
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
    async createClosoutSubmission() {
      const submissionId = `ds_sub_${randomUUID().replace(/-/g, "")}`;
      calls.push(submissionId);
      return { submissionId, signingUrl: `https://docuseal.test/s/${submissionId}` };
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
    async downloadSignedPdf() {
      calls.push("download");
      return { bytes: new Uint8Array([37, 80, 68, 70]), mime: "application/pdf" }; // %PDF
    },
  };
}
