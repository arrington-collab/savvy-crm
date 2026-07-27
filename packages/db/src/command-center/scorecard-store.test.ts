/**
 * D4-4 gate: dimensional persistence + rebuildDay against a real Postgres.
 * Mirrors bridge-e2e.test.ts / store.test.ts's seed/teardown shape.
 *
 * Scenario (single tenant, single business date D, three jobs):
 * - J1: linked to lead L1 (customerId C1, 1 lead) -> resolveAttribution's
 *   precise job.leadId -> lead path. contract.signed AND appointment.no_show
 *   both fire on J1 -> both should attribute to repA/source 'web', not the
 *   UNASSIGNED_REP/UNKNOWN_LOCATION sentinel.
 * - J2: NOT linked to a lead, but its customer C2 has TWO leads -> the
 *   honesty guard (brief's explicit case): ambiguous, must NOT guess ->
 *   contract.signed on J2 stays unattributed (persisted rep_id/source NULL
 *   translation aside, source has no valid single answer so it's UNKNOWN_SOURCE).
 * - J3: NOT linked to a lead, customer C3 has ZERO leads -> also unattributed
 *   (the 0-candidates arm of the same honesty guard), proven via
 *   estimate.approved, whose payload never carries customerId at all (see
 *   payloadSchemas in packages/orchestrator/src/events.ts) — this exercises
 *   the job.customerId fallback path, not the event-payload customerId one.
 */
import { it, expect, beforeAll, afterAll, describe } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { makeEvent } from "@savvy/orchestrator";
import { projectDay, weekStartOf } from "@savvy/command-center";
import { addDays } from "@savvy/core";
import { adminDb, tenant } from "../index";
import { user, customer, property, lead } from "../schema/index";
import { job } from "../schema/jobs";
import { orchestratorEvent } from "../schema/orchestrator";
import { dailyMetricsByRep, dailyMetricsBySource, dailyMetricsByLocation, weeklyScorecard } from "../schema/scorecard";
import {
  loadEventsForDay, rebuildDay, resolveAttribution, rebuildWeek,
  getDailyByRepRange, getDailyBySourceRange, getDailyByLocationRange,
} from "./scorecard-store";
import { withTenant } from "../tenant";

let tenantId: string;
let repAId: string, repBId: string;
let c1: string, c2: string, c3: string;
let l1: string; // C1's only lead
let l2a: string, l2b: string; // C2's TWO leads (honesty guard)
let j1: string, j2: string, j3: string;

const D = "2026-07-01";
const at = (h: number) => new Date(Date.UTC(2026, 6, 1, 6 + h)); // 6:00Z = 00:00 MDT, lands in day D

async function seedEvent(type: string, payload: Record<string, unknown>, idemSuffix: string) {
  const e = makeEvent({
    type: type as never, source: "savvy", tenantId, correlationId: idemSuffix,
    idempotencyKey: `${type}:${idemSuffix}`, occurredAt: at(1).toISOString(), payload: payload as never,
  });
  await adminDb.insert(orchestratorEvent).values({
    tenantId, eventId: e.id, eventType: e.type, version: e.version, source: e.source,
    correlationId: e.correlationId, idempotencyKey: e.idempotencyKey, agent: "system",
    outcome: "received", emitted: [], payload: e.payload as Record<string, unknown>, createdAt: at(1),
  });
}

beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "Scorecard-Store-Test", publicKey: `ss-${tenantId.slice(0, 8)}` });

  const [repA] = await adminDb.insert(user).values({ tenantId, name: "Rep A", email: `repa-${randomUUID()}@x.com` }).returning();
  const [repB] = await adminDb.insert(user).values({ tenantId, name: "Rep B", email: `repb-${randomUUID()}@x.com` }).returning();
  repAId = repA!.id; repBId = repB!.id;

  const [cust1] = await adminDb.insert(customer).values({ tenantId, name: "C1" }).returning();
  const [cust2] = await adminDb.insert(customer).values({ tenantId, name: "C2" }).returning();
  const [cust3] = await adminDb.insert(customer).values({ tenantId, name: "C3" }).returning();
  c1 = cust1!.id; c2 = cust2!.id; c3 = cust3!.id;

  const [p1] = await adminDb.insert(property).values({ tenantId, customerId: c1, address: "1 Main St" }).returning();
  const [p2] = await adminDb.insert(property).values({ tenantId, customerId: c2, address: "2 Main St" }).returning();
  const [p3] = await adminDb.insert(property).values({ tenantId, customerId: c3, address: "3 Main St" }).returning();

  const [lead1] = await adminDb.insert(lead).values({ tenantId, customerId: c1, assignedUserId: repAId, source: "web" }).returning();
  l1 = lead1!.id;
  // C2 has TWO leads -> ambiguous, the honesty guard must refuse to pick one.
  const [lead2a] = await adminDb.insert(lead).values({ tenantId, customerId: c2, assignedUserId: repBId, source: "canvass" }).returning();
  const [lead2b] = await adminDb.insert(lead).values({ tenantId, customerId: c2, assignedUserId: repAId, source: "referral" }).returning();
  l2a = lead2a!.id; l2b = lead2b!.id;
  // C3 has ZERO leads.

  const [job1] = await adminDb.insert(job).values({ tenantId, customerId: c1, propertyId: p1!.id, leadId: l1 }).returning();
  const [job2] = await adminDb.insert(job).values({ tenantId, customerId: c2, propertyId: p2!.id, leadId: null }).returning();
  const [job3] = await adminDb.insert(job).values({ tenantId, customerId: c3, propertyId: p3!.id, leadId: null }).returning();
  j1 = job1!.id; j2 = job2!.id; j3 = job3!.id;

  // J1 (precise path): contract.signed + appointment.no_show, both attributable via job.leadId -> L1 -> repA/web.
  await seedEvent("contract.signed", { jobId: j1, customerId: c1, contractValueCents: 500_000 }, "contract-j1");
  await seedEvent("appointment.no_show", { appointmentId: "appt-j1", jobId: j1 }, "noshow-j1");
  // J2 (honesty guard, >1 candidate leads): contract.signed must NOT be attributed.
  await seedEvent("contract.signed", { jobId: j2, customerId: c2, contractValueCents: 300_000 }, "contract-j2");
  // J3 (honesty guard, 0 candidate leads, via job.customerId fallback since estimate.approved carries no customerId): must NOT be attributed.
  await seedEvent("estimate.approved", { estimateId: "est-j3", jobId: j3, marginPct: 22 }, "estimate-j3");
});

