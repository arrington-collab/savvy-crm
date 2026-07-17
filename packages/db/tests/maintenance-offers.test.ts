import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { job } from "../src/schema/jobs";
import { inspection } from "../src/schema/inspection";
import { estimate } from "../src/schema/finance";
import { membership } from "../src/schema/membership";
import { relationshipTouch } from "../src/schema/relationship";
import { tenant } from "../src/schema/tenancy";
import { makeTenant, makeJobWithCustomer, makeLeadWithCustomer, makeLeadWithProperty } from "./helpers";
import { runMaintenanceOfferSweep, maintenanceChurnStats } from "../src/lifecycle/maintenance-offers";

const NOW = new Date("2026-07-15T12:00:00-07:00");
const D = 86_400_000;

async function seedCompletedJob(tenantId: string, daysAgo = 60) {
  const { jobId, customerId } = await makeJobWithCustomer(tenantId);
  await adminDb.update(job).set({ stage: "complete", closedAt: new Date(NOW.getTime() - daysAgo * D) }).where(eq(job.id, jobId));
  return { jobId, customerId };
}

async function seedActiveMembership(tenantId: string, customerId: string, over?: { status?: string; startedDaysAgo?: number; canceledDaysAgo?: number; reason?: string }) {
  const [m] = await adminDb.insert(membership).values({
    tenantId, customerId, status: over?.status ?? "active", annualPriceCents: 34_800,
    startedAt: new Date(NOW.getTime() - (over?.startedDaysAgo ?? 30) * D),
    canceledAt: over?.canceledDaysAgo != null ? new Date(NOW.getTime() - over.canceledDaysAgo * D) : null,
    cancellationReason: over?.reason ?? null,
  }).returning();
  return m!.id;
}

const touches = (tenantId: string) => adminDb.select().from(relationshipTouch).where(eq(relationshipTouch.tenantId, tenantId));

describe("runMaintenanceOfferSweep — offers ride the governor rails (#306)", () => {
  it("a completed job past the offer delay gets a maintenance_offer touch; a member does not", async () => {
    const { tenantId } = await makeTenant();
    const a = await seedCompletedJob(tenantId, 60);
    const b = await seedCompletedJob(tenantId, 60);
    await seedActiveMembership(tenantId, b.customerId);

    const r = await runMaintenanceOfferSweep(tenantId, NOW);
    expect(r.offers).toBe(1);

    const t = await touches(tenantId);
    expect(t.filter((x) => x.program === "maintenance_offer" && x.customerId === a.customerId)).toHaveLength(1);
    expect(t.filter((x) => x.customerId === b.customerId)).toHaveLength(0);
  });

  it("a job completed too recently is not offered yet", async () => {
    const { tenantId } = await makeTenant();
    await seedCompletedJob(tenantId, 10); // default delay 45d

    const r = await runMaintenanceOfferSweep(tenantId, NOW);
    expect(r.offers).toBe(0);
  });

  it("inspection-no-sale: a published inspection with no accepted estimate becomes an offer", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, customerId, propertyId } = await makeLeadWithProperty(tenantId);
    await adminDb.insert(inspection).values({
      tenantId, leadId, propertyId, status: "published",
      completedAt: new Date(NOW.getTime() - 45 * D),
    });

    const r = await runMaintenanceOfferSweep(tenantId, NOW);
    expect(r.offers).toBe(1);
    const t = await touches(tenantId);
    expect(t.some((x) => x.program === "maintenance_offer" && x.customerId === customerId)).toBe(true);
  });

  it("an inspection whose lead accepted an estimate is NOT a no-sale — no offer", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await adminDb.insert(inspection).values({
      tenantId, leadId, propertyId, status: "published", completedAt: new Date(NOW.getTime() - 45 * D),
    });
    await adminDb.insert(estimate).values({ tenantId, leadId, status: "accepted", acceptedAt: NOW });

    const r = await runMaintenanceOfferSweep(tenantId, NOW);
    expect(r.offers).toBe(0);
  });

  it("renewal: an active membership inside the renewal window gets a maintenance_renewal touch", async () => {
    const { tenantId } = await makeTenant();
    const { customerId } = await makeLeadWithCustomer(tenantId);
    await seedActiveMembership(tenantId, customerId, { startedDaysAgo: 330 }); // anniversary in 35d, window 45d

    const r = await runMaintenanceOfferSweep(tenantId, NOW);
    expect(r.renewals).toBe(1);
    const t = await touches(tenantId);
    expect(t.some((x) => x.program === "maintenance_renewal" && x.customerId === customerId)).toBe(true);
  });

  it("winback: a membership canceled past the winback delay gets one winback touch — never a member with a live membership", async () => {
    const { tenantId } = await makeTenant();
    const { customerId } = await makeLeadWithCustomer(tenantId);
    await seedActiveMembership(tenantId, customerId, { status: "canceled", canceledDaysAgo: 40, reason: "financial" });

    const r = await runMaintenanceOfferSweep(tenantId, NOW);
    expect(r.winbacks).toBe(1);

    // Re-run idempotent: sourceRef dedupe means no second winback.
    const r2 = await runMaintenanceOfferSweep(tenantId, NOW);
    expect(r2.winbacks).toBe(0);
  });

  it("sweep is idempotent end-to-end — a second pass schedules nothing new", async () => {
    const { tenantId } = await makeTenant();
    await seedCompletedJob(tenantId, 60);
    await runMaintenanceOfferSweep(tenantId, NOW);
    const r2 = await runMaintenanceOfferSweep(tenantId, NOW);
    expect(r2.offers + r2.renewals + r2.winbacks).toBe(0);
    expect((await touches(tenantId)).length).toBe(1);
  });

  it("disabled config short-circuits the whole sweep", async () => {
    const { tenantId } = await makeTenant();
    await adminDb.update(tenant).set({ settings: { maintenance: { enabled: false } } }).where(eq(tenant.id, tenantId));
    await seedCompletedJob(tenantId, 60);
    const r = await runMaintenanceOfferSweep(tenantId, NOW);
    expect(r.offers).toBe(0);
  });
});

describe("maintenanceChurnStats — the churn watch digest food (#310)", () => {
  it("counts actives, monthly adds/cancels, MRR, and the top cancel reason", async () => {
    const { tenantId } = await makeTenant();
    const c1 = await makeLeadWithCustomer(tenantId);
    const c2 = await makeLeadWithCustomer(tenantId);
    const c3 = await makeLeadWithCustomer(tenantId);
    await seedActiveMembership(tenantId, c1.customerId, { startedDaysAgo: 5 });
    await seedActiveMembership(tenantId, c2.customerId, { status: "canceled", canceledDaysAgo: 3, reason: "moved" });
    await seedActiveMembership(tenantId, c3.customerId, { status: "canceled", canceledDaysAgo: 6, reason: "moved" });

    const s = await maintenanceChurnStats(tenantId, NOW);
    expect(s.activeCount).toBe(1);
    expect(s.newThisMonth30d).toBe(1);
    expect(s.canceledThisMonth30d).toBe(2);
    expect(s.topCancelReason).toBe("moved");
    expect(s.mrrCents).toBe(2900);
  });
});
