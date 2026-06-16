import { eq, sql } from "drizzle-orm";
import { withTenant } from "../tenant";
import { adminDb } from "../admin-client";
import { changeOrder, job, invoice } from "../schema/index";
import { computeChangeOrderTotal } from "@savvy/core";

type CoRow = typeof changeOrder.$inferSelect;

export async function createChangeOrder(input: {
  tenantId: string;
  jobId: string;
  customerId: string;
  reason?: string;
  lineItems: { amountCents: number }[];
}): Promise<CoRow> {
  const { subtotal, total } = computeChangeOrderTotal(input.lineItems);
  return withTenant(input.tenantId, async (tx) => {
    const [row] = await tx
      .insert(changeOrder)
      .values({
        tenantId: input.tenantId,
        jobId: input.jobId,
        customerId: input.customerId,
        reason: input.reason ?? null,
        status: "draft",
        lineItems: input.lineItems,
        subtotal,
        total,
      })
      .returning();
    return row!;
  });
}

export async function sendChangeOrder(input: {
  tenantId: string;
  changeOrderId: string;
  docusealSubmissionId: string;
  signingUrl: string;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx
      .update(changeOrder)
      .set({ status: "sent", sentAt: sql`now()`, docusealSubmissionId: input.docusealSubmissionId, signingUrl: input.signingUrl })
      .where(eq(changeOrder.id, input.changeOrderId)),
  );
}

/**
 * Webhook-side status flip (mirrors markEsignBySubmission). No tenant session, so
 * resolve the tenant by the globally-unique submission id via adminDb, then flip
 * sent -> approved inside withTenant. Idempotent: a terminal row returns changed:false.
 */
export async function markChangeOrderBySubmission(input: {
  submissionId: string;
}): Promise<{ tenantId: string; changeOrderId: string; changed: boolean } | null> {
  const [row] = await adminDb
    .select({ id: changeOrder.id, tenantId: changeOrder.tenantId, status: changeOrder.status })
    .from(changeOrder)
    .where(eq(changeOrder.docusealSubmissionId, input.submissionId))
    .limit(1);
  if (!row) return null;
  if (row.status === "approved" || row.status === "declined" || row.status === "voided") {
    return { tenantId: row.tenantId, changeOrderId: row.id, changed: false };
  }
  await withTenant(row.tenantId, (tx) =>
    tx.update(changeOrder).set({ status: "approved", approvedAt: new Date() }).where(eq(changeOrder.id, row.id)),
  );
  return { tenantId: row.tenantId, changeOrderId: row.id, changed: true };
}

/**
 * Durable money mutation (status already approved). Idempotent via `applied`:
 * bump job.valueFinal by the delta, and when total>0 insert a DRAFT supplemental
 * invoice (mirrors createInvoiceFromEstimate). All in one tx.
 */
export async function approveChangeOrder(input: {
  tenantId: string;
  changeOrderId: string;
}): Promise<{ invoiceCreated: boolean }> {
  return withTenant(input.tenantId, async (tx) => {
    const [co] = await tx.select().from(changeOrder).where(eq(changeOrder.id, input.changeOrderId));
    if (!co || co.applied) return { invoiceCreated: false };
    const total = co.total ?? 0;

    const [j] = await tx.select().from(job).where(eq(job.id, co.jobId));
    const base = j?.valueFinal ?? j?.valueEstimate ?? 0;
    await tx.update(job).set({ valueFinal: base + total }).where(eq(job.id, co.jobId));

    let invoiceId: string | null = null;
    if (total > 0) {
      const [inv] = await tx
        .insert(invoice)
        .values({
          tenantId: input.tenantId,
          jobId: co.jobId,
          customerId: co.customerId,
          lineItems: co.lineItems as unknown[],
          amountDue: total,
          status: "draft",
        })
        .returning({ id: invoice.id });
      invoiceId = inv!.id;
    }

    await tx.update(changeOrder).set({ applied: true, invoiceId }).where(eq(changeOrder.id, co.id));
    return { invoiceCreated: invoiceId !== null };
  });
}
