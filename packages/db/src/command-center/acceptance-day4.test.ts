/**
 * Day 4 §8 acceptance — the 12 checks (spec
 * `docs/superpowers/specs/2026-07-27-day4-weekly-scorecard-design.md` §8 /
 * Appendix A) composed end-to-end against real Postgres, driving REAL
 * production functions (`rebuildDay`/`rebuildWeek`/`projectDay`/
 * `buildScorecard`/`foldRepWeek`/`rankReps`/`foldSourceWeek`/
 * `foldLocationWeek`/`sumLocationWeeks`/`getGoals`/`listCrews`) — nothing
 * reimplemented, mirroring `packages/command-center/src/acceptance.test.ts`
 * (Day 1's single-narrative acceptance test) and
 * `scorecard-store.test.ts`/`bridge-e2e.test.ts`'s seed/teardown shape.
 *
 * These are acceptance/characterization tests, not RED-first TDD: every seam
 * driven here already exists (D4-1..D4-10) and is expected to PASS.
 *
 * ARCHITECTURE NOTE (mirrors the Slice-D `acceptance-day3-real-db` learning
 * the D4-11 brief points at): `packages/db` cannot import `@savvy/agents`
 * (the reverse dependency is forbidden — see `lifecycle/lead-intake.ts`'s own
 * doc comment). All 12 §8 checks are satisfiable from `@savvy/command-center`
 * + `@savvy/db` alone (rebuildDay/rebuildWeek/projectDay/buildScorecard/
 * dimensional-fold live there), so no agents-side gap exists for Day 4 the
 * way it did for Day 3's `guardedSms`/`bridgeFirstTouch` — this single file
 * covers the full §8 list.
 *
 * A DISCOVERED (not introduced) LIMITATION, surfaced honestly rather than
 * silently worked around — see check §8.12 below: the frozen Day-3 event
 * schema (`packages/orchestrator/src/events.ts`) does not give
 * `lead.created`/`contract.signed`/`appointment.set` an official
 * `locationId` field (only `lead.first_touch`/`lead.assigned`/comms events
 * do) — `dimensional.ts`'s own doc comment calls this out as a "known
 * limitation," and the spec's own §9 names it as the deliberate future
 * extension point. Every real lead/contract/appointment event lands in the
 * `UNKNOWN_LOCATION` bucket today. §8.12 attaches `locationId` directly on
 * the raw event payload (legal at the storage layer — payload is jsonb, and
 * `field()` reads it generically, zero reimplementation of dimensional.ts's
 * own logic) to exercise the fold/sum invariant with a realistic
 * multi-location shape ahead of that schema extension. This is a test-only
 * choice, not a production change, and not a Day-4 bug — flagged in the
 * D4-11 report.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { makeEvent } from "@savvy/orchestrator";
import {
  projectDay, weekStartOf, weekDates, denverWeekWindow, denverDayWindow,
  foldRepWeek, rankReps, foldSourceWeek, foldLocationWeek, sumLocationWeeks, MIN_LEADS_FOR_RANK,
  evaluateOnTrack, type MetricValue, type GoalConfig,
} from "@savvy/command-center";
import { addDays } from "@savvy/core";
import { adminDb, tenant, listCrews } from "../index";
import { customer, property, lead } from "../schema/index";
import { job } from "../schema/jobs";
import { crew } from "../schema/crew";
import { orchestratorEvent } from "../schema/orchestrator";
import { dailyMetricsByRep, dailyMetricsBySource, dailyMetricsByLocation, weeklyScorecard, scorecardGoal } from "../schema/scorecard";
import {
  rebuildDay, rebuildWeek, getDailyByRepRange, getDailyBySourceRange, getDailyByLocationRange, loadEventsForDay,
} from "./scorecard-store";
import { getGoals } from "./scorecard-goals";

let tenantId: string;
let repHighId: string;
let repLowId: string;

// The rich, shared fixture week most checks (1,2,4,5,7,8,9,10,11) narrate
// against — pushed to 2027 so its 12-prior-weeks trailing window (§8.4)
// never accidentally reaches back into any of the OTHER dedicated weeks
// below (all in 2026), which are >12 weeks earlier.
const WEEK_FOLD = weekStartOf("2027-03-01");
const WEEK_FOLD_NEXT = addDays(WEEK_FOLD, 7);

// §8.3 week-boundary pair (normal week).
const WEEK_B0 = weekStartOf("2026-09-07");
const WEEK_B1 = addDays(WEEK_B0, 7);

// §8.3 week-boundary pair spanning the Nov-1-2026 DST fall-back (a 25-hour
// Sunday) — same boundary proof, but across the one week of the year where a
// naive 168-hour assumption would silently misbucket the boundary event.
const WEEK_DST0 = "2026-10-26";
const WEEK_DST1 = addDays(WEEK_DST0, 7);

// §8.6 cohort-vs-activity pair: WEEK_COHORT is "this week"; WEEK_OLD is 3
// weeks earlier (the "lead created 3 weeks ago" the brief calls out).
const WEEK_COHORT = weekStartOf("2026-06-01");
const WEEK_OLD = addDays(WEEK_COHORT, -21);

// §8.12 multi-location week.
const WEEK_LOC = weekStartOf("2026-08-17");

// Hand-tracked expected totals for WEEK_FOLD, incremented alongside each
// seedEvent call below — an independent third tally (alongside projectDay's
// own recomputation in check §8.1 and rebuildWeek's persisted output) so
// "fold correctness" is proven by three independently-arrived-at numbers
// agreeing, not by the test trusting the one function under test.
const expected = { leadsTotal: 0, contractsCount: 0, contractsValueCents: 0, apptsSet: 0, apptsNoShow: 0 };

// Set by check §8.1, reused by §8.2/§8.4 — the independently-computed
// (via projectDay, not rebuildWeek) company totals for WEEK_FOLD.
let companyTotals: { leadsTotal: number; contractsCount: number; contractsValueCents: number; appointmentsSet: number; appointmentsNoShow: number };

// Set by check §8.9, reused by §8.10 (replay must match idempotency's "after").
let idempotentSnapshot: { metricKey: string; value: unknown; goal: unknown; onTrack: boolean | null; priorWeeks: unknown }[];

// The 12 §8 checks' pass markers — the final test prints these as the
// pass/fail summary the D4-11 brief asks for. Each `it()` calls `mark(n, …)`
// as its LAST statement, so a thrown `expect` failure above it never reaches
// the mark — vitest still fails the suite; this array is a human-readable
// summary on top of that, not a replacement for it.
const results: { n: number; title: string }[] = [];
function mark(n: number, title: string) {
  results.push({ n, title });
}

/** Denver wall-clock instant: `businessDate`'s Denver midnight + `offsetSeconds`. DST-safe (delegates to denverDayWindow). */
function denverTime(businessDate: string, offsetSeconds: number): Date {
  const { startUtc } = denverDayWindow(businessDate);
  return new Date(startUtc.getTime() + offsetSeconds * 1000);
}

