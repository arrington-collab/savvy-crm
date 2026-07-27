import { and, eq, gte, lte, inArray } from "drizzle-orm";
import type { DomainEvent } from "@savvy/orchestrator";
import type { DailyMetricsByRep, DailyMetricsBySource, DailyMetricsByLocation } from "@savvy/command-center";
import {
  projectDayByRep, projectDayBySource, projectDayByLocation,
  UNASSIGNED_REP, UNKNOWN_SOURCE, UNKNOWN_LOCATION,
} from "@savvy/command-center";
import { withTenant, type Tx } from "../tenant";
import { dailyMetricsByRep, dailyMetricsBySource, dailyMetricsByLocation } from "../schema/scorecard";
import { job } from "../schema/jobs";
import { lead } from "../schema/crm";
import { loadEventsForDay } from "./read";

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