afterAll(async () => {
  await adminDb.delete(dailyMetricsByRep).where(eq(dailyMetricsByRep.tenantId, tenantId));
  await adminDb.delete(dailyMetricsBySource).where(eq(dailyMetricsBySource.tenantId, tenantId));
  await adminDb.delete(dailyMetricsByLocation).where(eq(dailyMetricsByLocation.tenantId, tenantId));
  await adminDb.delete(orchestratorEvent).where(eq(orchestratorEvent.tenantId, tenantId));
  await adminDb.delete(job).where(eq(job.tenantId, tenantId));
  await adminDb.delete(lead).where(eq(lead.tenantId, tenantId));
  await adminDb.delete(property).where(eq(property.tenantId, tenantId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantId));
  await adminDb.delete(user).where(eq(user.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

describe("resolveAttribution", () => {
  it("attributes an event to the real rep/source via job.leadId -> lead (precise 1:1 path)", async () => {
    const events = await loadEventsForDay(tenantId, D);
    const enriched = await withTenant(tenantId, (tx) => resolveAttribution(tx, tenantId, events));
    const contract = enriched.find((e) => e.type === "contract.signed" && (e.payload as Record<string, unknown>).jobId === j1)!;
    expect((contract.payload as Record<string, unknown>).repId).toBe(repAId);
    expect((contract.payload as Record<string, unknown>).source).toBe("web");
  });

  it("honesty guard: a customer with 2 leads leaves the contract unattributed (does not guess)", async () => {
    const events = await loadEventsForDay(tenantId, D);
    const enriched = await withTenant(tenantId, (tx) => resolveAttribution(tx, tenantId, events));
    const contract = enriched.find((e) => e.type === "contract.signed" && (e.payload as Record<string, unknown>).jobId === j2)!;
    expect((contract.payload as Record<string, unknown>).repId).toBeUndefined();
    expect((contract.payload as Record<string, unknown>).source).toBeUndefined();
  });

  it("honesty guard: a customer with 0 leads (via job.customerId fallback, since estimate.approved carries no customerId) leaves the event unattributed", async () => {
    const events = await loadEventsForDay(tenantId, D);
    const enriched = await withTenant(tenantId, (tx) => resolveAttribution(tx, tenantId, events));
    const estimate = enriched.find((e) => e.type === "estimate.approved" && (e.payload as Record<string, unknown>).jobId === j3)!;
    expect((estimate.payload as Record<string, unknown>).repId).toBeUndefined();
  });
});

describe("rebuildDay", () => {
  it("persists dimensional rows with attributed contracts, unattributed events in the NULL-rep bucket, and is idempotent on re-run", async () => {
    await rebuildDay(tenantId, D);

    const byRep = await getDailyByRepRange(tenantId, D, D);
    const bySource = await getDailyBySourceRange(tenantId, D, D);
    const byLocation = await getDailyByLocationRange(tenantId, D, D);

    // repA's row: attributed contract (J1, 500_000) + attributed no-show (J1).
    const repARow = byRep.find((r) => r.repId === repAId);
    expect(repARow).toBeDefined();
    expect(repARow!.contracts).toBe(1);
    expect(repARow!.contractValueCents).toBe(500_000);
    expect(repARow!.noShows).toBe(1);
    expect(repARow!.locationId).toBeNull(); // lead has no locationId column (unchanged by D4-4)

    // Sentinel -> NULL: the unattributed J2 contract + J3 estimate land in the
    // NULL-rep row (rep_id is a uuid column; "unassigned" is not a valid uuid).
    const nullRepRow = byRep.find((r) => r.repId === null);
    expect(nullRepRow).toBeDefined();
    expect(nullRepRow!.contracts).toBe(1); // J2's contract
    expect(nullRepRow!.contractValueCents).toBe(300_000);
    expect(nullRepRow!.estimatesApproved).toBe(1); // J3's estimate

    // bySource: J1's contract resolves to 'web' (lead1.source); J2's stays 'unknown' text sentinel (not NULL-ed).
    const webRow = bySource.find((r) => r.source === "web");
    expect(webRow?.contracts).toBe(1);
    expect(webRow?.contractValueCents).toBe(500_000);
    const unknownSourceRow = bySource.find((r) => r.source === "unknown");
    expect(unknownSourceRow?.contracts).toBe(1);
    expect(unknownSourceRow?.contractValueCents).toBe(300_000);

    // byLocation: no event in this scenario carries locationId directly -> single NULL-location row.
    expect(byLocation).toHaveLength(1);
    expect(byLocation[0]!.locationId).toBeNull();

    const repRowCountBefore = byRep.length;
    const sourceRowCountBefore = bySource.length;
    const locationRowCountBefore = byLocation.length;

    // Idempotency: re-running rebuildDay for the same day must upsert in
    // place (NULLS NOT DISTINCT keys), not duplicate rows or double-count.
    await rebuildDay(tenantId, D);
    const byRep2 = await getDailyByRepRange(tenantId, D, D);
    const bySource2 = await getDailyBySourceRange(tenantId, D, D);
    const byLocation2 = await getDailyByLocationRange(tenantId, D, D);

    expect(byRep2).toHaveLength(repRowCountBefore);
    expect(bySource2).toHaveLength(sourceRowCountBefore);
    expect(byLocation2).toHaveLength(locationRowCountBefore);
    const repARow2 = byRep2.find((r) => r.repId === repAId);
    expect(repARow2!.contracts).toBe(1);
    expect(repARow2!.contractValueCents).toBe(500_000);
    const nullRepRow2 = byRep2.find((r) => r.repId === null);
    expect(nullRepRow2!.contracts).toBe(1);
    expect(nullRepRow2!.estimatesApproved).toBe(1);
  });

  it("§8.2 invariant at the table level: summing daily_metrics_by_rep rows (including the NULL-rep row) reproduces the company projectDay totals for the window", async () => {
    const rawEvents = await loadEventsForDay(tenantId, D);
    const company = projectDay(rawEvents, D);

    const byRep = await getDailyByRepRange(tenantId, D, D);
    const contractsSum = byRep.reduce((acc, r) => acc + r.contracts, 0);
    const contractValueSum = byRep.reduce((acc, r) => acc + r.contractValueCents, 0);
    const noShowSum = byRep.reduce((acc, r) => acc + r.noShows, 0);

    expect(contractsSum).toBe(company.topLine.contractsSigned);
    expect(contractValueSum).toBe(company.topLine.contractValueCents);
    expect(noShowSum).toBe(company.topLine.appointmentsNoShow);

    const bySource = await getDailyBySourceRange(tenantId, D, D);
    const sourceContractsSum = bySource.reduce((acc, r) => acc + r.contracts, 0);
    expect(sourceContractsSum).toBe(company.topLine.contractsSigned);
  });
});

/**
 * D4-6 gate: rebuildWeek against a real Postgres. Own tenant, own event
 * seed — a `lead.created` event stream across two consecutive weeks is
 * enough to exercise idempotency, replay, and the 13-week trailing-history
 * shift without needing the full close-rate/exceptions machinery (those are
 * smoke-checked, not exhaustively re-verified here — they're exercised at
 * the DB-join level by `resolveAttribution`'s tests above, and at the
 * pure-function level by @savvy/command-center's scorecard.test.ts).
 */
describe("rebuildWeek", () => {
  let wTenantId: string;
  const week0 = weekStartOf("2026-05-04"); // an arbitrary Monday, derived (not hand-computed) to avoid off-by-one day-of-week bugs
  const week1 = addDays(week0, 7);

  function seedTime(businessDate: string, h = 1): Date {
    // Same convention as the `at()` helper above: 6:00Z lands at 00:00 MDT
    // (Denver, DST). Both week0 and week1 fall inside Mar-Nov DST.
    return new Date(Date.parse(`${businessDate}T00:00:00.000Z`) + (6 + h) * 3_600_000);
  }

  async function seedLeadCreated(occurredAt: Date, source: string, idemSuffix: string) {
    const e = makeEvent({
      type: "lead.created", source: "savvy", tenantId: wTenantId, correlationId: idemSuffix,
      idempotencyKey: `lead.created:${idemSuffix}`, occurredAt: occurredAt.toISOString(),
      payload: { leadId: randomUUID(), customerId: randomUUID(), source },
    });
    await adminDb.insert(orchestratorEvent).values({
      tenantId: wTenantId, eventId: e.id, eventType: e.type, version: e.version, source: e.source,
      correlationId: e.correlationId, idempotencyKey: e.idempotencyKey, agent: "system",
      outcome: "received", emitted: [], payload: e.payload as Record<string, unknown>, createdAt: occurredAt,
    });
  }

  async function seedContractSigned(occurredAt: Date, idemSuffix: string) {
    const e = makeEvent({
      type: "contract.signed", source: "savvy", tenantId: wTenantId, correlationId: idemSuffix,
      idempotencyKey: `contract.signed:${idemSuffix}`, occurredAt: occurredAt.toISOString(),
      // No matching job/customer/lead rows exist for these ids -> the contract
      // stays unattributed to any lead (resolveContractSignings excludes it),
      // which is fine here: this test only needs the WEEK to have 0 leads.
      payload: { jobId: randomUUID(), customerId: randomUUID(), contractValueCents: 100_000 },
    });
    await adminDb.insert(orchestratorEvent).values({
      tenantId: wTenantId, eventId: e.id, eventType: e.type, version: e.version, source: e.source,
      correlationId: e.correlationId, idempotencyKey: e.idempotencyKey, agent: "system",
      outcome: "received", emitted: [], payload: e.payload as Record<string, unknown>, createdAt: occurredAt,
    });
  }

  async function weeklyRowsFor(weekStart: string) {
    return adminDb.select().from(weeklyScorecard).where(and(
      eq(weeklyScorecard.tenantId, wTenantId), eq(weeklyScorecard.weekStart, weekStart),
    ));
  }

  beforeAll(async () => {
    wTenantId = randomUUID();
    await adminDb.insert(tenant).values({ id: wTenantId, name: "RebuildWeek-Test", publicKey: `rw-${wTenantId.slice(0, 8)}` });

    // week0: 2 leads created on its Monday.
    await seedLeadCreated(seedTime(week0), "web", "w0-lead-1");
    await seedLeadCreated(seedTime(week0), "canvass", "w0-lead-2");
  });

  afterAll(async () => {
    await adminDb.delete(weeklyScorecard).where(eq(weeklyScorecard.tenantId, wTenantId));
    await adminDb.delete(dailyMetricsByRep).where(eq(dailyMetricsByRep.tenantId, wTenantId));
    await adminDb.delete(dailyMetricsBySource).where(eq(dailyMetricsBySource.tenantId, wTenantId));
    await adminDb.delete(dailyMetricsByLocation).where(eq(dailyMetricsByLocation.tenantId, wTenantId));
    await adminDb.delete(orchestratorEvent).where(eq(orchestratorEvent.tenantId, wTenantId));
    await adminDb.delete(tenant).where(eq(tenant.id, wTenantId));
  });

  it("rebuilds week0: one weekly_scorecard row per measurable (~10-15), leads.new = 2, priorWeeks = 12 nulls + current", async () => {
    await rebuildWeek(wTenantId, week0);

    const rows = await weeklyRowsFor(week0);
    expect(rows.length).toBeGreaterThanOrEqual(10);

    const leadsRow = rows.find((r) => r.metricKey === "leads.new")!;
    expect(leadsRow.value).toEqual({ status: "ok", value: 2 });
    expect(leadsRow.priorWeeks).toHaveLength(13);
    expect(leadsRow.priorWeeks.slice(0, 12)).toEqual(Array(12).fill(null)); // no prior weeks exist yet
    expect(leadsRow.priorWeeks[12]).toBe(2);

    // Every row carries the placeholder-goal flag honestly (none of these are real Brett/Scott targets yet).
    expect(rows.every((r) => r.goal !== null)).toBe(true);
  });

  it("idempotency (§8.9) + replay (§8.10): re-running rebuildWeek with no new events reproduces byte-identical rows, same row count", async () => {
    const before = await weeklyRowsFor(week0);

    await rebuildWeek(wTenantId, week0);

    const after = await weeklyRowsFor(week0);
    expect(after).toHaveLength(before.length);

    const byKey = (rows: typeof before) => new Map(rows.map((r) => [r.metricKey, r]));
    const b = byKey(before);
    const a = byKey(after);
    for (const [metricKey, row] of b) {
      const other = a.get(metricKey)!;
      expect(other.value).toEqual(row.value);
      expect(other.goal).toEqual(row.goal);
      expect(other.onTrack).toBe(row.onTrack);
      expect(other.priorWeeks).toEqual(row.priorWeeks);
    }
  });

  it("13-week window (§8.4): a new week (week1) carries week0 forward as its most recent prior entry, and week0's own row is untouched (shifts without corrupting history)", async () => {
    await seedLeadCreated(seedTime(week1), "web", "w1-lead-1");
    await seedLeadCreated(seedTime(week1), "web", "w1-lead-2");
    await seedLeadCreated(seedTime(week1), "canvass", "w1-lead-3");

    await rebuildWeek(wTenantId, week1);

    const week1Rows = await weeklyRowsFor(week1);
    const leadsRow1 = week1Rows.find((r) => r.metricKey === "leads.new")!;
    expect(leadsRow1.value).toEqual({ status: "ok", value: 3 });
    expect(leadsRow1.priorWeeks).toHaveLength(13);
    // trailingWeekStarts(week1, 13) oldest->newest ends [..., week0, week1] ->
    // week0 lands at index 11 (second-to-last), week1's own value at index 12.
    expect(leadsRow1.priorWeeks[11]).toBe(2);
    expect(leadsRow1.priorWeeks[12]).toBe(3);
    expect(leadsRow1.priorWeeks.slice(0, 11)).toEqual(Array(11).fill(null));

    // week0's own row must be untouched by rebuilding week1 (no corruption of history).
    const week0RowsAfter = await weeklyRowsFor(week0);
    const leadsRow0After = week0RowsAfter.find((r) => r.metricKey === "leads.new")!;
    expect(leadsRow0After.value).toEqual({ status: "ok", value: 2 });
    expect(leadsRow0After.priorWeeks[12]).toBe(2);
  });

  it("on/off-track evaluates against the configured (placeholder) goal", async () => {
    const week1Rows = await weeklyRowsFor(week1);
    const leadsRow = week1Rows.find((r) => r.metricKey === "leads.new")!;
    // DEFAULT_GOALS["leads.new"] = { target: 20, direction: "gte" } -> 3 leads is off-track.
    expect(leadsRow.onTrack).toBe(false);
    expect(leadsRow.goal).toMatchObject({ direction: "gte", isPlaceholder: true });
  });

  it("honesty guard: a zero-lead week with a contract signed degrades close_rate.activity/cohort to pending, never a fake ok(0)", async () => {
    const week2 = addDays(week1, 7);
    // 0 lead.created events this week, but >=1 contract.signed -> a naive
    // contracts/leads division would be 0/0, which closeRateActivity /
    // closeRateCohort guard internally to `rate: 0` (to avoid NaN). Without
    // the rebuildWeek-level pending guard, that 0 gets wrapped in ok(...) and
    // reads as a real, alarming "0% close rate" for a week where the metric
    // simply isn't computable.
    await seedContractSigned(seedTime(week2), "w2-contract-1");

    await rebuildWeek(wTenantId, week2);

    const rows = await weeklyRowsFor(week2);
    const activityRow = rows.find((r) => r.metricKey === "close_rate.activity")!;
    const cohortRow = rows.find((r) => r.metricKey === "close_rate.cohort")!;

    expect(activityRow.value).toMatchObject({ status: "pending" });
    expect((activityRow.value as { status: string }).status).not.toBe("ok");
    expect(cohortRow.value).toMatchObject({ status: "pending" });
    expect((cohortRow.value as { status: string }).status).not.toBe("ok");
  });
});
