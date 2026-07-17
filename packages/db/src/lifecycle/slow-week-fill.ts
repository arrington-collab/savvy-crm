import { and, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import {
  applyFillDiscount, detectCrewGapWindows, parseSlowWeekFillConfig, parseSchedulingConfig,
  type FillDiscountLine,
} from "@savvy/core";
import { withTenant } from "../tenant";
import { adminDb } from "../admin-client";
import { appointment } from "../schema/comms";
import { crew } from "../schema/crew";
import { crewGap, fillPlay } from "../schema/fill";
import { estimate } from "../schema/finance";
import { lead } from "../schema/crm";
import { priceBookItem } from "../schema/pricing";
import { repairCredit } from "../schema/inspection";
import { relationshipTouch } from "../schema/relationship";
import { tenant as tenantTbl } from "../schema/tenancy";
import { scheduleRelationshipTouch } from "./relationship-touch";

// Phase 26 slice 5 (#351, #352) — the slow-week fill loop. The capacity
// look-ahead turns idle crew days into crew_gap rows, and each gap gets fill
// plays through the EXISTING rails: the touch governor admits/refuses every
// outbound, the margin floor re-runs on discounted totals, and an
// over-threshold discount parks as a pending_approval card. INVARIANT:
// every gap ends 'planned' or 'passed' — never silently open.

function dayKeyInTz(d: Date, tz: string): string {
  return d.toLocaleDateString("en-CA", { timeZone: tz });
}

export type FillSweepResult = { gapsDetected: number; playsCreated: number; passes: number };

export async function runFillSweep(tenantId: string, now = new Date()): Promise<FillSweepResult> {
  const [t] = await adminDb.select({ settings: tenantTbl.settings, timezone: tenantTbl.timezone })
    .from(tenantTbl).where(eq(tenantTbl.id, tenantId));
  const settings = (t?.settings ?? {}) as { slowWeekFill?: unknown; scheduling?: unknown; estimates?: { marginFloorBps?: number } };
  const cfg = parseSlowWeekFillConfig(settings.slowWeekFill);
  if (!cfg.enabled) return { gapsDetected: 0, playsCreated: 0, passes: 0 };
  const schedCfg = parseSchedulingConfig(settings.scheduling);
  const tz = t?.timezone ?? "America/Phoenix";

  // Look-ahead window as civil dates in the tenant's timezone.
  const civilDates: string[] = [];
  for (let i = 0; i < cfg.gapLookaheadDays; i++) {
    civilDates.push(dayKeyInTz(new Date(now.getTime() + i * 86_400_000), tz));
  }
  const windowEnd = new Date(now.getTime() + cfg.gapLookaheadDays * 86_400_000);

  return withTenant(tenantId, async (tx) => {
    const crews = await tx.select({ crewId: crew.id, name: crew.name })
      .from(crew).where(and(eq(crew.tenantId, tenantId), eq(crew.active, true)));
    if (crews.length === 0) return { gapsDetected: 0, playsCreated: 0, passes: 0 };

    // Scheduled crew-appointment minutes per crew per civil day. Crew installs
    // are day-scoped, so the whole appointment lands on its start date.
    const appts = await tx.select({ crewId: appointment.crewId, startsAt: appointment.startsAt, endsAt: appointment.endsAt })
      .from(appointment)
      .where(and(
        eq(appointment.tenantId, tenantId), eq(appointment.type, "crew"), eq(appointment.status, "scheduled"),
        inArray(appointment.crewId, crews.map((c) => c.crewId)),
        gt(appointment.endsAt, now), lt(appointment.startsAt, windowEnd),
      ));
    const loadMap = new Map<string, number>();
    for (const a of appts) {
      if (!a.crewId) continue;
      const day = dayKeyInTz(a.startsAt, tz);
      const key = `${a.crewId}:${day}`;
      const min = Math.max(0, Math.round((a.endsAt.getTime() - a.startsAt.getTime()) / 60_000));
      loadMap.set(key, (loadMap.get(key) ?? 0) + min);
    }
    const loads = [...loadMap.entries()].map(([key, scheduledMin]) => {
      const [crewId, civilDate] = [key.slice(0, 36), key.slice(37)];
      return { crewId: crewId!, name: "", civilDate: civilDate!, scheduledMin };
    });

    const windows = detectCrewGapWindows({
      config: schedCfg, civilDates, crews, loads, minUtilizationPct: cfg.minUtilizationPct,
    });

    // Upsert gaps — the partial unique index keeps one OPEN row per crew+start.
    const gapIds: string[] = [];
    for (const w of windows) {
      await tx.insert(crewGap).values({
        tenantId, crewId: w.crewId, gapStart: w.gapStart, gapEnd: w.gapEnd, freeMinutes: w.freeMinutes,
      }).onConflictDoNothing();
      const [row] = await tx.select({ id: crewGap.id }).from(crewGap).where(and(
        eq(crewGap.tenantId, tenantId), eq(crewGap.crewId, w.crewId),
        eq(crewGap.gapStart, w.gapStart), isNull(crewGap.resolvedAt),
      ));
      if (row) gapIds.push(row.id);
    }
    if (gapIds.length === 0) return { gapsDetected: 0, playsCreated: 0, passes: 0 };

    // Candidates are tenant-wide; plays attach to the earliest gap (the hole
    // being filled first). Remaining gaps pass with the invariant logged.
    const targetGapId = gapIds[0]!;
    let playsCreated = 0;

    // ── Play 1: aging unaccepted estimates get a this-week incentive ──
    const agingBefore = new Date(now.getTime() - cfg.agingEstimateDays * 86_400_000);
    const aging = await tx.select({
      id: estimate.id, leadId: estimate.leadId, lineItems: estimate.lineItems,
    }).from(estimate).where(and(
      eq(estimate.tenantId, tenantId), eq(estimate.status, "sent"),
      isNull(estimate.acceptedAt), lt(estimate.sentAt, agingBefore),
    ));

    if (aging.length > 0) {
      const book = await tx.select({
        key: priceBookItem.key, unitCostCents: priceBookItem.unitCostCents, marginFloorBps: priceBookItem.marginFloorBps,
      }).from(priceBookItem).where(and(eq(priceBookItem.tenantId, tenantId), isNull(priceBookItem.versionId)));
      const costByKey = new Map(book.map((b) => [b.key, b]));
      const defaultFloorBps = settings.estimates?.marginFloorBps ?? 2000;

      for (const est of aging) {
        const customerId = est.leadId
          ? (await tx.select({ customerId: lead.customerId }).from(lead).where(eq(lead.id, est.leadId)))[0]?.customerId
          : null;
        if (!customerId) continue;

        const lines: FillDiscountLine[] = (est.lineItems as { key: string; quantity: number; unitPriceCents: number }[])
          .map((l) => {
            const src = costByKey.get(l.key);
            return {
              key: l.key, quantity: l.quantity, unitPriceCents: l.unitPriceCents,
              unitCostCents: src?.unitCostCents ?? null, marginFloorBps: src?.marginFloorBps ?? undefined,
            };
          });
        const calc = applyFillDiscount({
          lines, requestedDiscountBps: cfg.discountBps, defaultMarginFloorBps: defaultFloorBps,
        });

        // Over-threshold discount ⇒ card, never a silent send.
        if (cfg.discountBps > cfg.maxAutoDiscountBps) {
          playsCreated += await insertPlay(tx, {
            tenantId, gapId: targetGapId, kind: "estimate_discount", targetRef: est.id,
            discountBps: cfg.discountBps, originalTotalCents: calc.originalTotalCents,
            discountedTotalCents: calc.discountedTotalCents, status: "pending_approval",
          });
          continue;
        }
        // Floor breach that even clamping can't fix ⇒ skipped, reason logged.
        if (!calc.sendable) {
          playsCreated += await insertPlay(tx, {
            tenantId, gapId: targetGapId, kind: "estimate_discount", targetRef: est.id,
            discountBps: 0, originalTotalCents: calc.originalTotalCents,
            discountedTotalCents: calc.originalTotalCents, status: "skipped", suppressedReason: "margin_floor",
          });
          continue;
        }
        const verdict = await scheduleRelationshipTouch({
          tenantId, customerId, program: "fill_discount", channel: "text", scheduledFor: now,
          sourceRef: `fill_discount:${est.id}`, now,
        });
        playsCreated += await insertPlay(tx, {
          tenantId, gapId: targetGapId, kind: "estimate_discount", targetRef: est.id,
          discountBps: calc.discountBps, originalTotalCents: calc.originalTotalCents,
          discountedTotalCents: calc.discountedTotalCents,
          status: "scheduled" in verdict && verdict.scheduled === false ? "suppressed" : "sent",
          suppressedReason: "scheduled" in verdict && verdict.scheduled === false ? verdict.reason : undefined,
        });
      }
    }

    // ── Play 2: open repair backlog offered scheduling ──
    const credits = await tx.select({ id: repairCredit.id, customerId: repairCredit.customerId })
      .from(repairCredit).where(and(
        eq(repairCredit.tenantId, tenantId), eq(repairCredit.status, "active"), gt(repairCredit.expiresAt, now),
      ));
    for (const rc of credits) {
      const verdict = await scheduleRelationshipTouch({
        tenantId, customerId: rc.customerId, program: "fill_repair", channel: "text", scheduledFor: now,
        sourceRef: `fill_repair:${rc.id}`, now,
      });
      playsCreated += await insertPlay(tx, {
        tenantId, gapId: targetGapId, kind: "repair_offer", targetRef: rc.id,
        status: "scheduled" in verdict && verdict.scheduled === false ? "suppressed" : "sent",
        suppressedReason: "scheduled" in verdict && verdict.scheduled === false ? verdict.reason : undefined,
      });
    }

    // ── Play 3: future maintenance offers pulled forward into the gap ──
    const pullable = await tx.select({ id: relationshipTouch.id, customerId: relationshipTouch.customerId })
      .from(relationshipTouch).where(and(
        eq(relationshipTouch.tenantId, tenantId), eq(relationshipTouch.program, "maintenance_offer"),
        isNull(relationshipTouch.sentAt), isNull(relationshipTouch.suppressedReason),
        gt(relationshipTouch.scheduledFor, windowEnd),
      ));
    for (const touch of pullable) {
      // Land it tomorrow — inside the gap being filled, not 60 days out. The
      // touch already passed the governor when it was scheduled; moving it
      // earlier consumes no extra cap slot.
      const pulled = await insertPlay(tx, {
        tenantId, gapId: targetGapId, kind: "maintenance_pullforward", targetRef: touch.id, status: "sent",
      });
      if (pulled > 0) {
        await tx.update(relationshipTouch).set({ scheduledFor: new Date(now.getTime() + 86_400_000) })
          .where(eq(relationshipTouch.id, touch.id));
      }
      playsCreated += pulled;
    }

    // ── Invariant: every gap is planned or passed ──
    let passes = 0;
    for (const gapId of gapIds) {
      const plays = await tx.select({ id: fillPlay.id }).from(fillPlay)
        .where(and(eq(fillPlay.tenantId, tenantId), eq(fillPlay.gapId, gapId)));
      if (plays.length > 0) {
        await tx.update(crewGap).set({ status: "planned" }).where(eq(crewGap.id, gapId));
      } else {
        passes += 1;
        await tx.update(crewGap).set({ status: "passed", passReason: "no_candidates" }).where(eq(crewGap.id, gapId));
      }
    }

    return { gapsDetected: gapIds.length, playsCreated, passes };
  });
}

export type PendingFillApproval = {
  playId: string; targetRef: string; discountBps: number | null;
  originalTotalCents: number | null; discountedTotalCents: number | null; createdAt: Date;
};

/** Over-threshold discount plays awaiting the owner/admin card (S6 matrix). */
export async function pendingFillApprovals(tenantId: string): Promise<PendingFillApproval[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({
      playId: fillPlay.id, targetRef: fillPlay.targetRef, discountBps: fillPlay.discountBps,
      originalTotalCents: fillPlay.originalTotalCents, discountedTotalCents: fillPlay.discountedTotalCents,
      createdAt: fillPlay.createdAt,
    }).from(fillPlay)
      .where(and(eq(fillPlay.tenantId, tenantId), eq(fillPlay.status, "pending_approval"))));
}

