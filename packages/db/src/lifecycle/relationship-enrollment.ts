// Customer for Life slice 2: the standing cadence. Every completed job enrolls
// its customer (sweep-based — self-heals regardless of which path completed the
// job), the cadence keeper extends roofiversary + holiday cards forward each
// year, and print-channel touches HOLD as print_pending until PostGrid lands.
// All scheduling goes through the governor; nothing here sends.

import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { withTenant } from "../tenant";
import { tenant, customer, job, relationshipTouch, relationshipEnrollment } from "../schema/index";
import {
  parseRelationshipCadenceConfig, nextHolidayDate, roofiversaryDate,
  type RelationshipCadenceConfig,
} from "@savvy/core";
import { scheduleRelationshipTouch } from "./relationship-touch";

const DAY = 86_400_000;
const CHECKIN_GRACE_MS = 15 * DAY; // >45d after completion → too late to "check in"
const EXTEND_HORIZON_MS = 400 * DAY;
const SILENCE_WINDOW_MS = 548 * DAY; // 18 months

export const CADENCE_TEXT_PROGRAMS = ["checkin_30d", "roofiversary"] as const;
const PRINT_CHANNELS = ["postcard", "letter"] as const;

async function cadenceConfig(tenantId: string): Promise<RelationshipCadenceConfig> {
  const [t] = await withTenant(tenantId, (tx) =>
    tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId)));
  return parseRelationshipCadenceConfig((t?.settings as { relationship?: unknown } | null)?.relationship);
}

/** First roofiversary strictly in the future — enrollments backfilled years
 *  late celebrate the NEXT anniversary, not a pile of missed ones. */
function nextRoofiversary(completedAt: Date, now: Date): { n: number; at: Date } {
  let n = 1;
  let at = roofiversaryDate(completedAt, n);
  while (at <= now) {
    n += 1;
    at = roofiversaryDate(completedAt, n);
  }
  return { n, at };
}

async function scheduleStanding(opts: {
  tenantId: string; customerId: string; jobId: string; completedAt: Date;
  cfg: RelationshipCadenceConfig; now: Date;
}): Promise<number> {
  const { tenantId, customerId, jobId, completedAt, cfg, now } = opts;
  let scheduled = 0;

  // Existence by sourceRef in ANY state (sent, scheduled, refused, displaced):
  // a governor refusal is a decision, not a retry queue.
  const refs = new Set(
    (await withTenant(tenantId, (tx) => tx.select({ sourceRef: relationshipTouch.sourceRef })
      .from(relationshipTouch).where(eq(relationshipTouch.customerId, customerId))))
      .map((r) => r.sourceRef).filter(Boolean) as string[],
  );
  const schedule = async (program: string, channel: string, scheduledFor: Date, sourceRef: string) => {
    if (refs.has(sourceRef)) return;
    if (scheduledFor.getTime() > now.getTime() + EXTEND_HORIZON_MS) return;
    const r = await scheduleRelationshipTouch({ tenantId, customerId, program, channel, scheduledFor, sourceRef, now });
    if ("touchId" in r && !r.existing) scheduled += 1;
  };

  const checkinAt = new Date(completedAt.getTime() + 30 * DAY);
  if (checkinAt.getTime() > now.getTime() - CHECKIN_GRACE_MS) {
    await schedule("checkin_30d", "text", checkinAt, `${jobId}:checkin_30d`);
  }

  const roofiv = nextRoofiversary(completedAt, now);
  await schedule("roofiversary", "text", roofiv.at, `${jobId}:roofiversary:${roofiv.n}`);

  const holidayAt = nextHolidayDate(cfg.holiday, now > completedAt ? now : completedAt);
  await schedule("holiday_card", "postcard", holidayAt, `${jobId}:holiday:${holidayAt.getUTCFullYear()}`);

  return scheduled;
}

/** relationship.enrollment sweep: every job at stage complete without an
 *  enrollment row gets one, plus its standing-cadence touches. Idempotent. */
export async function enrollCompletedJobs(tenantId: string, now: Date = new Date()): Promise<{ enrolled: number }> {
  const cfg = await cadenceConfig(tenantId);
  if (!cfg.enabled) return { enrolled: 0 };

  const candidates = await withTenant(tenantId, (tx) =>
    tx.select({ jobId: job.id, customerId: job.customerId, completedAt: job.stageEnteredAt })
      .from(job)
      .leftJoin(relationshipEnrollment, eq(relationshipEnrollment.jobId, job.id))
      .where(and(eq(job.stage, "complete"), isNull(relationshipEnrollment.id))));

  let enrolled = 0;
  for (const c of candidates) {
    await withTenant(tenantId, (tx) => tx.insert(relationshipEnrollment).values({
      tenantId, customerId: c.customerId, jobId: c.jobId, completedAt: c.completedAt, enrolledAt: now,
    }).onConflictDoNothing());
    await scheduleStanding({ tenantId, customerId: c.customerId, jobId: c.jobId, completedAt: c.completedAt, cfg, now });
    enrolled += 1;
  }
  return { enrolled };
}

/** The cadence keeper: for every active enrollment, make sure the NEXT
 *  roofiversary and holiday card exist on the calendar (postcard #7 in year
 *  four is the machine's job, not anyone's memory). */
