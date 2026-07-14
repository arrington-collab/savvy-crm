// Estimate Experience slice 5b: video linkage + the day-after batch queues.

import { and, eq, gte, lt, isNull, desc, inArray } from "drizzle-orm";
import { withTenant } from "../tenant";
import { estimate, estimateVideo, estimateEvent } from "../schema/finance";
import { lead, customer, property } from "../schema/crm";
import { user, tenant } from "../schema/tenancy";
import { adminDb } from "../admin-client";
import { buildVideoQueueItem, pickDeliveryVideo, parseOwnerVideoConfig, type QueueTier, type VideoQueueItem, type TierEstimate } from "@savvy/core";

export async function attachEstimateVideo(input: {
  tenantId: string;
  estimateId: string;
  role: "rep" | "owner";
  documentId: string;
  capturedByUserId?: string | null;
  approved?: boolean;
}): Promise<{ id: string }> {
  return withTenant(input.tenantId, async (tx) => {
    const [row] = await tx
      .insert(estimateVideo)
      .values({
        tenantId: input.tenantId,
        estimateId: input.estimateId,
        role: input.role,
        documentId: input.documentId,
        capturedByUserId: input.capturedByUserId ?? null,
        approvedAt: input.approved ? new Date() : null,
      })
      .returning({ id: estimateVideo.id });
    return row!;
  });
}

export async function videosForEstimate(tenantId: string, estimateId: string) {
  return withTenant(tenantId, (tx) =>
    tx.select().from(estimateVideo).where(eq(estimateVideo.estimateId, estimateId)).orderBy(desc(estimateVideo.createdAt)),
  );
}

async function estimateContext(tx: Parameters<Parameters<typeof withTenant>[1]>[0], est: typeof estimate.$inferSelect) {
  let customerName = "Homeowner";
  let city: string | null = null;
  let repName: string | null = null;
  let isInsurance = est.source === "carrier";
  if (est.leadId) {
    const [l] = await tx
      .select({ customerId: lead.customerId, assignedUserId: lead.assignedUserId, source: lead.source })
      .from(lead)
      .where(eq(lead.id, est.leadId));
    if (l?.source?.toLowerCase().includes("insurance")) isInsurance = true;
    if (l?.customerId) {
      const [c] = await tx.select({ name: customer.name }).from(customer).where(eq(customer.id, l.customerId));
      customerName = c?.name ?? customerName;
    }
    if (l?.assignedUserId) {
      const [u] = await tx.select({ name: user.name }).from(user).where(eq(user.id, l.assignedUserId));
      repName = u?.name ?? null;
    }
  }
  if (est.propertyId) {
    const [p] = await tx.select({ city: property.city }).from(property).where(eq(property.id, est.propertyId));
    city = p?.city ?? null;
  }
  return { customerName, city, repName, isInsurance };
}

export interface VideoBatchEntry {
  estimateId: string;
  item: VideoQueueItem;
}

/** The recording queue: yesterday's sent estimates (last 48h) that don't have
 *  an owner take yet — everything on the card, zero lookup. */
export async function videoBatchQueue(tenantId: string, now = new Date()): Promise<VideoBatchEntry[]> {
  return withTenant(tenantId, async (tx) => {
    const since = new Date(now.getTime() - 48 * 3_600_000);
    const sent = await tx
      .select()
      .from(estimate)
      .where(and(eq(estimate.status, "sent"), gte(estimate.sentAt, since), isNull(estimate.acceptedAt)));
    if (sent.length === 0) return [];

    const withOwnerTake = new Set(
      (
        await tx
          .select({ estimateId: estimateVideo.estimateId })
          .from(estimateVideo)
          .where(and(inArray(estimateVideo.estimateId, sent.map((e) => e.id)), eq(estimateVideo.role, "owner")))
      ).map((r) => r.estimateId),
    );

    const out: VideoBatchEntry[] = [];
    for (const est of sent) {
      if (withOwnerTake.has(est.id)) continue;
      const ctx = await estimateContext(tx, est);
      const [q] = await tx
        .select({ meta: estimateEvent.meta })
        .from(estimateEvent)
        .where(and(eq(estimateEvent.estimateId, est.id), eq(estimateEvent.kind, "question")))
        .orderBy(desc(estimateEvent.createdAt))
        .limit(1);
      const tiers = ((est.tiers ?? []) as unknown as TierEstimate[]).map(
        (t): QueueTier => ({ tier: t.tier, productName: t.productName, subtotalCents: t.subtotalCents, recommended: t.recommended }),
      );
      out.push({
        estimateId: est.id,
        item: buildVideoQueueItem({
          customerName: ctx.customerName,
          repName: ctx.repName,
          city: ctx.city,
          selectedTier: est.selectedTier,
          tiers,
          isInsurance: ctx.isInsurance,
          recentQuestion: (q?.meta as { question?: string } | undefined)?.question ?? null,
        }),
      });
    }
    return out;
  });
}

export interface VideoDeliveryEntry {
  estimateId: string;
  documentId: string;
  personalized: boolean;
  customerPhone: string | null;
  repName: string | null;
}

/** Day-after delivery picks: estimates sent 20–48h ago, not yet delivered
 *  (video_sent event = once per estimate, ever), personalized-first. */
export async function ownerVideoDeliveryQueue(
  tenantId: string,
  genericDocumentId: string | null,
  now = new Date(),
): Promise<VideoDeliveryEntry[]> {
  return withTenant(tenantId, async (tx) => {
    const newest = new Date(now.getTime() - 20 * 3_600_000);
    const oldest = new Date(now.getTime() - 48 * 3_600_000);
    const sent = await tx
      .select()
      .from(estimate)
      .where(and(eq(estimate.status, "sent"), gte(estimate.sentAt, oldest), lt(estimate.sentAt, newest)));
    if (sent.length === 0) return [];

    const out: VideoDeliveryEntry[] = [];
    for (const est of sent) {
      const already = await tx
        .select({ id: estimateEvent.id })
        .from(estimateEvent)
        .where(and(eq(estimateEvent.estimateId, est.id), eq(estimateEvent.kind, "video_sent")))
        .limit(1);
      if (already.length > 0) continue;

      const vids = await tx
        .select({ role: estimateVideo.role, approvedAt: estimateVideo.approvedAt, documentId: estimateVideo.documentId })
        .from(estimateVideo)
        .where(eq(estimateVideo.estimateId, est.id));
      const pick = pickDeliveryVideo(vids, genericDocumentId);
      if (!pick) continue;

      const ctx = await estimateContext(tx, est);
      let customerPhone: string | null = null;
      if (est.leadId) {
        const [l] = await tx.select({ customerId: lead.customerId }).from(lead).where(eq(lead.id, est.leadId));
        if (l?.customerId) {
          const [c] = await tx.select({ phone: customer.phone, smsOptOut: customer.smsOptOut }).from(customer).where(eq(customer.id, l.customerId));
          customerPhone = c && !c.smsOptOut ? c.phone : null;
        }
      }
      out.push({ estimateId: est.id, documentId: pick.documentId, personalized: pick.personalized, customerPhone, repName: ctx.repName });
    }
    return out;
  });
}

/** Tenant's ownerVideo config, read where only the tenantId is at hand. */
export async function parseOwnerVideoConfigRow(tenantId: string): Promise<{ genericDocumentId: string | null }> {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  return parseOwnerVideoConfig((t?.settings as { ownerVideo?: unknown } | null)?.ownerVideo);
}