async function seedEvent(type: string, payload: Record<string, unknown>, occurredAt: Date, idemSuffix: string) {
  const e = makeEvent({
    type: type as never, source: "savvy", tenantId, correlationId: idemSuffix,
    idempotencyKey: `${type}:${idemSuffix}`, occurredAt: occurredAt.toISOString(), payload: payload as never,
  });
  await adminDb.insert(orchestratorEvent).values({
    tenantId, eventId: e.id, eventType: e.type, version: e.version, source: e.source,
    correlationId: e.correlationId, idempotencyKey: e.idempotencyKey, agent: "system",
    outcome: "received", emitted: [], payload: e.payload as Record<string, unknown>, createdAt: occurredAt,
  });
}

async function weeklyRowsFor(weekStart: string) {
  return adminDb.select().from(weeklyScorecard).where(and(
    eq(weeklyScorecard.tenantId, tenantId), eq(weeklyScorecard.weekStart, weekStart),
  ));
}

beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "Day4-Accept", publicKey: `d4a-${tenantId.slice(0, 8)}` });
  repHighId = randomUUID();
  repLowId = randomUUID();

  // ---- WEEK_FOLD fixture (checks 1,2,4,5,7,8,9,10,11) ----
  const [D0, D1, D2, D3, D4, D5] = weekDates(WEEK_FOLD);

  // General topline activity, spread over 3 days (not uniform — a real fold test).
  await seedEvent("lead.created", { leadId: randomUUID(), customerId: randomUUID(), source: "web" }, denverTime(D0!, 3600), "wf-lead-1");
  await seedEvent("lead.created", { leadId: randomUUID(), customerId: randomUUID(), source: "web" }, denverTime(D0!, 3700), "wf-lead-2");
  expected.leadsTotal += 2;
  await seedEvent("appointment.set", { appointmentId: randomUUID(), scheduledAt: denverTime(D0!, 7200).toISOString() }, denverTime(D0!, 3800), "wf-appt-1");
  expected.apptsSet += 1;

  await seedEvent("lead.created", { leadId: randomUUID(), customerId: randomUUID(), source: "canvass" }, denverTime(D1!, 3600), "wf-lead-3");
  expected.leadsTotal += 1;
  await seedEvent("appointment.no_show", { appointmentId: randomUUID() }, denverTime(D1!, 4000), "wf-noshow-1");
  expected.apptsNoShow += 1;
  // No customerId — an intentionally unresolvable job/customer, so resolveAttribution
  // leaves it in the sentinel buckets (contractValueCents/contracts still count company-wide).
  await seedEvent("contract.signed", { jobId: randomUUID(), contractValueCents: 300_000 }, denverTime(D1!, 4200), "wf-contract-general");
  expected.contractsCount += 1;
  expected.contractsValueCents += 300_000;

  await seedEvent("lead.created", { leadId: randomUUID(), customerId: randomUUID(), source: "web" }, denverTime(D2!, 3600), "wf-lead-4");
  expected.leadsTotal += 1;
  await seedEvent("appointment.set", { appointmentId: randomUUID(), scheduledAt: denverTime(D2!, 7200).toISOString() }, denverTime(D2!, 3900), "wf-appt-2");
  expected.apptsSet += 1;

  // §8.11 rep fixture: repHigh has >= MIN_LEADS_FOR_RANK leads; repLow has fewer
  // leads but a BIGGER contract — proving insufficientVolume is about volume,
  // not value. `repId` is attached directly to lead.assigned (an OFFICIAL field
  // on that event type) and to contract.signed's payload (bypassing the
  // resolveAttribution DB-join path on purpose — that join is already
  // thoroughly exercised by scorecard-store.test.ts's `resolveAttribution`
  // describe block; this fixture isolates the §8.11 low-volume-guard logic
  // itself instead of re-proving attribution). No `customerId`/resolvable
  // `jobId` is given, so resolveAttribution's DB join is a documented no-op
  // (0 candidates) and returns the event UNCHANGED, preserving the repId.
  for (let i = 0; i < MIN_LEADS_FOR_RANK; i++) {
    const leadId = randomUUID();
    await seedEvent("lead.created", { leadId, customerId: randomUUID(), source: "web" }, denverTime(D3!, 3600 + i * 10), `wf-rephigh-lead-${i}`);
    await seedEvent("lead.assigned", { leadId, userId: repHighId, repId: repHighId, locationId: null }, denverTime(D3!, 3610 + i * 10), `wf-rephigh-assign-${i}`);
  }
  expected.leadsTotal += MIN_LEADS_FOR_RANK;
  await seedEvent("contract.signed", { jobId: randomUUID(), contractValueCents: 400_000, repId: repHighId }, denverTime(D3!, 5000), "wf-rephigh-contract");
  expected.contractsCount += 1;
  expected.contractsValueCents += 400_000;

  const lowLeadCount = MIN_LEADS_FOR_RANK - 3;
  for (let i = 0; i < lowLeadCount; i++) {
    const leadId = randomUUID();
    await seedEvent("lead.created", { leadId, customerId: randomUUID(), source: "canvass" }, denverTime(D4!, 3600 + i * 10), `wf-replow-lead-${i}`);
    await seedEvent("lead.assigned", { leadId, userId: repLowId, repId: repLowId, locationId: null }, denverTime(D4!, 3610 + i * 10), `wf-replow-assign-${i}`);
  }
  expected.leadsTotal += lowLeadCount;
  // Bigger contract than repHigh's, despite far fewer leads.
  await seedEvent("contract.signed", { jobId: randomUUID(), contractValueCents: 900_000, repId: repLowId }, denverTime(D4!, 5000), "wf-replow-contract");
  expected.contractsCount += 1;
  expected.contractsValueCents += 900_000;

  // §8.7 speed fixture: slaLatencySeconds must win over latencySeconds, and a
  // quiet-hours-deferred touch must never count as a breach (mirrors
  // weekly.test.ts's pure fixture, driven here through the real DB pipeline).
  await seedEvent("lead.first_touch", { leadId: "l-speed-1", channel: "sms", latencySeconds: 10_000, slaLatencySeconds: 10 }, denverTime(D5!, 3600), "wf-speed-1");
  await seedEvent("lead.first_touch", { leadId: "l-speed-2", channel: "sms", latencySeconds: 36_000, quietHoursDeferred: true }, denverTime(D5!, 3700), "wf-speed-2");
  await seedEvent("lead.first_touch", { leadId: "l-speed-3", channel: "sms", latencySeconds: 600 }, denverTime(D5!, 3800), "wf-speed-3");
});

