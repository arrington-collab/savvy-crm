import { and, eq, gte, lte, inArray, isNull } from "drizzle-orm";
import type { DomainEvent } from "@savvy/orchestrator";
import type {
  DailyMetricsByRep, DailyMetricsBySource, DailyMetricsByLocation,
  DailyMetrics, ScorecardRow, MetricValue,
} from "@savvy/command-center";
import {
  projectDayByRep, projectDayBySource, projectDayByLocation,
  UNASSIGNED_REP, UNKNOWN_SOURCE, UNKNOWN_LOCATION,
  projectWeek, closeRateCohort, closeRateActivity, buildScorecard,
  weekDates, trailingWeekStarts, denverWeekWindow, emptyMetrics, ok, pending, isActive,
} from "@savvy/command-center";
import { withTenant, type Tx } from "../tenant";
import { dailyMetricsByRep, dailyMetricsBySource, dailyMetricsByLocation, weeklyScorecard } from "../schema/scorecard";
import { job } from "../schema/jobs";
import { lead } from "../schema/crm";
import { orchestratorEvent } from "../schema/orchestrator";
import { loadEventsForDay } from "./read";
import { listQueue } from "./store";
import { getGoals } from "./scorecard-goals";

export { loadEventsForDay };

// Event types with no leadId in the current orchestrator event schema (see
// packages/orchestrator/src/events.ts payloadSchemas) — the reason D4-3's
// pure projectors park them in the UNASSIGNED_REP/UNKNOWN_SOURCE sentinel
// buckets. resolveAttribution below is the DB-access-having half of the fix:
// it resolves a real rep/source for these via a join and hands the pure
// projectors an enriched event so they attribute correctly instead.
const LEADLESS_EVENT_TYPES = new Set<string>(["contract.signed", "estimate.approved", "appointment.no_show"]);