/**
 * Owner/admin approval releases the offer — still THROUGH the governor (an
 * approval can't bypass opt-outs or the cap; a refusal resolves the card as
 * suppressed with the ledger row as evidence).
 */
export async function approveFillPlay(
  tenantId: string,
  input: { playId: string; userId: string | null },
): Promise<{ ok: true } | { error: string }> {
  const play = await withTenant(tenantId, async (tx) => {
    const [p] = await tx.select({ id: fillPlay.id, targetRef: fillPlay.targetRef, status: fillPlay.status })
      .from(fillPlay).where(and(eq(fillPlay.tenantId, tenantId), eq(fillPlay.id, input.playId)));
    return p ?? null;
  });
  if (!play || play.status !== "pending_approval") return { error: "not pending" };

  const customerId = await withTenant(tenantId, async (tx) => {
    const [est] = await tx.select({ leadId: estimate.leadId }).from(estimate).where(eq(estimate.id, play.targetRef));
    if (!est?.leadId) return null;
    const [l] = await tx.select({ customerId: lead.customerId }).from(lead).where(eq(lead.id, est.leadId));
    return l?.customerId ?? null;
  });
  if (!customerId) return { error: "no customer" };

  const now = new Date();
  const verdict = await scheduleRelationshipTouch({
    tenantId, customerId, program: "fill_discount", channel: "text", scheduledFor: now,
    sourceRef: `fill_discount:${play.targetRef}`, now,
  });
  const refused = "scheduled" in verdict && verdict.scheduled === false;
  await withTenant(tenantId, (tx) =>
    tx.update(fillPlay).set({
      status: refused ? "suppressed" : "sent",
      suppressedReason: refused ? verdict.reason : null,
      resolvedAt: now,
      resolvedByUserId: input.userId,
    }).where(eq(fillPlay.id, play.id)));
  return { ok: true };
}

