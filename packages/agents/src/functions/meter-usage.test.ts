/**
 * Tests for priorMonthKey helper + live-DB assertion that recordUsageSnapshot
 * writes a snapshot for a seeded tenant with revenueBand:"starter".
 *
 * Run with:
 *   DATABASE_URL=... DATABASE_ADMIN_URL=... pnpm test meter-usage
 */
import { describe, it, expect } from "vitest";
import { adminDb, tenant, recordUsageSnapshot, withTenant, usageSnapshot, eq } from "@savvy/db";

import { priorMonthKey } from "./meter-usage";

// ---------------------------------------------------------------------------
// Unit tests — priorMonthKey
// ---------------------------------------------------------------------------
describe("priorMonthKey", () => {
  it("returns the prior month key for a mid-year date (July -> June)", () => {
    expect(priorMonthKey(new Date("2026-07-10T12:00:00Z"))).toBe("2026-06");
  });

  it("wraps correctly from January -> prior-year December", () => {
    expect(priorMonthKey(new Date("2026-01-01T06:00:00Z"))).toBe("2025-12");
  });

  it("pads single-digit months", () => {
    expect(priorMonthKey(new Date("2026-03-15T00:00:00Z"))).toBe("2026-02");
  });
});

// ---------------------------------------------------------------------------
// Live-DB test — recordUsageSnapshot writes a snapshot for a starter tenant
// ---------------------------------------------------------------------------
describe("meterUsageMonthly (live DB via recordUsageSnapshot)", () => {
  it("writes a usage_snapshot row for a seeded tenant with revenueBand:starter", async () => {
    // Seed a tenant with the starter band
    const [t] = await adminDb
      .insert(tenant)
      .values({ name: "MeterTest", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`, revenueBand: "starter" })
      .returning();
    const tenantId = t!.id;

    // Call the function the cron invokes per-tenant
    const periodKey = "2026-06";
    const snap = await recordUsageSnapshot(tenantId, periodKey);

    // Assertions
    expect(snap.tenantId).toBe(tenantId);
    expect(snap.periodKey).toBe(periodKey);
    expect(snap.bandKey).toBe("starter");
    expect(snap.basePriceCents).toBe(49900); // starter base price

    // Confirm it's actually in the DB via tenant-scoped query
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(usageSnapshot).where(eq(usageSnapshot.periodKey, periodKey)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bandKey).toBe("starter");
  });
});
