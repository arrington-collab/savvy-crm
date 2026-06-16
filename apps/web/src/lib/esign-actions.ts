"use server";
import { withTenant, adminDb, tenant, job, customer, property, esignRequest, eq } from "@savvy/db";
import { httpDocuseal, makeFakeDocuseal } from "@savvy/integrations";
import {
  parseEsignConfig, resolveEsignTemplate, buildEsignPrefill, ESIGN_DOC_TYPE, type EsignDocType,
} from "@savvy/core";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";

/** Real gateway when DocuSeal is configured; fake (fail-soft) otherwise (dev/e2e). */
const docuseal = () => (process.env.DOCUSEAL_API_KEY ? httpDocuseal : makeFakeDocuseal());

type SendResult =
  | { ok: true; requestId: string; signingUrl: string }
  | { error: "bad_doc_type" | "not_found" | "no_customer_email" | "no_template" | "docuseal_failed" };

export async function sendForSignature(input: { jobId: string; docType: EsignDocType }): Promise<SendResult> {
  if (!ESIGN_DOC_TYPE.includes(input.docType)) return { error: "bad_doc_type" };
  const tenantId = await getTenantId();

  // Read job + customer + property in one tenant-scoped transaction.
  const ctx = await withTenant(tenantId, async (tx) => {
    const [j] = await tx
      .select({
        customerId: job.customerId,
        propertyId: job.propertyId,
        valueFinal: job.valueFinal,
        valueEstimate: job.valueEstimate,
      })
      .from(job)
      .where(eq(job.id, input.jobId));
    if (!j) return null;
    const [c] = await tx.select({ name: customer.name, email: customer.email }).from(customer).where(eq(customer.id, j.customerId));
    const [p] = await tx.select({ address: property.address }).from(property).where(eq(property.id, j.propertyId));
    return { j, c, p };
  });
  if (!ctx) return { error: "not_found" };
  if (!ctx.c?.email) return { error: "no_customer_email" };
  const email = ctx.c.email;

  // tenant.settings has no RLS — read via adminDb.
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const cfg = parseEsignConfig((t?.settings as { esign?: unknown } | undefined)?.esign);
  const fallback =
    input.docType === "lien_waiver"
      ? process.env.DOCUSEAL_TEMPLATE_LIEN_WAIVER ?? ""
      : process.env.DOCUSEAL_TEMPLATE_CERT ?? "";
  const templateId = resolveEsignTemplate(cfg, input.docType, fallback);
  // No tenant override and no env fallback → DocuSeal template isn't set up yet.
  if (!templateId) return { error: "no_template" };

  const amountCents = ctx.j.valueFinal ?? ctx.j.valueEstimate ?? null;
  const amount = amountCents != null ? `$${(amountCents / 100).toFixed(2)}` : "";
  const date = new Date().toISOString().slice(0, 10);
  const fields = buildEsignPrefill(input.docType, {
    customerName: ctx.c.name,
    propertyAddress: ctx.p?.address ?? "",
    date,
    amount,
  });

  // Outbound HTTP OUTSIDE the transaction.
  let submission: { submissionId: string; signingUrl: string };
  try {
    submission = await docuseal().createClosoutSubmission({
      templateId,
      signer: { name: ctx.c.name, email },
      fields,
      metadata: { tenantId, jobId: input.jobId, docType: input.docType },
    });
  } catch {
    return { error: "docuseal_failed" };
  }

  const requestId = await withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .insert(esignRequest)
      .values({
        tenantId,
        jobId: input.jobId,
        customerId: ctx.j.customerId,
        docType: input.docType,
        templateId,
        docusealSubmissionId: submission.submissionId,
        status: "sent",
        signingUrl: submission.signingUrl,
        sentAt: new Date(),
      })
      .returning({ id: esignRequest.id });
    return row!.id;
  });

  revalidatePath(`/jobs/${input.jobId}`);
  return { ok: true, requestId, signingUrl: submission.signingUrl };
}
