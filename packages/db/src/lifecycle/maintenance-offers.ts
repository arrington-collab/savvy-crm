import { and, eq, gt, inArray, isNotNull, isNull, lt, notInArray, sql } from "drizzle-orm";
import { parseMaintenanceConfig } from "@savvy/core";
import { withTenant } from "../tenant";
import { adminDb } from "../admin-client";
import { estimate } from "../schema/finance";
import { inspection } from "../schema/inspection";
import { job } from "../schema/jobs";
import { lead } from "../schema/crm";
import { membership } from "../schema/membership";
import { tenant as tenantTbl } from "../schema/tenancy";
import { scheduleRelationshipTouch } from "./relationship-touch";
import { maintenanceMrrCents } from "./membership";

// Phase 20 S2 (#306, #310) — enrollment offers + churn watch. Every outbound
// is a governor-admitted relationship touch (refusals live in the ledger);
// sourceRef dedupe makes the sweep idempotent. Valley-cleaning funnel
// graduates are a Wave-2 source — the sweep gains that query when the Strike
// List machinery exists; nothing is faked meanwhile.

const D = 86_400_000;
const LIVE = ["draft", "pending", "active", "past_due"];

export type MaintenanceSweepResult = { offers: number; renewals: number; winbacks: number };

export async function runMaintenanceOfferSweep(tenantId: string, now = new Date()): Promise<MaintenanceSweepResult> {
  const [t] = await adminDb.select({ settings: tenantTbl.settings }).from(tenantTbl).where(eq(tenantTbl.id, tenantId));
  const cfg = parseMaintenanceConfig((t?.settings as { maintenance?: unknown } | null)?.maintenance);
  if (!cfg.enabled) return { offers: 0, renewals: 0, winbacks: 0 };

  return withTenant(tenantId, async (tx) => {
    const memberCustomerIds = (await tx.select({ customerId: membership.customerId }).from(membership)
      .where(and(eq(membership.tenantId, tenantId), inArray(membership.status, LIVE))))
      .map((m) => m.customerId);
    const isMember = new Set(memberCustomerIds);

    let offers = 0;
    const offer = async (customerId: string, program: string, sourceRef: string) => {
      const verdict = await scheduleRelationshipTouch({
        tenantId, customerId, program, channel: "text", scheduledFor: now, sourceRef, now,
      });
      return "touchId" in verdict && !verdict.existing ? 1 : 0;
    };

    // ── Source 1: completed jobs past the offer delay (#306 post-job) ──
    const completedBefore = new Date(now.getTime() - cfg.offerAfterCompletionDays * D);
    const doneJobs = await tx.select({ jobId: job.id, customerId: job.customerId }).from(job).where(and(
      eq(job.tenantId, tenantId), eq(job.stage, "complete"),
      isNotNull(job.closedAt), lt(job.closedAt, completedBefore),
    ));
    for (const j of doneJobs) {
      if (isMember.has(j.customerId)) continue;
      offers += await offer(j.customerId, "maintenance_offer", `maintenance_offer:job:${j.jobId}`);
    }

    // ── Source 2: inspection-no-sale leads (#306) ──
    const inspBefore = new Date(now.getTime() - cfg.inspectionNoSaleAfterDays * D);
    const noSale = await tx.select({ inspectionId: inspection.id, leadId: inspection.leadId }).from(inspection).where(and(
      eq(inspection.tenantId, tenantId), eq(inspection.status, "published"),
      isNotNull(inspection.leadId), isNotNull(inspection.completedAt), lt(inspection.completedAt, inspBefore),
    ));
    for (const i of noSale) {
      const [accepted] = await tx.select({ id: estimate.id }).from(estimate)
        .where(and(eq(estimate.leadId, i.leadId!), isNotNull(estimate.acceptedAt))).limit(1);
      if (accepted) continue;
      const [l] = await tx.select({ customerId: lead.customerId }).from(lead).where(eq(lead.id, i.leadId!));
      if (!l?.customerId || isMember.has(l.customerId)) continue;
      offers += await offer(l.customerId, "maintenance_offer", `maintenance_offer:insp:${i.inspectionId}`);
    }

    // ── Renewal drips (#310): anniversary inside the lead window ──
    let renewals = 0;
    const actives = await tx.select({ id: membership.id, customerId: membership.customerId, startedAt: membership.startedAt })
      .from(membership).where(and(eq(membership.tenantId, tenantId), eq(membership.status, "active"), isNotNull(membership.startedAt)));
    for (const m of actives) {
      const started = m.startedAt!.getTime();
      const yearsElapsed = Math.max(1, Math.ceil((now.getTime() - started) / (365 * D)));
      const nextRenewal = started + yearsElapsed * 365 * D;
      if (nextRenewal - now.getTime() <= cfg.renewalLeadDays * D && nextRenewal > now.getTime()) {
        renewals += await offer(m.customerId, "maintenance_renewal", `maintenance_renewal:${m.id}:${yearsElapsed}`);
      }
    }

    // ── Winback (#310): lapsed members past the winback delay ──
    let winbacks = 0;
    const lapsedBefore = new Date(now.getTime() - cfg.winbackAfterDays * D);
    const lapsed = await tx.select({ id: membership.id, customerId: membership.customerId }).from(membership).where(and(
      eq(membership.tenantId, tenantId), eq(membership.status, "canceled"),
      isNotNull(membership.canceledAt), lt(membership.canceledAt, lapsedBefore),
      memberCustomerIds.length > 0 ? notInArray(membership.customerId, memberCustomerIds) : sql`true`,
    ));
    for (const m of lapsed) {
      winbacks += await offer(m.customerId, "maintenance_winback", `maintenance_winback:${m.id}`);
    }

    return { offers, renewals, winbacks };
  });
}

export type MaintenanceChurnStats = {
  activeCount: number; newThisMonth30d: number; canceledThisMonth30d: number;
  topCancelReason: string | null; mrrCents: number;
};

/** Churn-watch numbers for the digest (#310). */
export async function maintenanceChurnStats(tenantId: string, now: Date): Promise<MaintenanceChurnStats> {
  const monthAgo = new Date(now.getTime() - 30 * D);
  const stats = await withTenant(tenantId, async (tx) => {
    const rows = await tx.select({
      status: membership.status, startedAt: membership.startedAt,
      canceledAt: membership.canceledAt, cancellationReason: membership.cancellationReason,
    }).from(membership).where(eq(membership.tenantId, tenantId));
    const canceledRecent = rows.filter((r) => r.status === "canceled" && r.canceledAt && r.canceledAt > monthAgo);
    const reasons = new Map<string, number>();
    for (const r of canceledRecent) {
      if (r.cancellationReason) reasons.set(r.cancellationReason, (reasons.get(r.cancellationReason) ?? 0) + 1);
    }
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return {
      activeCount: rows.filter((r) => r.status === "active").length,
      newThisMonth30d: rows.filter((r) => r.status === "active" && r.startedAt && r.startedAt > monthAgo).length,
      canceledThisMonth30d: canceledRecent.length,
      topCancelReason: top,
    };
  });
  return { ...stats, mrrCents: await maintenanceMrrCents(tenantId) };
}
