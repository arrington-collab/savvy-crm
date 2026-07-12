import { describe, it, expect } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { lead } from "../src/schema/crm";
import { dripEnrollment } from "../src/schema/comms";
import { provisionDemoTenant } from "../src/lifecycle/demo-seed/config";
import { seedDemoLeads } from "../src/lifecycle/demo-seed/leads";

describe("seedDemoLeads", () => {
  it("creates one lead in each of new/contacted/qualified/booked/lost", async () => {
    const { tenantId } = await provisionDemoTenant();
    const ids = await seedDemoLeads(tenantId);
    const rows = await adminDb.select().from(lead).where(eq(lead.tenantId, tenantId));
    const byStatus = new Map(rows.map((r) => [r.id, r.status]));
    expect(byStatus.get(ids.new)).toBe("new");
    expect(byStatus.get(ids.contacted)).toBe("contacted");
    expect(byStatus.get(ids.qualified)).toBe("qualified");
    expect(byStatus.get(ids.booked)).toBe("booked");
    expect(byStatus.get(ids.lost)).toBe("lost");
  });

  it("has a real score on the qualified lead", async () => {
    const { tenantId } = await provisionDemoTenant();
    const ids = await seedDemoLeads(tenantId);
    const [row] = await adminDb.select().from(lead).where(eq(lead.id, ids.qualified));
    expect(row!.score).toBeGreaterThan(0);
  });

  it("has an active drip enrollment for the contacted lead", async () => {
    const { tenantId } = await provisionDemoTenant();
    const ids = await seedDemoLeads(tenantId);
    const rows = await adminDb
      .select()
      .from(dripEnrollment)
      .where(and(eq(dripEnrollment.tenantId, tenantId), eq(dripEnrollment.leadId, ids.contacted)));
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("active");
  });

  it("is idempotent: seeding twice yields the same 5 lead ids and no duplicate rows", async () => {
    const { tenantId } = await provisionDemoTenant();
    const first = await seedDemoLeads(tenantId);
    const second = await seedDemoLeads(tenantId);
    expect(second).toEqual(first);

    // The demo tenant is a shared singleton across suites/worktrees (upserted by a fixed
    // clerkOrgId), so it may carry leads seeded by other tasks — assert only that THESE 5
    // ids are distinct and that the second run didn't create a 6th row for any of them.
    const idList = Object.values(first);
    expect(new Set(idList).size).toBe(5);
    const rows = await adminDb.select({ id: lead.id }).from(lead).where(inArray(lead.id, idList));
    expect(rows.length).toBe(5);
  });
});