export async function extendStandingCadence(tenantId: string, now: Date = new Date()): Promise<{ scheduled: number }> {
  const cfg = await cadenceConfig(tenantId);
  if (!cfg.enabled) return { scheduled: 0 };

  const enrollments = await withTenant(tenantId, (tx) =>
    tx.select().from(relationshipEnrollment).where(isNull(relationshipEnrollment.suppressedReason)));

  let scheduled = 0;
  for (const e of enrollments) {
    const refs = new Set(
      (await withTenant(tenantId, (tx) => tx.select({ sourceRef: relationshipTouch.sourceRef })
        .from(relationshipTouch).where(eq(relationshipTouch.customerId, e.customerId))))
        .map((r) => r.sourceRef).filter(Boolean) as string[],
    );
    const ensure = async (program: string, channel: string, at: Date, ref: string) => {
      if (refs.has(ref) || at.getTime() > now.getTime() + EXTEND_HORIZON_MS) return;
      const r = await scheduleRelationshipTouch({
        tenantId, customerId: e.customerId, program, channel, scheduledFor: at, sourceRef: ref, now,
      });
      if ("touchId" in r && !r.existing) scheduled += 1;
    };

    const roofiv = nextRoofiversary(e.completedAt, now);
    await ensure("roofiversary", "text", roofiv.at, `${e.jobId}:roofiversary:${roofiv.n}`);

    const holidayAt = nextHolidayDate(cfg.holiday, now);
    await ensure("holiday_card", "postcard", holidayAt, `${e.jobId}:holiday:${holidayAt.getUTCFullYear()}`);
  }
  return { scheduled };
}

/** Print pieces can't mail until the PostGrid build: due print-channel touches
 *  HOLD as print_pending (the future print queue), never silently drop. */
export async function holdDuePrintTouches(tenantId: string, now: Date = new Date()): Promise<{ held: number }> {
  const rows = await withTenant(tenantId, (tx) => tx.update(relationshipTouch)
    .set({ suppressedReason: "print_pending" })
    .where(and(
      inArray(relationshipTouch.channel, [...PRINT_CHANNELS]),
      isNull(relationshipTouch.sentAt),
      isNull(relationshipTouch.suppressedReason),
      lte(relationshipTouch.scheduledFor, now),
    ))
    .returning({ id: relationshipTouch.id }));
  return { held: rows.length };
}

export type DueCadenceTouch = {
  touchId: string; customerId: string; program: string; sourceRef: string | null;
  name: string; phone: string;
};

/** Due standing-cadence TEXT touches with reachable, un-held customers — the
 *  agents sweep sends exactly these (other programs have their own senders). */
export async function dueCadenceTextTouches(tenantId: string, now: Date = new Date()): Promise<DueCadenceTouch[]> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({
      touchId: relationshipTouch.id, customerId: relationshipTouch.customerId,
      program: relationshipTouch.program, sourceRef: relationshipTouch.sourceRef,
      name: customer.name, phone: customer.phone,
    })
      .from(relationshipTouch)
      .innerJoin(customer, eq(customer.id, relationshipTouch.customerId))
      .where(and(
        inArray(relationshipTouch.program, [...CADENCE_TEXT_PROGRAMS]),
        eq(relationshipTouch.channel, "text"),
        isNull(relationshipTouch.sentAt),
        isNull(relationshipTouch.suppressedReason),
        lte(relationshipTouch.scheduledFor, now),
        eq(customer.smsOptOut, false),
        eq(customer.claimDisputeHold, false),
      )));
  return rows.filter((r): r is typeof r & { phone: string } => !!r.phone);
}

/** Absorption check for the retail close-out drip: an enrolled job's day-30
 *  touch belongs to the standing cadence, not the drip. */
export async function jobHasActiveEnrollment(tenantId: string, jobId: string): Promise<boolean> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select({ id: relationshipEnrollment.id }).from(relationshipEnrollment)
      .where(and(eq(relationshipEnrollment.jobId, jobId), isNull(relationshipEnrollment.suppressedReason))));
  return !!row;
}

/** relationship.enrollment evidence: completed jobs missing an enrollment row.
 *  Must be empty after every sweep. */
export async function enrollmentGaps(tenantId: string, _now: Date = new Date()): Promise<{ jobId: string; customerId: string }[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({ jobId: job.id, customerId: job.customerId })
      .from(job)
      .leftJoin(relationshipEnrollment, eq(relationshipEnrollment.jobId, job.id))
      .where(and(eq(job.stage, "complete"), isNull(relationshipEnrollment.id))));
}

/** relationship.cadence evidence: enrolled customers silent >18 months. Fully
 *  opted-out customers are unreachable by choice and dispute-held customers are
 *  deliberately quiet — neither is a cadence failure. Must be empty. */
export async function cadenceSilenceViolations(tenantId: string, now: Date = new Date()): Promise<{ customerId: string }[]> {
  const cutoff = new Date(now.getTime() - SILENCE_WINDOW_MS);
  return withTenant(tenantId, (tx) =>
    tx.selectDistinct({ customerId: relationshipEnrollment.customerId })
      .from(relationshipEnrollment)
      .innerJoin(customer, eq(customer.id, relationshipEnrollment.customerId))
      .where(and(
        isNull(relationshipEnrollment.suppressedReason),
        lte(relationshipEnrollment.enrolledAt, cutoff),
        eq(customer.claimDisputeHold, false),
        sql`not (${customer.smsOptOut} and ${customer.emailOptOut} and ${customer.mailOptOut})`,
        sql`not exists (
          select 1 from relationship_touch rt
          where rt.customer_id = ${relationshipEnrollment.customerId}
            and rt.sent_at >= ${cutoff.toISOString()}::timestamptz
        )`,
      )));
}
