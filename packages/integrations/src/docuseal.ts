export interface DocusealGateway {
  createSubmission(o: { estimateId: string; signerEmail: string; total: number }): Promise<{ submissionId: string; signUrl: string }>;
  parseEvent(payload: unknown): { submissionId: string; status: "completed" | "other" } | null;
}

const BASE = () => process.env.DOCUSEAL_BASE_URL ?? "https://api.docuseal.com";

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
};

export function makeFakeDocuseal(): DocusealGateway & { calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    async createSubmission() {
      const submissionId = `ds_sub_${++n}`;
      calls.push(submissionId);
      return { submissionId, signUrl: `https://docuseal.test/s/${submissionId}` };
    },
    parseEvent(payload) {
      const p = payload as { event_type?: string; data?: { submission_id?: string } };
      const submissionId = String(p.data?.submission_id ?? "");
      if (!submissionId) return null;
      return { submissionId, status: p.event_type === "form.completed" ? "completed" : "other" };
    },
  };
}
