import { createHmac, timingSafeEqual } from "node:crypto";

export interface DocusealGateway {
  createSubmission(o: {
    templateId: string;
    signer: { name: string; email: string };
    fields: { name: string; default_value: string }[];
    metadata: { tenantId: string; jobId: string; docType: string };
  }): Promise<{ submissionId: string; signingUrl: string }>;
  verifyWebhook(rawBody: string, signature: string | null):
    | { submissionId: string; status: "completed" | "declined" }
    | null;
  downloadSignedPdf(o: { submissionId: string }): Promise<{ bytes: Uint8Array; mime: string }>;
}

function cfg(): { base: string; key: string } {
  const base = process.env.DOCUSEAL_BASE_URL;
  const key = process.env.DOCUSEAL_API_KEY;
  if (!base || !key) throw new Error("docuseal_not_configured");
  return { base: base.replace(/\/$/, ""), key };
}

export const docusealGateway: DocusealGateway = {
  async createSubmission({ templateId, signer, fields, metadata }) {
    const { base, key } = cfg();
    const res = await fetch(`${base}/submissions`, {
      method: "POST",
      headers: { "X-Auth-Token": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: Number(templateId),
        send_email: true,
        submitters: [{ role: "Signer", name: signer.name, email: signer.email, fields }],
        metadata,
      }),
    });
    if (!res.ok) throw new Error(`docuseal createSubmission -> ${res.status}`);
    const arr = (await res.json()) as Array<{ submission_id: number; slug: string; embed_src?: string }>;
    const first = arr[0];
    if (!first) throw new Error("docuseal createSubmission: empty response");
    return {
      submissionId: String(first.submission_id),
      signingUrl: first.embed_src ?? `${base}/s/${first.slug}`,
    };
  },

  verifyWebhook(rawBody, signature) {
    const secret = process.env.DOCUSEAL_WEBHOOK_SECRET ?? "";
    if (secret) {
      if (!signature) return null;
      const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    }
    let payload: { event_type?: string; data?: { id?: number; submission_id?: number } };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const subId = payload.data?.submission_id ?? payload.data?.id;
    if (subId == null) return null;
    const et = payload.event_type ?? "";
    const status: "completed" | "declined" | null = et.includes("completed")
      ? "completed"
      : et.includes("declined")
        ? "declined"
        : null;
    if (!status) return null;
    return { submissionId: String(subId), status };
  },

  async downloadSignedPdf({ submissionId }) {
    const { base, key } = cfg();
    const res = await fetch(`${base}/submissions/${submissionId}`, { headers: { "X-Auth-Token": key } });
    if (!res.ok) throw new Error(`docuseal getSubmission -> ${res.status}`);
    const sub = (await res.json()) as { documents?: Array<{ url: string }>; combined_document_url?: string };
    const url = sub.combined_document_url ?? sub.documents?.[0]?.url;
    if (!url) throw new Error("docuseal: no signed document url");
    const pdfRes = await fetch(url);
    if (!pdfRes.ok) throw new Error(`docuseal download -> ${pdfRes.status}`);
    return { bytes: new Uint8Array(await pdfRes.arrayBuffer()), mime: "application/pdf" };
  },
};

export function makeFakeDocuseal(): DocusealGateway & { calls: { op: string }[] } {
  const calls: { op: string }[] = [];
  let n = 0;
  return {
    calls,
    async createSubmission() {
      const submissionId = `sub_fake_${++n}`;
      calls.push({ op: "create" });
      return { submissionId, signingUrl: `https://docuseal.test/s/${submissionId}` };
    },
    verifyWebhook(rawBody) {
      calls.push({ op: "verify" });
      try {
        const p = JSON.parse(rawBody) as { submissionId?: string; status?: "completed" | "declined" };
        if (!p.submissionId || (p.status !== "completed" && p.status !== "declined")) return null;
        return { submissionId: p.submissionId, status: p.status };
      } catch {
        return null;
      }
    },
    async downloadSignedPdf() {
      calls.push({ op: "download" });
      return { bytes: new Uint8Array([37, 80, 68, 70]), mime: "application/pdf" }; // %PDF
    },
  };
}