function readField(e: DomainEvent, key: string): string | undefined {
  const v = (e.payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

interface JobRow { id: string; leadId: string | null; customerId: string }
interface LeadRow { id: string; assignedUserId: string | null; source: string | null }
interface LeadByCustomerRow extends LeadRow { customerId: string | null }

/**
 * Resolves rep/source attribution for events that carry no `leadId`
 * (`contract.signed`, `estimate.approved`, `appointment.no_show`) via a DB
 * join, honest by construction — never guesses:
 *
 * 1. `event.payload.jobId` -> `job.leadId` -> `lead.assignedUserId` (repId) +
 *    `lead.source`. Precise 1:1 path when the job is linked to a lead.
 * 2. If `job.leadId` is null (or the jobId doesn't resolve to a job), fall
 *    back on customerId — `event.payload.customerId` when the event itself
 *    carries one (`contract.signed`), else `job.customerId` (every job has
 *    one) — and look up that customer's leads. Used ONLY when the customer
 *    has EXACTLY ONE lead; 0 or >1 leads leaves the event unattributed (it
 *    stays in the projector's sentinel bucket) rather than guess which lead
 *    drove the deal.
 * 3. Attaches the resolved `repId`/`source` onto a shallow-cloned event's
 *    payload. Events that don't need attribution (or that couldn't be
 *    resolved) pass through unchanged, so the projectors' existing
 *    sentinel-fallback behavior for everything else is untouched.
 *
 * `lead` carries no `locationId` column, so location attribution is
 * unaffected by this function — `projectDayByLocation` still reads
 * `event.payload.locationId` directly (unchanged from D4-3).
 */
export async function resolveAttribution(tx: Tx, tenantId: string, events: DomainEvent[]): Promise<DomainEvent[]> {
  const leadless = events.filter((e) => LEADLESS_EVENT_TYPES.has(e.type));
  if (leadless.length === 0) return events;

  const jobIds = [...new Set(leadless.map((e) => readField(e, "jobId")).filter((v): v is string => v !== undefined))];
  const jobRows: JobRow[] = jobIds.length
    ? await tx.select({ id: job.id, leadId: job.leadId, customerId: job.customerId }).from(job)
        .where(and(eq(job.tenantId, tenantId), inArray(job.id, jobIds)))
    : [];
  const jobById = new Map(jobRows.map((j) => [j.id, j]));

  const directLeadIds = [...new Set(jobRows.map((j) => j.leadId).filter((v): v is string => v !== null))];
  const directLeads: LeadRow[] = directLeadIds.length
    ? await tx.select({ id: lead.id, assignedUserId: lead.assignedUserId, source: lead.source }).from(lead)
        .where(and(eq(lead.tenantId, tenantId), inArray(lead.id, directLeadIds)))
    : [];
  const leadById = new Map(directLeads.map((l) => [l.id, l]));

  // Only look up the customer-fallback path for events whose jobId didn't
  // resolve to a lead directly (step 1 already covers those precisely).
  const customerIds = new Set<string>();
  for (const e of leadless) {
    const jobId = readField(e, "jobId");
    const j = jobId ? jobById.get(jobId) : undefined;
    if (j?.leadId) continue;
    const customerId = readField(e, "customerId") ?? j?.customerId;
    if (customerId) customerIds.add(customerId);
  }
  const customerLeads: LeadByCustomerRow[] = customerIds.size
    ? await tx.select({ id: lead.id, customerId: lead.customerId, assignedUserId: lead.assignedUserId, source: lead.source })
        .from(lead)
        .where(and(eq(lead.tenantId, tenantId), inArray(lead.customerId, [...customerIds])))
    : [];
  const leadsByCustomer = new Map<string, LeadByCustomerRow[]>();
  for (const l of customerLeads) {
    if (!l.customerId) continue;
    const arr = leadsByCustomer.get(l.customerId) ?? [];
    arr.push(l);
    leadsByCustomer.set(l.customerId, arr);
  }

  return events.map((e) => {
    if (!LEADLESS_EVENT_TYPES.has(e.type)) return e;
    const jobId = readField(e, "jobId");
    const j = jobId ? jobById.get(jobId) : undefined;

    let repId: string | undefined;
    let source: string | undefined;

    if (j?.leadId) {
      const l = leadById.get(j.leadId);
      repId = l?.assignedUserId ?? undefined;
      source = l?.source ?? undefined;
    } else {
      const customerId = readField(e, "customerId") ?? j?.customerId;
      const candidates = customerId ? leadsByCustomer.get(customerId) : undefined;
      // Honesty guard: only attribute when exactly one lead exists for the
      // customer. 0 -> nothing to attribute to. >1 -> ambiguous, don't guess.
      if (candidates && candidates.length === 1) {
        repId = candidates[0]!.assignedUserId ?? undefined;
        source = candidates[0]!.source ?? undefined;
      }
    }

    if (repId === undefined && source === undefined) return e;
    return {
      ...e,
      payload: { ...(e.payload as Record<string, unknown>), ...(repId !== undefined ? { repId } : {}), ...(source !== undefined ? { source } : {}) },
    } as DomainEvent;
  });
}

// Sentinel -> SQL NULL translation on write. `rep_id`/`location_id` are uuid
// columns (rep_id made nullable in D4-4, migration 0122 amended in place) and
// the projectors' string sentinels ("unassigned" / "unknown") are not valid
// uuids, so they must become NULL — the NULLS NOT DISTINCT unique indexes
// (D4-2) then dedupe the company-level / unassigned-rep row correctly across
// rebuildDay re-runs. `source` (daily_metrics_by_source) is a text column, so
// its UNKNOWN_SOURCE sentinel ("unknown") is kept as plain text — no NULLing
// needed there, chosen for consistency with how it already prints in the UI.
function sqlLocationId(locationId: string): string | null {
  return locationId === UNKNOWN_LOCATION ? null : locationId;
}
function sqlRepId(repId: string): string | null {
  return repId === UNASSIGNED_REP ? null : repId;
}

export async function upsertDailyByRep(tenantId: string, rows: DailyMetricsByRep[]): Promise<void> {
  if (rows.length === 0) return;
  await withTenant(tenantId, async (tx) => {
    for (const r of rows) {
      const locationId = sqlLocationId(r.locationId);
      const repId = sqlRepId(r.repId);
      const values = {
        tenantId, businessDate: r.date, locationId, repId,
        leads: r.leads, firstTouches: r.firstTouches, medianSpeedSeconds: r.medianSpeedSeconds,
        apptsSet: r.apptsSet, noShows: r.noShows, contracts: r.contracts,
        contractValueCents: r.contractValueCents, estimatesApproved: r.estimatesApproved, avgMarginPct: r.avgMarginPct,
      };
      await tx.insert(dailyMetricsByRep).values(values).onConflictDoUpdate({
        target: [dailyMetricsByRep.tenantId, dailyMetricsByRep.businessDate, dailyMetricsByRep.locationId, dailyMetricsByRep.repId],
        set: {
          leads: r.leads, firstTouches: r.firstTouches, medianSpeedSeconds: r.medianSpeedSeconds,
          apptsSet: r.apptsSet, noShows: r.noShows, contracts: r.contracts,
          contractValueCents: r.contractValueCents, estimatesApproved: r.estimatesApproved, avgMarginPct: r.avgMarginPct,
        },
      });
    }
  });
}

export async function upsertDailyBySource(tenantId: string, rows: DailyMetricsBySource[]): Promise<void> {
  if (rows.length === 0) return;
  await withTenant(tenantId, async (tx) => {
    for (const r of rows) {
      const locationId = sqlLocationId(r.locationId);
      const values = {
        tenantId, businessDate: r.date, locationId, source: r.source,
        leads: r.leads, apptsSet: r.apptsSet, contracts: r.contracts, contractValueCents: r.contractValueCents,
        costCents: r.costCents ?? null,
      };
      await tx.insert(dailyMetricsBySource).values(values).onConflictDoUpdate({
        target: [dailyMetricsBySource.tenantId, dailyMetricsBySource.businessDate, dailyMetricsBySource.locationId, dailyMetricsBySource.source],
        set: { leads: r.leads, apptsSet: r.apptsSet, contracts: r.contracts, contractValueCents: r.contractValueCents, costCents: r.costCents ?? null },
      });
    }
  });
}

export async function upsertDailyByLocation(tenantId: string, rows: DailyMetricsByLocation[]): Promise<void> {
  if (rows.length === 0) return;
  await withTenant(tenantId, async (tx) => {
    for (const r of rows) {
      const locationId = sqlLocationId(r.locationId);
      const values = { tenantId, businessDate: r.date, locationId, metrics: r.metrics };
      await tx.insert(dailyMetricsByLocation).values(values).onConflictDoUpdate({
        target: [dailyMetricsByLocation.tenantId, dailyMetricsByLocation.businessDate, dailyMetricsByLocation.locationId],
        set: { metrics: r.metrics },
      });
    }
  });
}

export async function getDailyByRepRange(tenantId: string, startDate: string, endDate: string) {
  return withTenant(tenantId, (tx) =>
    tx.select().from(dailyMetricsByRep).where(and(
      eq(dailyMetricsByRep.tenantId, tenantId),
      gte(dailyMetricsByRep.businessDate, startDate),
      lte(dailyMetricsByRep.businessDate, endDate),
    )));
}

export async function getDailyBySourceRange(tenantId: string, startDate: string, endDate: string) {
  return withTenant(tenantId, (tx) =>
    tx.select().from(dailyMetricsBySource).where(and(
      eq(dailyMetricsBySource.tenantId, tenantId),
      gte(dailyMetricsBySource.businessDate, startDate),
      lte(dailyMetricsBySource.businessDate, endDate),
    )));
}

export async function getDailyByLocationRange(tenantId: string, startDate: string, endDate: string) {
  return withTenant(tenantId, (tx) =>
    tx.select().from(dailyMetricsByLocation).where(and(
      eq(dailyMetricsByLocation.tenantId, tenantId),
      gte(dailyMetricsByLocation.businessDate, startDate),
      lte(dailyMetricsByLocation.businessDate, endDate),
    )));
}

/**
 * Rebuilds one Denver business date's three dimensional daily tables from
 * `orchestrator_event`: load -> enrich attribution (DB join for the
 * leadId-less events) -> pure-project each dimension -> upsert. Idempotent —
 * upserts key on each table's (tenant, date, locationId, dimension) unique
 * index (NULLS NOT DISTINCT), so re-running for the same day updates the same
 * rows in place instead of duplicating them.
 */
export async function rebuildDay(tenantId: string, businessDate: string): Promise<void> {
  const rawEvents = await loadEventsForDay(tenantId, businessDate);
  const enriched = await withTenant(tenantId, (tx) => resolveAttribution(tx, tenantId, rawEvents));

  const byRep = projectDayByRep(enriched, businessDate);
  const bySource = projectDayBySource(enriched, businessDate);
  const byLocation = projectDayByLocation(enriched, businessDate);

  await upsertDailyByRep(tenantId, byRep);
  await upsertDailyBySource(tenantId, bySource);
  await upsertDailyByLocation(tenantId, byLocation);
}

// --- D4-6: rebuildWeek ------------------------------------------------------

/**
 * Additively folds a day's per-location rows into one company-wide
 * `DailyMetrics` for that date. The buckets `projectDayByLocation` produces
 * are a strict partition of the day's events (§8.2), so this reproduces
 * exactly what `projectDay(allEventsForDay, date)` would have computed —
 * "roll from aggregates, not raw events" (design principle #2), reusing the
 * dimensional rows `rebuildDay` already persisted instead of re-scanning
 * `orchestrator_event` a second time for the same day.
 */
function foldLocationsForDay(rows: { metrics: DailyMetrics }[], businessDate: string): DailyMetrics {
  const m = emptyMetrics(businessDate);
  for (const { metrics: d } of rows) {
    m.topLine.leadsTotal += d.topLine.leadsTotal;
    for (const [source, n] of Object.entries(d.topLine.leadsBySource)) {
      m.topLine.leadsBySource[source] = (m.topLine.leadsBySource[source] ?? 0) + n;
    }
    m.topLine.appointmentsSet += d.topLine.appointmentsSet;
    m.topLine.appointmentsNoShow += d.topLine.appointmentsNoShow;
    m.topLine.contractsSigned += d.topLine.contractsSigned;
    m.topLine.contractValueCents += d.topLine.contractValueCents;
    m.topLine.jobsCompleted += d.topLine.jobsCompleted;
    m.money.invoicedCents += d.money.invoicedCents;
    m.money.cashCollectedCents += d.money.cashCollectedCents;
    m.money.supplementsApprovedCents += d.money.supplementsApprovedCents;
    m.money.arPastDue.d30 += d.money.arPastDue.d30;
    m.money.arPastDue.d60 += d.money.arPastDue.d60;
    m.money.arPastDue.d90 += d.money.arPastDue.d90;
    m.quality.reviewsPosted += d.quality.reviewsPosted;
    m.production.estimatesApproved += d.production.estimatesApproved;
    m.production.materialOrders += d.production.materialOrders;
  }
  return m;
}

export interface SignedContractRow { leadId: string; signedAt: Date }
interface LeadIdRow { id: string; customerId: string | null }

/**
 * Resolves `contract.signed` events — ALL TIME, not just this week; the
 * cohort close rate (A.3) needs "signed as of now" for leads created in a
 * past week — to a `leadId`, via the same honesty-gated job/customer join
 * `resolveAttribution` uses above (job.leadId direct path; job.customerId /
 * event.customerId fallback ONLY when the customer has exactly one lead).
 * A contract that can't be traced to a single lead is simply excluded from
 * the cohort's numerator — never guessed.
 *
 * Exported (D4-8): the reps/sources dashboards need the same all-time
 * leadId->signedAt resolution to compute a per-dimension cohort close rate
 * (source page) — reusing this instead of re-deriving the job/customer join
 * a second time in the web layer.
 */
export async function resolveContractSignings(tenantId: string): Promise<SignedContractRow[]> {
  return withTenant(tenantId, async (tx) => {
    const events = await tx.select({ payload: orchestratorEvent.payload, createdAt: orchestratorEvent.createdAt })
      .from(orchestratorEvent)
      .where(and(
        eq(orchestratorEvent.tenantId, tenantId),
        eq(orchestratorEvent.eventType, "contract.signed"),
        eq(orchestratorEvent.outcome, "received"),
      ));
    if (events.length === 0) return [];

    const jobIds = [...new Set(events.map((e) => (e.payload as Record<string, unknown>).jobId).filter((v): v is string => typeof v === "string"))];
    const jobRows: JobRow[] = jobIds.length
      ? await tx.select({ id: job.id, leadId: job.leadId, customerId: job.customerId }).from(job)
          .where(and(eq(job.tenantId, tenantId), inArray(job.id, jobIds)))
      : [];
    const jobById = new Map(jobRows.map((j) => [j.id, j]));

    const customerIds = new Set<string>();
    for (const e of events) {
      const p = e.payload as Record<string, unknown>;
      const jobId = typeof p.jobId === "string" ? p.jobId : undefined;
      const j = jobId ? jobById.get(jobId) : undefined;
      if (j?.leadId) continue;
      const customerId = typeof p.customerId === "string" ? p.customerId : j?.customerId;
      if (customerId) customerIds.add(customerId);
    }
    const customerLeads: LeadIdRow[] = customerIds.size
      ? await tx.select({ id: lead.id, customerId: lead.customerId }).from(lead)
          .where(and(eq(lead.tenantId, tenantId), inArray(lead.customerId, [...customerIds])))
      : [];
    const leadsByCustomer = new Map<string, string[]>();
    for (const l of customerLeads) {
      if (!l.customerId) continue;
      const arr = leadsByCustomer.get(l.customerId) ?? [];
      arr.push(l.id);
      leadsByCustomer.set(l.customerId, arr);
    }

    const out: SignedContractRow[] = [];
    for (const e of events) {
      const p = e.payload as Record<string, unknown>;
      const jobId = typeof p.jobId === "string" ? p.jobId : undefined;
      const j = jobId ? jobById.get(jobId) : undefined;
      let leadId: string | undefined;
      if (j?.leadId) {
        leadId = j.leadId;
      } else {
        const customerId = typeof p.customerId === "string" ? p.customerId : j?.customerId;
        const candidates = customerId ? leadsByCustomer.get(customerId) : undefined;
        // Honesty guard, same as resolveAttribution: only attribute when
        // exactly one lead exists for the customer.
        if (candidates && candidates.length === 1) leadId = candidates[0];
      }
      if (leadId) out.push({ leadId, signedAt: e.createdAt });
    }
    return out;
  });
}

/**
 * Rebuilds one week's EOS scorecard from the event log (design principle
 * "Replayable"): ensure the 7 days' dimensional rows exist (`rebuildDay`),
 * fold them + the week's raw events into a `WeeklyFold` (`projectWeek`),
 * resolve the two close-rate flavors + `exceptions.open` (real DB reads
 * `buildScorecard` can't do itself, since it stays pure), assemble each
 * measurable's 13-week trailing history from prior `weekly_scorecard` rows,
 * then explode the resulting `ScorecardRow[]` into one `weekly_scorecard`
 * row per metricKey.
 *
 * Idempotent + replayable (§8.9/§8.10): every step is a deterministic
 * function of already-persisted state plus the (unchanged) event log, and
 * the upsert targets the `(tenantId, weekStart, locationId, metricKey)`
 * unique index (NULLS NOT DISTINCT) — re-running for the same week updates
 * the same 15 rows in place instead of duplicating them.
 *
 * Company-wide only for now (`locationId = null`) — per-location scorecards
 * are the empire-phase extension the design doc calls out (§9); the
 * dimension is already on the table, just not driven here yet.
 */
export async function rebuildWeek(tenantId: string, weekStart: string): Promise<void> {
  const dates = weekDates(weekStart);
  for (const date of dates) {
    await rebuildDay(tenantId, date);
  }

  const byLocationRows = await getDailyByLocationRange(tenantId, dates[0]!, dates[6]!);
  const dailyRows: DailyMetrics[] = dates.map((date) =>
    foldLocationsForDay(byLocationRows.filter((r) => r.businessDate === date), date));

  const weekEventsByDay = await Promise.all(dates.map((d) => loadEventsForDay(tenantId, d)));
  const weekEvents: DomainEvent[] = weekEventsByDay.flat();

  const weekly = projectWeek({ dailyRows, weekEvents, weekStart });

  // Honesty guard (matches noShowRate's pattern below): a zero denominator
  // means "not computable this week", not a real 0% — closeRateActivity /
  // closeRateCohort fall back to `rate: 0` internally to avoid NaN, but
  // wrapping that in ok() would fabricate an alarming, off-track-looking
  // number (and poison the persisted 13-week sparkline with a fake data
  // point). Degrade to pending instead when there were no leads this week.
  const activity = closeRateActivity(weekly.topLine.contractsSigned, weekly.topLine.leadsTotal);
  const closeRateActivityValue: MetricValue =
    weekly.topLine.leadsTotal === 0 ? pending("no leads created this week") : ok(activity.rate);

  const { startUtc, endUtc } = denverWeekWindow(weekStart);
  const leadsCreatedInWeek = await withTenant(tenantId, (tx) =>
    tx.select({ leadId: lead.id, createdAt: lead.createdAt }).from(lead)
      .where(and(eq(lead.tenantId, tenantId), gte(lead.createdAt, startUtc), lte(lead.createdAt, endUtc))));
  const contractsAsOfNow = await resolveContractSignings(tenantId);
  const cohort = closeRateCohort({
    leadsCreatedInWeek: leadsCreatedInWeek.map((l) => ({ leadId: l.leadId, createdAt: l.createdAt })),
    contractsAsOfNow,
    now: new Date(),
    weekStart,
  });
  const closeRateCohortValue: MetricValue =
    leadsCreatedInWeek.length === 0 ? pending("no leads created this week") : ok(cohort.rate);
  // cohort.maturing / cohort.cohortAgeDays (the "still maturing" caveat A.3
  // wants surfaced) don't fit MetricValue's ok/pending shape — that's a
  // render-layer (D4-7) concern, noted here so it isn't silently lost.

  const queueItems = await listQueue(tenantId);
  const now = new Date();
  const exceptionsOpenValue: MetricValue = ok(queueItems.filter((it) => isActive(it, now)).length);

  const goals = await getGoals(tenantId, null);

  // 13-week trailing window (§8.4): trailingWeekStarts includes the current
  // week as its LAST entry; the other 12 are what we look up in
  // weekly_scorecard (the current week's own row doesn't exist yet this run).
  const trailing = trailingWeekStarts(weekStart, 13);
  const priorStarts = trailing.slice(0, -1);
  const priorRows = priorStarts.length
    ? await withTenant(tenantId, (tx) =>
        tx.select().from(weeklyScorecard).where(and(
          eq(weeklyScorecard.tenantId, tenantId),
          isNull(weeklyScorecard.locationId),
          inArray(weeklyScorecard.weekStart, priorStarts),
        )))
    : [];
  const priorByMetric = new Map<string, Map<string, number | null>>();
  for (const r of priorRows) {
    const v = r.value as MetricValue | null;
    const num = v && v.status === "ok" ? v.value : null;
    let byWeek = priorByMetric.get(r.metricKey);
    if (!byWeek) { byWeek = new Map(); priorByMetric.set(r.metricKey, byWeek); }
    byWeek.set(r.weekStart, num);
  }
  const priorWeeksInput: Record<string, (number | null)[]> = {};
  for (const metricKey of priorByMetric.keys()) {
    priorWeeksInput[metricKey] = priorStarts.map((ws) => priorByMetric.get(metricKey)!.get(ws) ?? null);
  }

  const rows: ScorecardRow[] = buildScorecard({
    weekly,
    priorWeeks: priorWeeksInput,
    goals,
    closeRateCohort: closeRateCohortValue,
    closeRateActivity: closeRateActivityValue,
    exceptionsOpen: exceptionsOpenValue,
  });

  await withTenant(tenantId, async (tx) => {
    for (const row of rows) {
      await tx.insert(weeklyScorecard).values({
        tenantId, weekStart, locationId: null, metricKey: row.metricKey,
        value: row.value, goal: row.goal, onTrack: row.onTrack, priorWeeks: row.priorWeeks,
      }).onConflictDoUpdate({
        target: [weeklyScorecard.tenantId, weeklyScorecard.weekStart, weeklyScorecard.locationId, weeklyScorecard.metricKey],
        set: { value: row.value, goal: row.goal, onTrack: row.onTrack, priorWeeks: row.priorWeeks },
      });
    }
  });
}
