/**
 * D4-2 schema round-trip + RLS isolation for the 5 Day-4 scorecard sibling
 * tables (daily_metrics_by_rep/source/location, weekly_scorecard,
 * scorecard_goal). Mirrors contact-suppression.test.ts's tenant seed/teardown
 * and the RLS-isolation shape: insert under tenant A via withTenant, confirm
 * a same-tenant select sees it and a different tenant's select does not.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { emptyMetrics } from "@savvy/command-center";
import { adminDb, tenant, withTenant } from "../index";
import {
  dailyMetricsByRep,
  dailyMetricsBySource,
  dailyMetricsByLocation,
  weeklyScorecard,
  scorecardGoal,
} from "./scorecard";

let tenantAId: string;
let tenantBId: string;

beforeAll(async () => {
  tenantAId = randomUUID();
  tenantBId = randomUUID();
  await adminDb.insert(tenant).values([
    { id: tenantAId, name: "Scorecard-Test-A", publicKey: `sc-a-${tenantAId.slice(0, 8)}` },
    { id: tenantBId, name: "Scorecard-Test-B", publicKey: `sc-b-${tenantBId.slice(0, 8)}` },
  ]);
});

afterAll(async () => {
  for (const t of [dailyMetricsByRep, dailyMetricsBySource, dailyMetricsByLocation, weeklyScorecard, scorecardGoal]) {
    await adminDb.delete(t).where(eq(t.tenantId, tenantAId));
    await adminDb.delete(t).where(eq(t.tenantId, tenantBId));
  }
  await adminDb.delete(tenant).where(eq(tenant.id, tenantAId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantBId));
});

describe("daily_metrics_by_rep", () => {
  it("round-trips under withTenant and is isolated from other tenants (RLS)", async () => {
    const repId = randomUUID();
    await withTenant(tenantAId, async (tx) => {
      await tx.insert(dailyMetricsByRep).values({
        tenantId: tenantAId,
        businessDate: "2026-07-20",
        locationId: null,
        repId,
        leads: 5,
        firstTouches: 4,
        medianSpeedSeconds: 120,
        apptsSet: 3,
        noShows: 1,
        contracts: 2,
        contractValueCents: 1_500_000,
        estimatesApproved: 2,
        avgMarginPct: 32.5,
      });
    });

    const ownRows = await withTenant(tenantAId, (tx) =>
      tx.select().from(dailyMetricsByRep).where(eq(dailyMetricsByRep.repId, repId))
    );
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0]).toMatchObject({ tenantId: tenantAId, leads: 5, contractValueCents: 1_500_000 });

    const otherTenantRows = await withTenant(tenantBId, (tx) =>
      tx.select().from(dailyMetricsByRep).where(eq(dailyMetricsByRep.repId, repId))
    );
    expect(otherTenantRows).toHaveLength(0);
  });
});

describe("daily_metrics_by_source", () => {
  it("round-trips under withTenant and is isolated from other tenants (RLS)", async () => {
    const source = `web-${randomUUID().slice(0, 8)}`;
    await withTenant(tenantAId, async (tx) => {
      await tx.insert(dailyMetricsBySource).values({
        tenantId: tenantAId,
        businessDate: "2026-07-20",
        locationId: null,
        source,
        leads: 10,
        apptsSet: 6,
        contracts: 3,
        contractValueCents: 2_000_000,
        costCents: 50_000,
      });
    });

    const ownRows = await withTenant(tenantAId, (tx) =>
      tx.select().from(dailyMetricsBySource).where(eq(dailyMetricsBySource.source, source))
    );
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0]).toMatchObject({ tenantId: tenantAId, leads: 10 });

    const otherTenantRows = await withTenant(tenantBId, (tx) =>
      tx.select().from(dailyMetricsBySource).where(eq(dailyMetricsBySource.source, source))
    );
    expect(otherTenantRows).toHaveLength(0);
  });
});

describe("daily_metrics_by_location", () => {
  it("round-trips under withTenant and is isolated from other tenants (RLS)", async () => {
    const locationId = randomUUID();
    const metrics = emptyMetrics("2026-07-20");
    metrics.topLine.leadsTotal = 7;
    await withTenant(tenantAId, async (tx) => {
      await tx.insert(dailyMetricsByLocation).values({
        tenantId: tenantAId,
        businessDate: "2026-07-20",
        locationId,
        metrics,
      });
    });

    const ownRows = await withTenant(tenantAId, (tx) =>
      tx.select().from(dailyMetricsByLocation).where(eq(dailyMetricsByLocation.locationId, locationId))
    );
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0]?.metrics.topLine.leadsTotal).toBe(7);

    const otherTenantRows = await withTenant(tenantBId, (tx) =>
      tx.select().from(dailyMetricsByLocation).where(eq(dailyMetricsByLocation.locationId, locationId))
    );
    expect(otherTenantRows).toHaveLength(0);
  });
});

describe("weekly_scorecard", () => {
  it("round-trips under withTenant and is isolated from other tenants (RLS)", async () => {
    const metricKey = `leads.new.${randomUUID().slice(0, 8)}`;
    const priorWeeks: (number | null)[] = [null, ...Array(11).fill(10), 42];
    await withTenant(tenantAId, async (tx) => {
      await tx.insert(weeklyScorecard).values({
        tenantId: tenantAId,
        weekStart: "2026-07-20",
        locationId: null,
        metricKey,
        value: 42,
        goal: 40,
        onTrack: true,
        priorWeeks,
      });
    });

    const ownRows = await withTenant(tenantAId, (tx) =>
      tx.select().from(weeklyScorecard).where(eq(weeklyScorecard.metricKey, metricKey))
    );
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0]).toMatchObject({ tenantId: tenantAId, value: 42, goal: 40, onTrack: true });
    expect(ownRows[0]?.priorWeeks).toHaveLength(13);

    const otherTenantRows = await withTenant(tenantBId, (tx) =>
      tx.select().from(weeklyScorecard).where(eq(weeklyScorecard.metricKey, metricKey))
    );
    expect(otherTenantRows).toHaveLength(0);
  });
});

describe("scorecard_goal", () => {
  it("round-trips under withTenant and is isolated from other tenants (RLS)", async () => {
    const metricKey = `contracts.count.${randomUUID().slice(0, 8)}`;
    await withTenant(tenantAId, async (tx) => {
      await tx.insert(scorecardGoal).values({
        tenantId: tenantAId,
        locationId: null,
        metricKey,
        target: 25,
        direction: "gte",
        isPlaceholder: true,
      });
    });

    const ownRows = await withTenant(tenantAId, (tx) =>
      tx.select().from(scorecardGoal).where(eq(scorecardGoal.metricKey, metricKey))
    );
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0]).toMatchObject({ tenantId: tenantAId, target: 25, direction: "gte", isPlaceholder: true });

    const otherTenantRows = await withTenant(tenantBId, (tx) =>
      tx.select().from(scorecardGoal).where(eq(scorecardGoal.metricKey, metricKey))
    );
    expect(otherTenantRows).toHaveLength(0);
  });
});
