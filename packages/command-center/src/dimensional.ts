import type { DomainEvent } from "@savvy/orchestrator";
import { businessDateOf } from "./day-window";
import { projectDay } from "./projection";
import type { DailyMetricsByRep, DailyMetricsBySource, DailyMetricsByLocation } from "./weekly-metrics";

// Sentinel bucket keys used when an event's dimension cannot be resolved from
// the data available in this business-date's event window. The §8.2 sum-back
// invariant requires nothing be dropped, so every event that can't be traced
// to a real rep/source/location still lands in one of these buckets instead
// of vanishing — never a silent 0, and never lost from the company total.
export const UNASSIGNED_REP = "unassigned";
export const UNKNOWN_SOURCE = "unknown";
export const UNKNOWN_LOCATION = "unknown";

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// Reads a string field off an event's payload without a per-type union
// (payload shapes vary by event type; this only ever reads well-known
// optional/nullable id fields, matching how projection.ts casts per-case).
function field(e: DomainEvent, key: string): string | undefined {
  const v = (e.payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Groups events by `lead.assigned.repId` and folds the lead's activity into
 * that rep's `(repId, locationId)` row. `locationId` is read off the SAME
 * `lead.assigned` event as `repId` (they're one join, not an invented one).
 *
 * Attribution decisions (documented, tested — see dimensional.test.ts):
 * - A lead with no `lead.assigned` event (never assigned) → `UNASSIGNED_REP`
 *   bucket, `UNKNOWN_LOCATION`. Still counted — never dropped.
 * - `contract.signed` / `estimate.approved` / `appointment.no_show` carry no
 *   `leadId` at all in the current event schema (only `jobId`/`customerId`),
 *   so there is no reliable join back to a lead's assigned rep from the event
 *   payload alone. D4-4's `resolveAttribution` (in @savvy/db) resolves these
 *   via a DB join (job.leadId -> lead.assignedUserId/source, honesty-gated
 *   customerId fallback) and attaches the result as `payload.repId` /
 *   `payload.source` on an enriched copy of the event — read below when
 *   present. Events that reach this function unenriched (e.g. direct unit
 *   tests, or the honesty guard leaving an event unresolved) fall back to the
 *   `UNASSIGNED_REP` bucket exactly as before; this is a known limitation of
 *   the current schema, not a bug, when no attribution was resolvable.
 * - `appointment.set` carries an optional `leadId`; used when present.
 */
export function projectDayByRep(events: DomainEvent[], businessDate: string): DailyMetricsByRep[] {
  const day = events.filter((e) => businessDateOf(e.occurredAt) === businessDate);

  const repByLead = new Map<string, string>();
  const locationByLead = new Map<string, string>();
  for (const e of day) {
    if (e.type === "lead.assigned") {
      const leadId = field(e, "leadId");
      if (!leadId) continue;
      const repId = field(e, "repId");
      if (repId) repByLead.set(leadId, repId);
      locationByLead.set(leadId, field(e, "locationId") ?? UNKNOWN_LOCATION);
    }
  }

  interface Bucket {
    tenantId: string;
    locationId: string;
    repId: string;
    leads: number;
    firstTouches: number;
    speeds: number[];
    apptsSet: number;
    noShows: number;
    contracts: number;
    contractValueCents: number;
    estimatesApproved: number;
    margins: number[];
  }
  const buckets = new Map<string, Bucket>();
  function bucketFor(tenantId: string, repId: string, locationId: string): Bucket {
    const key = `${repId}::${locationId}`;
    let b = buckets.get(key);
    if (!b) {
      b = { tenantId, locationId, repId, leads: 0, firstTouches: 0, speeds: [], apptsSet: 0, noShows: 0, contracts: 0, contractValueCents: 0, estimatesApproved: 0, margins: [] };
      buckets.set(key, b);
    }
    return b;
  }
  function resolve(leadId: string | undefined): { repId: string; locationId: string } {
    if (!leadId) return { repId: UNASSIGNED_REP, locationId: UNKNOWN_LOCATION };
    return { repId: repByLead.get(leadId) ?? UNASSIGNED_REP, locationId: locationByLead.get(leadId) ?? UNKNOWN_LOCATION };
  }

  for (const e of day) {
    switch (e.type) {
      case "lead.created": {
        const { repId, locationId } = resolve(field(e, "leadId"));
        bucketFor(e.tenantId, repId, locationId).leads += 1;
        break;
      }
      case "lead.first_touch": {
        const { repId, locationId } = resolve(field(e, "leadId"));
        const b = bucketFor(e.tenantId, repId, locationId);
        b.firstTouches += 1;
        const p = e.payload as { slaLatencySeconds?: number; latencySeconds?: number };
        const secs = p.slaLatencySeconds ?? p.latencySeconds;
        if (secs != null) b.speeds.push(secs);
        break;
      }
      case "appointment.set": {
        const { repId, locationId } = resolve(field(e, "leadId"));
        bucketFor(e.tenantId, repId, locationId).apptsSet += 1;
        break;
      }
      case "appointment.no_show": {
        // no leadId on this event type — see doc comment above. repId, when
        // attached by resolveAttribution, routes this to the real rep.
        const repId = field(e, "repId") ?? UNASSIGNED_REP;
        bucketFor(e.tenantId, repId, UNKNOWN_LOCATION).noShows += 1;
        break;
      }
      case "contract.signed": {
        // repId, when attached by resolveAttribution's DB join, routes this to
        // the real rep instead of the sentinel; locationId is unchanged (lead
        // has no locationId — see the doc comment above and dimensional.test.ts).
        const p = e.payload as { contractValueCents: number };
        const repId = field(e, "repId") ?? UNASSIGNED_REP;
        const b = bucketFor(e.tenantId, repId, UNKNOWN_LOCATION);
        b.contracts += 1;
        b.contractValueCents += p.contractValueCents;
        break;
      }
      case "estimate.approved": {
        const p = e.payload as { marginPct: number };
        const repId = field(e, "repId") ?? UNASSIGNED_REP;
        const b = bucketFor(e.tenantId, repId, UNKNOWN_LOCATION);
        b.estimatesApproved += 1;
        b.margins.push(p.marginPct);
        break;
      }
      default:
        break;
    }
  }

  return [...buckets.values()].map((b) => ({
    date: businessDate,
    tenantId: b.tenantId,
    locationId: b.locationId,
    repId: b.repId,
    leads: b.leads,
    firstTouches: b.firstTouches,
    medianSpeedSeconds: median(b.speeds),
    apptsSet: b.apptsSet,
    noShows: b.noShows,
    contracts: b.contracts,
    contractValueCents: b.contractValueCents,
    estimatesApproved: b.estimatesApproved,
    avgMarginPct: b.margins.length ? b.margins.reduce((a, c) => a + c, 0) / b.margins.length : null,
  }));
}

/**
 * Groups by `lead.created.payload.source`. `costCents` is always omitted —
 * no event in the current schema carries acquisition cost; the source
 * dashboard renders "no cost data" rather than imputing a number (§7).
 *
 * Same attribution limitation as `projectDayByRep`: `contract.signed` carries
 * no `leadId`, so it cannot be traced back to a source from the payload
 * alone — falls to the `UNKNOWN_SOURCE` bucket unless D4-4's
 * `resolveAttribution` (in @savvy/db) has attached a resolved `payload.source`
 * via its DB join, in which case that source is used (documented, tested).
 */
export function projectDayBySource(events: DomainEvent[], businessDate: string): DailyMetricsBySource[] {
  const day = events.filter((e) => businessDateOf(e.occurredAt) === businessDate);

  const sourceByLead = new Map<string, string>();
  const locationByLead = new Map<string, string>();
  for (const e of day) {
    if (e.type === "lead.created") {
      const leadId = field(e, "leadId");
      const source = field(e, "source");
      if (leadId && source) sourceByLead.set(leadId, source);
    }
    if (e.type === "lead.assigned") {
      const leadId = field(e, "leadId");
      if (leadId) locationByLead.set(leadId, field(e, "locationId") ?? UNKNOWN_LOCATION);
    }
  }

  interface Bucket { tenantId: string; locationId: string; source: string; leads: number; apptsSet: number; contracts: number; contractValueCents: number }
  const buckets = new Map<string, Bucket>();
  function bucketFor(tenantId: string, source: string, locationId: string): Bucket {
    const key = `${source}::${locationId}`;
    let b = buckets.get(key);
    if (!b) { b = { tenantId, locationId, source, leads: 0, apptsSet: 0, contracts: 0, contractValueCents: 0 }; buckets.set(key, b); }
    return b;
  }
  function resolve(leadId: string | undefined): { source: string; locationId: string } {
    if (!leadId) return { source: UNKNOWN_SOURCE, locationId: UNKNOWN_LOCATION };
    return { source: sourceByLead.get(leadId) ?? UNKNOWN_SOURCE, locationId: locationByLead.get(leadId) ?? UNKNOWN_LOCATION };
  }

  for (const e of day) {
    switch (e.type) {
      case "lead.created": {
        const source = field(e, "source") ?? UNKNOWN_SOURCE;
        const leadId = field(e, "leadId");
        const locationId = leadId ? locationByLead.get(leadId) ?? UNKNOWN_LOCATION : UNKNOWN_LOCATION;
        bucketFor(e.tenantId, source, locationId).leads += 1;
        break;
      }
      case "appointment.set": {
        const { source, locationId } = resolve(field(e, "leadId"));
        bucketFor(e.tenantId, source, locationId).apptsSet += 1;
        break;
      }
      case "contract.signed": {
        // no leadId on this event type — see doc comment above. source, when
        // attached by resolveAttribution, routes this to the real source.
        const p = e.payload as { contractValueCents: number };
        const source = field(e, "source") ?? UNKNOWN_SOURCE;
        const b = bucketFor(e.tenantId, source, UNKNOWN_LOCATION);
        b.contracts += 1;
        b.contractValueCents += p.contractValueCents;
        break;
      }
      default:
        break;
    }
  }

  return [...buckets.values()].map((b) => ({
    date: businessDate,
    tenantId: b.tenantId,
    locationId: b.locationId,
    source: b.source,
    leads: b.leads,
    apptsSet: b.apptsSet,
    contracts: b.contracts,
    contractValueCents: b.contractValueCents,
    // costCents intentionally omitted — no event carries acquisition cost.
  }));
}

/**
 * Groups events by their OWN `payload.locationId` field (no lead-chain
 * resolution — an event that doesn't carry the field lands in the
 * `UNKNOWN_LOCATION` bucket, per the attribution-edge-case note in the
 * brief), then reuses the existing `projectDay` fold per bucket. Because the
 * buckets are a strict partition of `day` (every event assigned to exactly
 * one bucket), summing any `DailyMetrics` count/sum field across the
 * returned rows equals `projectDay(events, businessDate)`'s value for that
 * field — the §8.2 invariant, by construction.
 *
 * Known limitation: most event types (`lead.created`, `contract.signed`,
 * `appointment.*`, `estimate.approved`, …) never carry `locationId` directly
 * in the current schema, so they always land in the `UNKNOWN_LOCATION`
 * bucket today. Fine for the current single-location reality; once a second
 * location exists this dimension needs either those events to start carrying
 * `locationId`, or a lead-chain resolution like `projectDayByRep` uses.
 */
export function projectDayByLocation(events: DomainEvent[], businessDate: string): DailyMetricsByLocation[] {
  const day = events.filter((e) => businessDateOf(e.occurredAt) === businessDate);

  const buckets = new Map<string, { tenantId: string; locationId: string; events: DomainEvent[] }>();
  for (const e of day) {
    const locationId = field(e, "locationId") ?? UNKNOWN_LOCATION;
    let b = buckets.get(locationId);
    if (!b) {
      b = { tenantId: e.tenantId, locationId, events: [] };
      buckets.set(locationId, b);
    }
    b.events.push(e);
  }

  return [...buckets.values()].map((b) => ({
    date: businessDate,
    tenantId: b.tenantId,
    locationId: b.locationId,
    metrics: projectDay(b.events, businessDate),
  }));
}
