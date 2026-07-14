// Production Pulse slice 2: the homeowner-update machinery. The customer-safe
// flag is SACRED and independent of QC — a photo reaches the homeowner only
// when it is BOTH QC-passed AND customer-safe (the double gate IS the approval;
// no per-message human sign-off). Every send or suppression lands in the
// production_update ledger — the evidence checks and the daily throttle read it.

import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { withTenant } from "../tenant";
import { document, productionPhase, productionMedia, productionUpdate, materialOrder } from "../schema/index";

const HOMEOWNER_SHARE = "homeowner";

/** Add/remove the customer-safe marker inside document.sharedWith. Idempotent. */
export async function setPhotoCustomerSafe(input: {
  tenantId: string;
  documentId: string;
  safe: boolean;
}): Promise<void> {
  await withTenant(input.tenantId, async (tx) => {
    if (input.safe) {
      await tx.update(document)
        .set({ sharedWith: sql`(select jsonb_agg(distinct v) from jsonb_array_elements(${document.sharedWith} || ${JSON.stringify([HOMEOWNER_SHARE])}::jsonb) as t(v))` })
        .where(eq(document.id, input.documentId));
    } else {
      await tx.update(document)
        .set({ sharedWith: sql`coalesce((select jsonb_agg(v) from jsonb_array_elements(${document.sharedWith}) as t(v) where v != ${JSON.stringify(HOMEOWNER_SHARE)}::jsonb), '[]'::jsonb)` })
        .where(eq(document.id, input.documentId));
    }
  });
}

/** THE double gate: QC-passed AND customer-safe photos of one phase, newest last. */
export async function doubleGatedPhotosForPhase(input: {
  tenantId: string;
  jobId: string;
  phaseKey: string;
  limit?: number;
}): Promise<{ documentId: string; r2Key: string | null }[]> {
  return withTenant(input.tenantId, async (tx) => {
    const rows = await tx.select({ documentId: productionMedia.documentId, r2Key: document.r2Key })
      .from(productionMedia)
      .innerJoin(productionPhase, eq(productionMedia.productionPhaseId, productionPhase.id))
      .innerJoin(document, eq(productionMedia.documentId, document.id))
      .where(and(
        eq(productionPhase.jobId, input.jobId),
        eq(productionPhase.phaseKey, input.phaseKey),
        eq(document.qcStatus, "passed"),
        sql`${document.sharedWith} @> ${JSON.stringify([HOMEOWNER_SHARE])}::jsonb`,
      ))
      .orderBy(productionMedia.createdAt)
      .limit(input.limit ?? 3);
    return rows;
  });
}

export async function recordProductionUpdate(input: {
  tenantId: string;
  jobId: string;
  kind: string;
  phaseKey?: string | null;
  body?: string | null;
  photoIds?: string[];
  sentAt?: Date | null;
  suppressedReason?: string | null;
}): Promise<{ updateId: string }> {
  return withTenant(input.tenantId, async (tx) => {
    const [row] = await tx.insert(productionUpdate).values({
      tenantId: input.tenantId,
      jobId: input.jobId,
      kind: input.kind,
      phaseKey: input.phaseKey ?? null,
      body: input.body ?? null,
      photoIds: input.photoIds ?? [],
      sentAt: input.sentAt ?? null,
      suppressedReason: input.suppressedReason ?? null,
    }).returning({ id: productionUpdate.id });
    return { updateId: row!.id };
  });
}

/** The max-N/day throttle counts SENT updates only (suppressions are free). */
export async function countUpdatesSentToday(input: {
  tenantId: string;
  jobId: string;
  now?: Date;
}): Promise<number> {
  const now = input.now ?? new Date();
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  return withTenant(input.tenantId, async (tx) => {
    const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(productionUpdate)
      .where(and(
        eq(productionUpdate.jobId, input.jobId),
        isNotNull(productionUpdate.sentAt),
        gte(productionUpdate.sentAt, dayStart),
      ));
    return row?.count ?? 0;
  });
}

/** production.ho_updates evidence: every customer-visible DONE phase produced a
 *  homeowner update or a logged suppression. Must be empty. */
export async function hoUpdateGaps(tenantId: string): Promise<{ jobId: string; phaseKey: string }[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({ jobId: productionPhase.jobId, phaseKey: productionPhase.phaseKey })
      .from(productionPhase)
      .where(and(
        inArray(productionPhase.status, ["done", "verified"]),
        eq(productionPhase.customerVisible, true),
        sql`not exists (
          select 1 from ${productionUpdate} u
          where u.job_id = ${productionPhase.jobId}
            and u.kind = 'phase_complete'
            and u.phase_key = ${productionPhase.phaseKey}
        )`,
      )),
  );
}

/** production.delivery_notice evidence: every open scheduled delivery has both
 *  sends (or logged suppressions). Must be empty by the time delivery arrives. */
export async function deliveryNoticeGaps(tenantId: string): Promise<{ jobId: string; missing: string[] }[]> {
  return withTenant(tenantId, async (tx) => {
    const orders = await tx.select({ jobId: materialOrder.jobId }).from(materialOrder)
      .where(and(inArray(materialOrder.status, ["ordered", "delivered"]), isNotNull(materialOrder.neededByAt)));
    const out: { jobId: string; missing: string[] }[] = [];
    for (const o of orders) {
      if (!o.jobId) continue;
      const updates = await tx.select({ kind: productionUpdate.kind }).from(productionUpdate)
        .where(and(eq(productionUpdate.jobId, o.jobId), inArray(productionUpdate.kind, ["delivery_3day", "delivery_eve"])));
      const have = new Set(updates.map((u) => u.kind));
      const missing = ["delivery_3day", "delivery_eve"].filter((k) => !have.has(k));
      if (missing.length) out.push({ jobId: o.jobId, missing });
    }
    return out;
  });
}

/** The status-page story: double-gated photos grouped by tenant-local day —
 *  multi-day jobs read as a day-by-day narrative, never a flat dump. */
export async function statusGalleryForJob(input: {
  tenantId: string;
  jobId: string;
}): Promise<{ day: string; photos: { documentId: string; r2Key: string | null; phaseKey: string | null }[] }[]> {
  return withTenant(input.tenantId, async (tx) => {
    const rows = await tx.select({
      documentId: productionMedia.documentId,
      r2Key: document.r2Key,
      phaseKey: productionMedia.phaseKeyRaw,
      createdAt: productionMedia.createdAt,
    }).from(productionMedia)
      .innerJoin(document, eq(productionMedia.documentId, document.id))
      .where(and(
        eq(productionMedia.jobId, input.jobId),
        eq(document.qcStatus, "passed"),
        sql`${document.sharedWith} @> '["homeowner"]'::jsonb`,
      ))
      .orderBy(productionMedia.createdAt);
    const byDay = new Map<string, { documentId: string; r2Key: string | null; phaseKey: string | null }[]>();
    for (const r of rows) {
      const day = r.createdAt.toISOString().slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push({ documentId: r.documentId, r2Key: r.r2Key, phaseKey: r.phaseKey });
    }
    return [...byDay.entries()].map(([day, photos]) => ({ day, photos }));
  });
}