afterAll(async () => {
  await adminDb.delete(weeklyScorecard).where(eq(weeklyScorecard.tenantId, tenantId));
  await adminDb.delete(scorecardGoal).where(eq(scorecardGoal.tenantId, tenantId));
  await adminDb.delete(dailyMetricsByRep).where(eq(dailyMetricsByRep.tenantId, tenantId));
  await adminDb.delete(dailyMetricsBySource).where(eq(dailyMetricsBySource.tenantId, tenantId));
  await adminDb.delete(dailyMetricsByLocation).where(eq(dailyMetricsByLocation.tenantId, tenantId));
  await adminDb.delete(orchestratorEvent).where(eq(orchestratorEvent.tenantId, tenantId));
  await adminDb.delete(job).where(eq(job.tenantId, tenantId));
  await adminDb.delete(lead).where(eq(lead.tenantId, tenantId));
  await adminDb.delete(property).where(eq(property.tenantId, tenantId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantId));
  await adminDb.delete(crew).where(eq(crew.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

describe("Day 4 §8 acceptance — real functions × real Postgres", () => {
  it("§8.1 fold correctness: weekly totals === sum of daily rows — proven by 3 independent tallies agreeing (hand-tracked, projectDay, rebuildWeek)", async () => {
    await rebuildWeek(tenantId, WEEK_FOLD);

    // Independent cross-check: recompute the week's totals via Day-1's OWN
    // projectDay over each day's real loaded events — a genuinely different
    // code path from rebuildWeek's internal fold.
    const days = weekDates(WEEK_FOLD);
    let leadsTotal = 0, contractsCount = 0, contractsValueCents = 0, appointmentsSet = 0, appointmentsNoShow = 0;
    for (const d of days) {
      const events = await loadEventsForDay(tenantId, d);
      const day = projectDay(events, d);
      leadsTotal += day.topLine.leadsTotal;
      contractsCount += day.topLine.contractsSigned;
      contractsValueCents += day.topLine.contractValueCents;
      appointmentsSet += day.topLine.appointmentsSet;
      appointmentsNoShow += day.topLine.appointmentsNoShow;
    }
    companyTotals = { leadsTotal, contractsCount, contractsValueCents, appointmentsSet, appointmentsNoShow };

    // Tally #1 (hand-tracked) vs tally #2 (projectDay) agree.
    expect(companyTotals.leadsTotal).toBe(expected.leadsTotal);
    expect(companyTotals.contractsCount).toBe(expected.contractsCount);
    expect(companyTotals.contractsValueCents).toBe(expected.contractsValueCents);
    expect(companyTotals.appointmentsSet).toBe(expected.apptsSet);
    expect(companyTotals.appointmentsNoShow).toBe(expected.apptsNoShow);

    // Tally #3 (rebuildWeek's persisted weekly_scorecard) agrees with both.
    const rows = await weeklyRowsFor(WEEK_FOLD);
    const val = (mk: string) => rows.find((r) => r.metricKey === mk)!.value as { status: string; value?: number };
    expect(val("leads.new")).toEqual({ status: "ok", value: companyTotals.leadsTotal });
    expect(val("contracts.count")).toEqual({ status: "ok", value: companyTotals.contractsCount });
    expect(val("contracts.value")).toEqual({ status: "ok", value: companyTotals.contractsValueCents });
    expect(val("appts.set")).toEqual({ status: "ok", value: companyTotals.appointmentsSet });

    mark(1, `fold correctness: leads=${companyTotals.leadsTotal} contracts=${companyTotals.contractsCount}/${companyTotals.contractsValueCents}¢ — hand-tracked, projectDay, and rebuildWeek all agree`);
  });

  it("§8.2 dimensional split: rep/source/location daily rows sum back to the independently-computed company total (no double-count/drop)", async () => {
    const days = weekDates(WEEK_FOLD);
    const byRep = await getDailyByRepRange(tenantId, days[0]!, days[6]!);
    const bySource = await getDailyBySourceRange(tenantId, days[0]!, days[6]!);
    const byLocation = await getDailyByLocationRange(tenantId, days[0]!, days[6]!);

    const repLeadsSum = byRep.reduce((a, r) => a + r.leads, 0);
    const repContractsSum = byRep.reduce((a, r) => a + r.contracts, 0);
    const repContractValueSum = byRep.reduce((a, r) => a + r.contractValueCents, 0);
    expect(repLeadsSum).toBe(companyTotals.leadsTotal);
    expect(repContractsSum).toBe(companyTotals.contractsCount);
    expect(repContractValueSum).toBe(companyTotals.contractsValueCents);

    const sourceLeadsSum = bySource.reduce((a, r) => a + r.leads, 0);
    const sourceContractsSum = bySource.reduce((a, r) => a + r.contracts, 0);
    expect(sourceLeadsSum).toBe(companyTotals.leadsTotal);
    expect(sourceContractsSum).toBe(companyTotals.contractsCount);

    const locationTotal = sumLocationWeeks(foldLocationWeek(byLocation));
    expect(locationTotal.leads).toBe(companyTotals.leadsTotal);
    expect(locationTotal.contracts).toBe(companyTotals.contractsCount);
    expect(locationTotal.contractValueCents).toBe(companyTotals.contractsValueCents);

    mark(2, "dimensional split: rep, source, AND location daily rows each sum back to the same independently-computed company total");
  });

  it("§8.3 week boundary: an event at Sun 23:59 MT and one at Mon 00:01 MT land in different weeks — including the DST week (25-hour Sunday)", async () => {
    // The exact Denver day/week boundary — the true wall-clock instant a naive
    // 168-hour week assumption would get wrong on a DST week.
    const normalBoundary = denverWeekWindow(WEEK_B0).endUtc;
    await seedEvent("lead.created", { leadId: randomUUID(), customerId: randomUUID(), source: "web" }, new Date(normalBoundary.getTime() - 1000), "b0-late-sunday");
    await seedEvent("lead.created", { leadId: randomUUID(), customerId: randomUUID(), source: "web" }, new Date(normalBoundary.getTime() + 1000), "b1-early-monday");

    const dstBoundary = denverWeekWindow(WEEK_DST0).endUtc; // Sunday 2026-11-01 (25h) -> Monday 2026-11-02
    await seedEvent("lead.created", { leadId: randomUUID(), customerId: randomUUID(), source: "web" }, new Date(dstBoundary.getTime() - 1000), "dst0-late-sunday");
    await seedEvent("lead.created", { leadId: randomUUID(), customerId: randomUUID(), source: "web" }, new Date(dstBoundary.getTime() + 1000), "dst1-early-monday");

    await rebuildWeek(tenantId, WEEK_B0);
    await rebuildWeek(tenantId, WEEK_B1);
    await rebuildWeek(tenantId, WEEK_DST0);
    await rebuildWeek(tenantId, WEEK_DST1);

    const leadsIn = async (weekStart: string) => (await weeklyRowsFor(weekStart)).find((r) => r.metricKey === "leads.new")!.value;
    expect(await leadsIn(WEEK_B0)).toEqual({ status: "ok", value: 1 });
    expect(await leadsIn(WEEK_B1)).toEqual({ status: "ok", value: 1 });
    expect(await leadsIn(WEEK_DST0)).toEqual({ status: "ok", value: 1 });
    expect(await leadsIn(WEEK_DST1)).toEqual({ status: "ok", value: 1 });

    mark(3, "week boundary: Sun-end/Mon-start events land in the correct week, both on a normal week and the DST fall-back week");
  });

  it("§8.4 13-week window: a new week shifts forward without corrupting the prior week's own history", async () => {
    await seedEvent("lead.created", { leadId: randomUUID(), customerId: randomUUID(), source: "web" }, denverTime(weekDates(WEEK_FOLD_NEXT)[0]!, 3600), "wfn-lead-1");
    await seedEvent("lead.created", { leadId: randomUUID(), customerId: randomUUID(), source: "canvass" }, denverTime(weekDates(WEEK_FOLD_NEXT)[1]!, 3600), "wfn-lead-2");

    await rebuildWeek(tenantId, WEEK_FOLD_NEXT);

    const nextRows = await weeklyRowsFor(WEEK_FOLD_NEXT);
    const nextLeads = nextRows.find((r) => r.metricKey === "leads.new")!;
    expect(nextLeads.value).toEqual({ status: "ok", value: 2 });
    expect(nextLeads.priorWeeks).toHaveLength(13);
    expect(nextLeads.priorWeeks[11]).toBe(companyTotals.leadsTotal); // WEEK_FOLD carried forward as the most-recent prior entry
    expect(nextLeads.priorWeeks[12]).toBe(2); // this week's own value
    expect(nextLeads.priorWeeks.slice(0, 11)).toEqual(Array(11).fill(null));

    // WEEK_FOLD's own row must be untouched by building a later week.
    const foldRowsAfter = await weeklyRowsFor(WEEK_FOLD);
    const foldLeadsAfter = foldRowsAfter.find((r) => r.metricKey === "leads.new")!;
    expect(foldLeadsAfter.value).toEqual({ status: "ok", value: companyTotals.leadsTotal });

    mark(4, "13-week trailing window shifts forward on a new week; the prior week's own row is untouched");
  });

  it("§8.5 on/off-track evaluates against the configured (real, non-placeholder) goal, and off-track rows sort first", async () => {
    const offTrackTarget = companyTotals.leadsTotal + 1000; // impossible to hit this week -> off-track
    const onTrackTarget = companyTotals.contractsValueCents - 1; // already exceeded -> on-track
    await adminDb.insert(scorecardGoal).values([
      { tenantId, locationId: null, metricKey: "leads.new", target: offTrackTarget, direction: "gte", isPlaceholder: false },
      { tenantId, locationId: null, metricKey: "contracts.value", target: onTrackTarget, direction: "gte", isPlaceholder: false },
    ]);

    const goals = await getGoals(tenantId, null);
    expect(goals["leads.new"]).toEqual({ target: offTrackTarget, direction: "gte", isPlaceholder: false });

    await rebuildWeek(tenantId, WEEK_FOLD);

    const rows = await weeklyRowsFor(WEEK_FOLD);
    const leadsRow = rows.find((r) => r.metricKey === "leads.new")!;
    const contractsValueRow = rows.find((r) => r.metricKey === "contracts.value")!;

    expect(leadsRow.onTrack).toBe(false);
    expect(leadsRow.goal).toMatchObject({ target: offTrackTarget, direction: "gte", isPlaceholder: false });
    expect(contractsValueRow.onTrack).toBe(true);

    // Cross-check the persisted onTrack against the pure evaluateOnTrack rule directly.
    expect(evaluateOnTrack(leadsRow.value as MetricValue, leadsRow.goal as GoalConfig)).toBe(false);
    expect(evaluateOnTrack(contractsValueRow.value as MetricValue, contractsValueRow.goal as GoalConfig)).toBe(true);

    // Off-track-first sort (mirrors scorecard.ts's onTrackRank / weekly-scorecard-push.ts's own copy).
    const rank = (t: boolean | null) => (t === false ? 0 : t === null ? 1 : 2);
    const sorted = [...rows].sort((a, b) => rank(a.onTrack) - rank(b.onTrack));
    expect(sorted.findIndex((r) => r.metricKey === "leads.new")).toBeLessThan(sorted.findIndex((r) => r.metricKey === "contracts.value"));

    mark(5, "on/off-track evaluates against a real configured goal (not just the placeholder default); off-track rows sort first");
  });

  it("§8.6 cohort vs activity close rate diverge on a lagged fixture, and a lagged contract attributes to its OWN lead's cohort week", async () => {
    const [cA] = await adminDb.insert(customer).values({ tenantId, name: "Cohort Customer A" }).returning();
    const [pA] = await adminDb.insert(property).values({ tenantId, customerId: cA!.id, address: "1 Cohort Ave" }).returning();
    const [leadA] = await adminDb.insert(lead).values({ tenantId, customerId: cA!.id, createdAt: denverTime(weekDates(WEEK_COHORT)[2]!, 3600) }).returning();
    const [jobA] = await adminDb.insert(job).values({ tenantId, customerId: cA!.id, propertyId: pA!.id, leadId: leadA!.id }).returning();

    // B and C are created in WEEK_COHORT but never sign — pure denominator weight.
    const [leadB] = await adminDb.insert(lead).values({ tenantId, createdAt: denverTime(weekDates(WEEK_COHORT)[1]!, 3600) }).returning();
    const [leadC] = await adminDb.insert(lead).values({ tenantId, createdAt: denverTime(weekDates(WEEK_COHORT)[3]!, 3600) }).returning();

    // The "lead created 3 weeks ago" the brief calls out: created in WEEK_OLD,
    // but its contract signs THIS week (WEEK_COHORT) — activity throughput
    // counts it now; cohort must NOT (it belongs to WEEK_OLD's cohort).
    const [cOld] = await adminDb.insert(customer).values({ tenantId, name: "Cohort Customer Old" }).returning();
    const [pOld] = await adminDb.insert(property).values({ tenantId, customerId: cOld!.id, address: "1 Old Rd" }).returning();
    const [leadOld] = await adminDb.insert(lead).values({ tenantId, customerId: cOld!.id, createdAt: denverTime(weekDates(WEEK_OLD)[0]!, 3600) }).returning();
    const [jobOld] = await adminDb.insert(job).values({ tenantId, customerId: cOld!.id, propertyId: pOld!.id, leadId: leadOld!.id }).returning();

    // `close_rate.cohort`'s "leads created in week" denominator reads the real
    // `lead` table (createdAt above); `close_rate.activity`'s denominator
    // reads `topLine.leadsTotal`, which projectWeek re-derives from
    // `lead.created` EVENTS, not the `lead` table — so each DB lead row also
    // needs its own `lead.created` event, same leadId, same instant.
    await seedEvent("lead.created", { leadId: leadA!.id, customerId: cA!.id, source: "web" }, denverTime(weekDates(WEEK_COHORT)[2]!, 3600), "cohort-lead-a");
    await seedEvent("lead.created", { leadId: leadB!.id, customerId: randomUUID(), source: "web" }, denverTime(weekDates(WEEK_COHORT)[1]!, 3600), "cohort-lead-b");
    await seedEvent("lead.created", { leadId: leadC!.id, customerId: randomUUID(), source: "canvass" }, denverTime(weekDates(WEEK_COHORT)[3]!, 3600), "cohort-lead-c");
    await seedEvent("lead.created", { leadId: leadOld!.id, customerId: cOld!.id, source: "web" }, denverTime(weekDates(WEEK_OLD)[0]!, 3600), "old-lead");

    await seedEvent("contract.signed", { jobId: jobA!.id, contractValueCents: 100_000 }, denverTime(weekDates(WEEK_COHORT)[4]!, 3600), "cohort-contract-a");
    await seedEvent("contract.signed", { jobId: jobOld!.id, contractValueCents: 200_000 }, denverTime(weekDates(WEEK_COHORT)[4]!, 7200), "cohort-contract-old");

    await rebuildWeek(tenantId, WEEK_COHORT);
    await rebuildWeek(tenantId, WEEK_OLD);

    const cohortRows = await weeklyRowsFor(WEEK_COHORT);
    const cohortRate = cohortRows.find((r) => r.metricKey === "close_rate.cohort")!.value as { status: string; value?: number };
    const activityRate = cohortRows.find((r) => r.metricKey === "close_rate.activity")!.value as { status: string; value?: number };

    expect(cohortRate.status).toBe("ok");
    expect(cohortRate.value).toBeCloseTo(1 / 3); // only leadA (created in-week) has signed
    expect(activityRate.status).toBe("ok");
    expect(activityRate.value).toBeCloseTo(2 / 3); // both contracts signed THIS week count toward throughput
    expect(cohortRate.value).not.toBe(activityRate.value);

    const oldRows = await weeklyRowsFor(WEEK_OLD);
    const oldCohortRate = oldRows.find((r) => r.metricKey === "close_rate.cohort")!.value as { status: string; value?: number };
    expect(oldCohortRate.status).toBe("ok");
    expect(oldCohortRate.value).toBeCloseTo(1); // leadOld was the ONLY lead created that week, and it did (eventually) sign

    mark(6, "cohort (1/3) vs activity (2/3) close rate diverge on a lagged fixture; the old lead's contract attributes to its own cohort week, not this one");
  });

  it("§8.7 speed uses slaLatencySeconds ?? latencySeconds; a quiet-hours-deferred touch is never counted as a breach", async () => {
    const rows = await weeklyRowsFor(WEEK_FOLD);
    const pctUnderSla = rows.find((r) => r.metricKey === "speed.pct_under_sla")!.value as { status: string; value?: number };
    expect(pctUnderSla.status).toBe("ok");
    // l-speed-1 (slaLatencySeconds override -> compliant) + l-speed-2 (quiet-hours exempt -> compliant); l-speed-3 breaches.
    expect(pctUnderSla.value).toBeCloseTo(2 / 3);

    mark(7, "speed.pct_under_sla = 2/3: slaLatencySeconds wins over latencySeconds, quiet-hours-deferred is never a breach");
  });

  it("§8.8 degradation: crew renders a structural 'awaiting' state (never a fabricated 0); source cost folds to null, never $0", async () => {
    // crew half — listCrews (the real function the crew report page calls)
    // returns a shape with NO squares/hours/cost fields at all: it is
    // structurally impossible for any consumer to render a real number here
    // today (Day 12 hasn't shipped crew.hours.logged/job.completed/
    // job.cost.actual yet), which is exactly why apps/web's crew report page
    // renders "awaiting crew app" instead of a fabricated 0.
    const [c] = await adminDb.insert(crew).values({ tenantId, name: "Crew Acceptance" }).returning();
    const crews = await listCrews(tenantId);
    const crewRow = crews.find((x) => x.id === c!.id)!;
    expect(crewRow).toBeDefined();
    expect(Object.keys(crewRow).sort()).toEqual(["active", "baseLat", "baseLng", "hasPin", "id", "members", "name"]);

    // cost half — no event in the current schema ever carries acquisition
    // cost (dimensional.ts's own doc comment), so daily_metrics_by_source
    // NEVER persists a real costCents figure; foldSourceWeek must fold that
    // to null, never impute a $0 spend day.
    const days = weekDates(WEEK_FOLD);
    const bySource = await getDailyBySourceRange(tenantId, days[0]!, days[6]!);
    expect(bySource.length).toBeGreaterThan(0);
    expect(bySource.every((r) => r.costCents === null)).toBe(true);
    const foldedSources = foldSourceWeek(bySource);
    expect(foldedSources.length).toBeGreaterThan(0);
    expect(foldedSources.every((r) => r.costCents === null)).toBe(true);

    mark(8, "degradation: crew data layer has no numeric contract yet (structurally honest 'awaiting'); source cost is null, never a fabricated $0");
  });

  it("§8.9 idempotency: re-running rebuildWeek yields exactly one row per (weekStart, locationId, metricKey), values unchanged", async () => {
    const before = await weeklyRowsFor(WEEK_FOLD);
    await rebuildWeek(tenantId, WEEK_FOLD);
    const after = await weeklyRowsFor(WEEK_FOLD);

    expect(after.length).toBe(before.length);
    const countByKey = new Map<string, number>();
    for (const r of after) countByKey.set(r.metricKey, (countByKey.get(r.metricKey) ?? 0) + 1);
    for (const [, count] of countByKey) expect(count).toBe(1);

    const beforeByKey = new Map(before.map((r) => [r.metricKey, r]));
    for (const a of after) {
      const b = beforeByKey.get(a.metricKey)!;
      expect(a.value).toEqual(b.value);
      expect(a.goal).toEqual(b.goal);
      expect(a.onTrack).toBe(b.onTrack);
      expect(a.priorWeeks).toEqual(b.priorWeeks);
    }

    idempotentSnapshot = after.map((r) => ({ metricKey: r.metricKey, value: r.value, goal: r.goal, onTrack: r.onTrack, priorWeeks: r.priorWeeks }));
    mark(9, `idempotency: ${countByKey.size} distinct metricKeys, exactly 1 row each after re-running rebuildWeek`);
  });

  it("§8.10 replay: rebuildWeek on unchanged input reproduces byte-identical rows", async () => {
    await rebuildWeek(tenantId, WEEK_FOLD);
    const after = await weeklyRowsFor(WEEK_FOLD);
    const priorByKey = new Map(idempotentSnapshot.map((r) => [r.metricKey, r]));

    expect(after.length).toBe(idempotentSnapshot.length);
    for (const r of after) {
      const prior = priorByKey.get(r.metricKey)!;
      expect(r.value).toEqual(prior.value);
      expect(r.goal).toEqual(prior.goal);
      expect(r.onTrack).toBe(prior.onTrack);
      expect(r.priorWeeks).toEqual(prior.priorWeeks);
    }

    mark(10, "replay: rebuildWeek re-run on unchanged input reproduces identical value/goal/onTrack/priorWeeks for every metricKey");
  });

  it("§8.11 low-volume guard: a rep under MIN_LEADS_FOR_RANK shows insufficient volume, never a misleading rank — even with MORE revenue", async () => {
    const days = weekDates(WEEK_FOLD);
    const byRep = await getDailyByRepRange(tenantId, days[0]!, days[6]!);
    const ranked = rankReps(foldRepWeek(byRep));

    const high = ranked.find((r) => r.repId === repHighId)!;
    const low = ranked.find((r) => r.repId === repLowId)!;
    expect(high.leads).toBeGreaterThanOrEqual(MIN_LEADS_FOR_RANK);
    expect(low.leads).toBeLessThan(MIN_LEADS_FOR_RANK);
    expect(low.contractValueCents).toBeGreaterThan(high.contractValueCents); // low-volume rep has MORE revenue...
    expect(low.insufficientVolume).toBe(true);
    expect(low.rank).toBeNull(); // ...but is still never ranked
    expect(high.insufficientVolume).toBe(false);
    expect(high.rank).toBe(1); // the only eligible rep -> rank 1

    mark(11, `low-volume guard: repLow (${low.leads} leads, ${low.contractValueCents}¢) is unranked despite out-earning repHigh (${high.leads} leads, ${high.contractValueCents}¢, rank 1)`);
  });

  it("§8.12 multi-location: company total === sum of per-location rows; drill-down filters to one location's own numbers", async () => {
    const locA = randomUUID();
    const locB = randomUUID();
    const [dL0, dL1] = weekDates(WEEK_LOC);

    await seedEvent("lead.created", { leadId: randomUUID(), customerId: randomUUID(), source: "web", locationId: locA }, denverTime(dL0!, 3600), "loc-a-lead-1");
    await seedEvent("lead.created", { leadId: randomUUID(), customerId: randomUUID(), source: "web", locationId: locA }, denverTime(dL0!, 3700), "loc-a-lead-2");
    await seedEvent("lead.created", { leadId: randomUUID(), customerId: randomUUID(), source: "canvass", locationId: locA }, denverTime(dL0!, 3800), "loc-a-lead-3");
    await seedEvent("contract.signed", { jobId: randomUUID(), contractValueCents: 200_000, locationId: locA }, denverTime(dL0!, 4000), "loc-a-contract");

    await seedEvent("lead.created", { leadId: randomUUID(), customerId: randomUUID(), source: "web", locationId: locB }, denverTime(dL0!, 5000), "loc-b-lead-1");
    await seedEvent("lead.created", { leadId: randomUUID(), customerId: randomUUID(), source: "canvass", locationId: locB }, denverTime(dL0!, 5100), "loc-b-lead-2");
    await seedEvent("contract.signed", { jobId: randomUUID(), contractValueCents: 150_000, locationId: locB }, denverTime(dL0!, 5200), "loc-b-contract");

    // No locationId at all -> the unattributed bucket, never dropped.
    await seedEvent("lead.created", { leadId: randomUUID(), customerId: randomUUID(), source: "referral" }, denverTime(dL1!, 1000), "loc-none-lead-1");

    await rebuildDay(tenantId, dL0!);
    await rebuildDay(tenantId, dL1!);

    const byLocation = await getDailyByLocationRange(tenantId, dL0!, dL1!);
    const folded = foldLocationWeek(byLocation);
    const total = sumLocationWeeks(folded);

    const locARow = folded.find((r) => r.locationId === locA)!;
    const locBRow = folded.find((r) => r.locationId === locB)!;
    const unattributed = folded.find((r) => r.locationId === null)!;
    // Drill-down: each location's own row carries ONLY its own numbers.
    expect(locARow.leads).toBe(3);
    expect(locARow.contracts).toBe(1);
    expect(locARow.contractValueCents).toBe(200_000);
    expect(locBRow.leads).toBe(2);
    expect(locBRow.contracts).toBe(1);
    expect(locBRow.contractValueCents).toBe(150_000);
    expect(unattributed.leads).toBe(1);

    // Independent cross-check: projectDay (location-blind) over the same 2
    // days must equal the empire view's company total.
    let independentLeads = 0, independentContracts = 0, independentContractValue = 0;
    for (const d of [dL0!, dL1!]) {
      const events = await loadEventsForDay(tenantId, d);
      const day = projectDay(events, d);
      independentLeads += day.topLine.leadsTotal;
      independentContracts += day.topLine.contractsSigned;
      independentContractValue += day.topLine.contractValueCents;
    }
    expect(total.leads).toBe(independentLeads);
    expect(total.contracts).toBe(independentContracts);
    expect(total.contractValueCents).toBe(independentContractValue);
    // The literal §8.12 phrasing: company total === sum of the per-location rows.
    expect(total.leads).toBe(folded.reduce((s, r) => s + r.leads, 0));
    expect(total.contractValueCents).toBe(folded.reduce((s, r) => s + r.contractValueCents, 0));

    mark(12, `multi-location: company total (${total.leads} leads / ${total.contractValueCents}¢) === sum of locA+locB+unattributed, cross-checked against projectDay`);
  });

  it("renders the EOS scorecard + rep/source dashboards, and prints the §8 pass/fail summary", async () => {
    const rows = await weeklyRowsFor(WEEK_FOLD);
    const rank = (t: boolean | null) => (t === false ? 0 : t === null ? 1 : 2);
    const sorted = [...rows].sort((a, b) => rank(a.onTrack) - rank(b.onTrack));

    const fmt = (v: unknown) => {
      const mv = v as { status: string; value?: number; reason?: string };
      return mv.status === "ok" ? String(mv.value) : `pending (${mv.reason})`;
    };

    console.log(`\n=== EOS Weekly Scorecard — week of ${WEEK_FOLD} (rendered, off-track first) ===`);
    console.table(sorted.map((r) => ({
      metric: r.metricKey,
      value: fmt(r.value),
      onTrack: r.onTrack === null ? "—" : r.onTrack ? "on-track" : "OFF-TRACK",
      goalPlaceholder: (r.goal as { isPlaceholder?: boolean } | null)?.isPlaceholder ?? true,
    })));

    const days = weekDates(WEEK_FOLD);
    const byRep = await getDailyByRepRange(tenantId, days[0]!, days[6]!);
    const rankedReps = rankReps(foldRepWeek(byRep));
    console.log("\n=== Rep dashboard (rendered) ===");
    console.table(rankedReps.map((r) => ({
      rep: r.repId === null ? "Unassigned" : r.repId === repHighId ? "Rep High" : r.repId === repLowId ? "Rep Low" : r.repId,
      leads: r.leads, contracts: r.contracts, contractValueCents: r.contractValueCents,
      rank: r.rank ?? "—", insufficientVolume: r.insufficientVolume,
    })));

    const bySource = await getDailyBySourceRange(tenantId, days[0]!, days[6]!);
    const foldedSources = foldSourceWeek(bySource);
    console.log("\n=== Source dashboard (rendered) ===");
    console.table(foldedSources.map((r) => ({
      source: r.source, leads: r.leads, apptsSet: r.apptsSet, contracts: r.contracts,
      contractValueCents: r.contractValueCents, cost: r.costCents === null ? "no cost data" : r.costCents,
    })));

    console.log("\n=== Day 4 §8 acceptance — pass/fail summary ===");
    console.table(
      [...results].sort((a, b) => a.n - b.n).map((r) => ({ check: `§8.${r.n}`, title: r.title, result: "PASS" })),
    );
    console.log(`\n${results.length}/12 §8 checks PASS\n`);

    expect(results.length).toBe(12);
    expect(new Set(results.map((r) => r.n)).size).toBe(12);
  });
});
