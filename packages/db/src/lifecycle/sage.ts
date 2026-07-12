import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { usdCents, parseEstimateConfig, type SageDigestItem } from "@savvy/core";
import { withTenant } from "../tenant";
import {
  user,
  sageDigest,
  sageRemoteAction,
  invoice,
  job,
  customer,
  jobChecklistItem,
  estimate,
  creditRequest,
  tenant,
} from "../schema/index";
import type { SageDigestItemRow } from "../schema/sage";

const ADMIN_ROLES = ["owner", "admin"] as const;

/** Match a phone to an org-admin user. verifiedOnly gates on a completed one-time verification. */
export async function userByPhone(
  tenantId: string,
  phone: string,
  opts: { verifiedOnly?: boolean } = {},
): Promise<{ id: string; role: string; name: string } | null> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ id: user.id, role: user.role, name: user.name })
      .from(user)
      .where(
        and(
          eq(user.phone, phone),
          inArray(user.role, [...ADMIN_ROLES]),
          ...(opts.verifiedOnly ? [sql`${user.phoneVerifiedAt} is not null`] : []),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

/** Store a pending one-time verification challenge on an admin user. */
export async function startPhoneVerification(
  tenantId: string,
  userId: string,
  code: string,
  expiresAt: Date,
): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.update(user).set({ phoneVerifyCode: code, phoneVerifyExpiresAt: expiresAt }).where(eq(user.id, userId)),
  );
}

/** Confirm a code for a phone; on success marks the number verified and clears the challenge. */
export async function confirmPhoneVerification(
  tenantId: string,
  phone: string,
  code: string,
  now: Date,
): Promise<{ userId: string } | null> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ id: user.id })
      .from(user)
      .where(
        and(
          eq(user.phone, phone),
          inArray(user.role, [...ADMIN_ROLES]),
          eq(user.phoneVerifyCode, code),
          sql`${user.phoneVerifyExpiresAt} is not null and ${user.phoneVerifyExpiresAt} > ${now}`,
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    await tx
      .update(user)
      .set({ phoneVerifiedAt: now, phoneVerifyCode: null, phoneVerifyExpiresAt: null })
      .where(eq(user.id, row.id));
    return { userId: row.id };
  });
}

/** Persist a numbered digest for an owner, superseding their prior active one. */
export async function saveSageDigest(
  tenantId: string,
  userId: string,
  items: SageDigestItemRow[],
): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    await tx
      .update(sageDigest)
      .set({ supersededAt: new Date() })
      .where(and(eq(sageDigest.userId, userId), isNull(sageDigest.supersededAt)));
    const [row] = await tx.insert(sageDigest).values({ tenantId, userId, items }).returning({ id: sageDigest.id });
    return row!.id;
  });
}

/** The owner's current numbered digest (latest un-superseded), or null. */
export async function getActiveSageDigest(
  tenantId: string,
  userId: string,
): Promise<{ id: string; items: SageDigestItemRow[] } | null> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ id: sageDigest.id, items: sageDigest.items })
      .from(sageDigest)
      .where(and(eq(sageDigest.userId, userId), isNull(sageDigest.supersededAt)))
      .orderBy(desc(sageDigest.createdAt))
      .limit(1);
    return rows[0] ?? null;
  });
}

/** Log an SMS/voice-initiated Sage action (evidence). Returns the row id. */
export async function recordSageRemoteAction(input: {
  tenantId: string;
  userId: string | null;
  phone: string;
  digestId?: string | null;
  n?: number | null;
  kind: string;
  exceptionRef?: string | null;
  action?: string | null;
  confirmationState: string;
  verified: boolean;
  result?: string | null;
  resolvedAt?: Date | null;
}): Promise<string> {
  return withTenant(input.tenantId, async (tx) => {
    const [row] = await tx
      .insert(sageRemoteAction)
      .values({
        tenantId: input.tenantId,
        userId: input.userId ?? null,
        phone: input.phone,
        digestId: input.digestId ?? null,
        n: input.n ?? null,
        kind: input.kind,
        exceptionRef: input.exceptionRef ?? null,
        action: input.action ?? null,
        confirmationState: input.confirmationState,
        verified: input.verified,
        result: input.result ?? null,
        resolvedAt: input.resolvedAt ?? null,
      })
      .returning({ id: sageRemoteAction.id });
    return row!.id;
  });
}

/** For idempotency: has digest item N already been executed? */
export async function findResolvedAction(
  tenantId: string,
  digestId: string,
  n: number,
): Promise<{ resolvedAt: Date; result: string | null } | null> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ resolvedAt: sageRemoteAction.resolvedAt, result: sageRemoteAction.result })
      .from(sageRemoteAction)
      .where(
        and(
          eq(sageRemoteAction.digestId, digestId),
          eq(sageRemoteAction.n, n),
          inArray(sageRemoteAction.confirmationState, ["immediate", "confirmed"]),
          sql`${sageRemoteAction.resolvedAt} is not null`,
        ),
      )
      .orderBy(desc(sageRemoteAction.resolvedAt))
      .limit(1);
    const row = rows[0];
    if (!row?.resolvedAt) return null;
    return { resolvedAt: row.resolvedAt, result: row.result };
  });
}