export type FillWeekStats = {
  gaps: number; playsSent: number; conversions: number;
  idleCrewDaysRecovered: number; pendingCards: number;
};

/** Trailing-7-day fill activity for the owner digest (buildFillLine shapes the text). */
export async function fillWeekStats(tenantId: string, now: Date): Promise<FillWeekStats> {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  return withTenant(tenantId, async (tx) => {
    const gaps = await tx.select({ id: crewGap.id, freeMinutes: crewGap.freeMinutes })
      .from(crewGap).where(and(eq(crewGap.tenantId, tenantId), gt(crewGap.detectedAt, weekAgo)));
    const plays = await tx.select({ status: fillPlay.status })
      .from(fillPlay).where(and(eq(fillPlay.tenantId, tenantId), gt(fillPlay.createdAt, weekAgo)));
    const playsSent = plays.filter((p) => p.status === "sent").length;
    const conversions = plays.filter((p) => p.status === "converted").length;
    // A converted play recovers its gap — count recovered idle time in crew-days.
    const idleCrewDaysRecovered = conversions > 0
      ? Math.round(gaps.reduce((s, g) => s + g.freeMinutes, 0) / 480)
      : 0;
    return {
      gaps: gaps.length, playsSent, conversions, idleCrewDaysRecovered,
      pendingCards: plays.filter((p) => p.status === "pending_approval").length,
    };
  });
}

type PlayInsert = {
  tenantId: string; gapId: string; kind: string; targetRef: string;
  discountBps?: number; originalTotalCents?: number; discountedTotalCents?: number;
  status: string; suppressedReason?: string;
};

async function insertPlay(tx: Parameters<Parameters<typeof withTenant>[1]>[0], play: PlayInsert): Promise<number> {
  const inserted = await tx.insert(fillPlay).values(play).onConflictDoNothing().returning({ id: fillPlay.id });
  return inserted.length;
}
