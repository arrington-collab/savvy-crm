import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { CreditRequestStatus } from "@savvy/core";
import { withTenant } from "../tenant";
import { creditRequest } from "../schema/index";

/** Create a credit request (drafted or sent) with its overage evidence. */
export async function createCreditRequest(tenantId: string, input: {
  supplierInvoiceId: string; jobId: string | null; supplierName: string | null;
  claimedCents: number; status: CreditRequestStatus; evidence: unknown; emailMessageId?: string | null;
}): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.insert(creditRequest).values({
      tenantId, supplierInvoiceId: input.supplierInvoiceId, jobId: input.jobId, supplierName: input.supplierName,
      claimedCents: input.claimedCents, status: input.status, evidence: input.evidence,
      emailMessageId: input.emailMessageId ?? null, sentAt: input.status === "sent" ? new Date() : null,
    }).returning({ id: creditRequest.id });
    return { id: row!.id };
  });
}

/** Stamp the sent email id + sentAt (used when a draft is later sent, or to record proof). */
export async function setCreditRequestSent(tenantId: string, id: string, opts: { emailMessageId: string | null }): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.update(creditRequest).set({ status: "sent", emailMessageId: opts.emailMessageId, sentAt: new Date(), updatedAt: new Date() }).where(eq(creditRequest.id, id)),
  );
}

/** Open (sent, unresolved) requests for a supplier — the credit-memo reconcile candidates. */
export async function listOpenSentCreditRequests(tenantId: string, supplierName: string | null): Promise<{ id: string; supplierName: string | null; claimedCents: number }[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({ id: creditRequest.id, supplierName: creditRequest.supplierName, claimedCents: creditRequest.claimedCents })
      .from(creditRequest)
      .where(and(
        eq(creditRequest.tenantId, tenantId),
        eq(creditRequest.status, "sent"),
        ...(supplierName ? [eq(creditRequest.supplierName, supplierName)] : []),
      )),
  );
}

/** Recovery: a matched credit memo closes the request. */
export async function markCreditRequestCredited(tenantId: string, id: string, recoveredCents: number): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.update(creditRequest).set({ status: "credited", recoveredCents, resolvedAt: new Date(), updatedAt: new Date() }).where(eq(creditRequest.id, id)),
  );
}

/** Drafted (not yet sent) credit requests — Today "review & send" cards. */
export async function listDraftedCreditRequests(tenantId: string): Promise<{ id: string; jobId: string | null; supplierName: string | null; claimedCents: number; createdAt: Date }[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({ id: creditRequest.id, jobId: creditRequest.jobId, supplierName: creditRequest.supplierName, claimedCents: creditRequest.claimedCents, createdAt: creditRequest.createdAt })
      .from(creditRequest)
      .where(eq(creditRequest.status, "drafted")),
  );
}

/** Digest buckets: recovered $ (credited, resolved in window) + pending recovery ($ sent, awaiting). */
export async function getCreditRecoverySummary(tenantId: string, window: { start: Date; end: Date }): Promise<{ recoveredCents: number; pendingCents: number }> {
  return withTenant(tenantId, async (tx) => {
    const [rec] = await tx.select({ total: sql<number>`coalesce(sum(${creditRequest.recoveredCents}), 0)::int` })
      .from(creditRequest)
      .where(and(eq(creditRequest.tenantId, tenantId), eq(creditRequest.status, "credited"), gte(creditRequest.resolvedAt, window.start), lte(creditRequest.resolvedAt, window.end)));
    const [pend] = await tx.select({ total: sql<number>`coalesce(sum(${creditRequest.claimedCents}), 0)::int` })
      .from(creditRequest)
      .where(and(eq(creditRequest.tenantId, tenantId), eq(creditRequest.status, "sent")));
    return { recoveredCents: rec?.total ?? 0, pendingCents: pend?.total ?? 0 };
  });
}
