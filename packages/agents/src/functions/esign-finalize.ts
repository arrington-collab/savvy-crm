import { withTenant, eq, esignRequest, document } from "@savvy/db";
import type { DocusealGateway, StorageGateway } from "@savvy/integrations";
import { httpDocuseal, makeFakeDocuseal, r2Storage } from "@savvy/integrations";
import { inngest } from "../client";

/** Real gateway when DocuSeal is configured; fake (fail-soft) otherwise (dev/e2e). */
function defaultDocuseal(): DocusealGateway {
  return process.env.DOCUSEAL_API_KEY ? httpDocuseal : makeFakeDocuseal();
}

/**
 * Pure helper (injectable deps) so it can be tested with fake gateways against a
 * real DB. Idempotent: if the request already has a documentId, store nothing.
 * Bytes never cross a step boundary — download + store + record happen here.
 */
export async function finalizeEsign(
  input: { tenantId: string; requestId: string },
  deps: { docuseal: DocusealGateway; storage: StorageGateway },
): Promise<{ stored: boolean; reason?: string }> {
  const { tenantId, requestId } = input;

  const req = await withTenant(tenantId, async (tx) => {
    const [r] = await tx
      .select({
        jobId: esignRequest.jobId,
        customerId: esignRequest.customerId,
        docType: esignRequest.docType,
        submissionId: esignRequest.docusealSubmissionId,
        documentId: esignRequest.documentId,
      })
      .from(esignRequest)
      .where(eq(esignRequest.id, requestId));
    return r ?? null;
  });
  if (!req) return { stored: false, reason: "not_found" };
  if (req.documentId) return { stored: false, reason: "already_finalized" };

  const pdf = await deps.docuseal.downloadSignedPdf({ submissionId: req.submissionId });
  const key = `${tenantId}/${req.jobId}/esign-${requestId}.pdf`;
  await deps.storage.putObject({ key, bytes: pdf.bytes, contentType: pdf.mime });

  await withTenant(tenantId, async (tx) => {
    const [doc] = await tx
      .insert(document)
      .values({
        tenantId,
        jobId: req.jobId,
        customerId: req.customerId,
        kind: req.docType,
        r2Key: key,
        filename: `${req.docType}.pdf`,
        mime: pdf.mime,
        sizeBytes: pdf.bytes.byteLength,
        source: "docuseal",
      })
      .returning({ id: document.id });
    await tx.update(esignRequest).set({ documentId: doc!.id }).where(eq(esignRequest.id, requestId));
  });

  return { stored: true };
}

export const esignFinalize = inngest.createFunction(
  { id: "esign-finalize", concurrency: { limit: 5 } },
  { event: "esign/completed" },
  async ({ event, step }) =>
    step.run("finalize", () =>
      finalizeEsign(event.data, { docuseal: defaultDocuseal(), storage: r2Storage }),
    ),
);