/** The owner's outstanding money confirm, if any. */
export async function getPendingConfirm(
  tenantId: string,
  userId: string,
): Promise<{ id: string; digestId: string | null; n: number | null; action: string | null; exceptionRef: string | null; kind: string } | null> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: sageRemoteAction.id,
        digestId: sageRemoteAction.digestId,
        n: sageRemoteAction.n,
        action: sageRemoteAction.action,
        exceptionRef: sageRemoteAction.exceptionRef,
        kind: sageRemoteAction.kind,
      })
      .from(sageRemoteAction)
      .where(and(eq(sageRemoteAction.userId, userId), eq(sageRemoteAction.confirmationState, "pending")))
      .orderBy(desc(sageRemoteAction.createdAt))
      .limit(1);
    return rows[0] ?? null;
  });
}

/** Resolve a pending confirm to confirmed (YES) or rejected (NO). */
export async function resolvePendingConfirm(
  tenantId: string,
  id: string,
  state: "confirmed" | "rejected",
  result: string | null,
  now: Date,
): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.update(sageRemoteAction).set({ confirmationState: state, result, resolvedAt: now }).where(eq(sageRemoteAction.id, id)),
  );
}

/**
 * The handler-backed exceptions a verified owner can resolve by reply, with the
 * underlying entity ids the ExceptionQueue normalizes away. Ranked money-first,
 * capped so the SMS stays sane.
 */
export async function loadSageActionables(tenantId: string): Promise<SageDigestItem[]> {
  return withTenant(tenantId, async (tx) => {
    const out: SageDigestItem[] = [];

    // Overdue invoices → send_invoice
    const invRows = await tx
      .select({ id: invoice.id, jobId: invoice.jobId, amountDue: invoice.amountDue, name: customer.name })
      .from(invoice)
      .leftJoin(customer, eq(customer.id, invoice.customerId))
      .where(
        or(
          eq(invoice.status, "overdue"),
          sql`${invoice.status} = 'sent' and ${invoice.dueAt} is not null and ${invoice.dueAt} < now() and coalesce(${invoice.amountPaid},0) < coalesce(${invoice.amountDue},0)`,
        ),
      );
    for (const r of invRows) {
      out.push({
        kind: "invoice_overdue",
        entityId: r.id,
        jobId: r.jobId,
        title: r.name ?? "—",
        detail: `invoice overdue · ${usdCents(r.amountDue ?? 0)}`,
        action: "send_invoice",
        confirmAmountCents: r.amountDue ?? null,
      });
    }

    // Parked estimates awaiting approval → approve_estimate (drafts over the tenant threshold)
    const [t] = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
    const estCfg = parseEstimateConfig((t?.settings as { estimate?: unknown } | undefined)?.estimate);
    if (estCfg.approvalThresholdCents !== null) {
      const estRows = await tx
        .select({ id: estimate.id, jobId: estimate.jobId, total: estimate.total, name: customer.name })
        .from(estimate)
        .leftJoin(job, eq(job.id, estimate.jobId))
        .leftJoin(customer, eq(customer.id, job.customerId))
        .where(
          and(
            eq(estimate.status, "draft"),
            sql`${estimate.jobId} is not null`,
            sql`${estimate.total} is not null and ${estimate.total} > ${estCfg.approvalThresholdCents}`,
          ),
        );
      for (const r of estRows) {
        out.push({
          kind: "estimate_approval",
          entityId: r.id,
          jobId: r.jobId,
          title: r.name ?? "—",
          detail: `estimate ${usdCents(r.total ?? 0)}`,
          action: "approve_estimate",
          confirmAmountCents: r.total ?? null,
        });
      }
    }

    // Drafted credit requests → send_credit
    const creditRows = await tx
      .select({ id: creditRequest.id, jobId: creditRequest.jobId, supplierName: creditRequest.supplierName, claimedCents: creditRequest.claimedCents })
      .from(creditRequest)
      .where(eq(creditRequest.status, "drafted"));
    for (const r of creditRows) {
      out.push({
        kind: "supplier_credit_review",
        entityId: r.id,
        jobId: r.jobId,
        title: r.supplierName ?? "credit request",
        detail: `credit ${usdCents(r.claimedCents)} — ${r.supplierName ?? "supplier"}`,
        action: "send_credit",
        confirmAmountCents: null,
      });
    }

    // Overdue manual tasks → complete_task
    const taskRows = await tx
      .select({ id: jobChecklistItem.id, jobId: jobChecklistItem.jobId, title: jobChecklistItem.title, name: customer.name })
      .from(jobChecklistItem)
      .leftJoin(job, eq(job.id, jobChecklistItem.jobId))
      .leftJoin(customer, eq(customer.id, job.customerId))
      .where(sql`${jobChecklistItem.dueAt} is not null and ${jobChecklistItem.dueAt} < now() and ${jobChecklistItem.status} not in ('done','skipped')`);
    for (const r of taskRows) {
      out.push({
        kind: "task_overdue",
        entityId: r.id,
        jobId: r.jobId,
        title: r.name ?? "—",
        detail: `task overdue: ${r.title}`,
        action: "complete_task",
        confirmAmountCents: null,
      });
    }

    // Money-first, cap the list so the digest SMS stays readable.
    out.sort((a, b) => (b.confirmAmountCents ?? -1) - (a.confirmAmountCents ?? -1));
    return out.slice(0, 8);
  });
}
