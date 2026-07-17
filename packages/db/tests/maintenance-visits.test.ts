import { describe, expect, it } from "vitest";
import { and, eq, gt } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { appointment, communication } from "../src/schema/comms";
import { inspection } from "../src/schema/inspection";
import { customer } from "../src/schema/crm";
import { membership } from "../src/schema/membership";
import { makeTenant, makeLeadWithProperty } from "./helpers";
import { getVisitReport, runMaintenanceVisitSweep, sendDueVisitReports } from "../src/lifecycle/maintenance-visits";

const NOW = new Date("2026-07-15T12:00:00-07:00");
const D = 86_400_000;

async function seedMember(tenantId: string, over?: { startedDaysAgo?: number; lat?: number; lng?: number }) {
  const { customerId, propertyId } = await makeLeadWithProperty(tenantId);
  if (over?.lat != null) {
    const { property } = await import("../src/schema/crm");
    await adminDb.update(property).set({ lat: over.lat, lng: over.lng ?? null }).where(eq(property.id, propertyId));
  }
  await adminDb.insert(membership).values({
    tenantId, customerId, status: "active", annualPriceCents: 34_800,
    startedAt: new Date(NOW.getTime() - (over?.startedDaysAgo ?? 360) * D),
  });
  return { customerId, propertyId };
}

describe("runMaintenanceVisitSweep — every active member visited within 12mo (#307)", () => {
  it("a due member gets an inspection appointment; a recently-visited member does not", async () => {
    const { tenantId } = await makeTenant();
    const due = await seedMember(tenantId, { startedDaysAgo: 360 });
    const fresh = await seedMember(tenantId, { startedDaysAgo: 360 });
    await adminDb.insert(inspection).values({
      tenantId, propertyId: fresh.propertyId, kind: "maintenance_annual", status: "published",
      completedAt: new Date(NOW.getTime() - 90 * D),
    });

    const r = await runMaintenanceVisitSweep(tenantId, NOW);
    expect(r.scheduled).toBe(1);

    const appts = await adminDb.select().from(appointment)
      .where(and(eq(appointment.tenantId, tenantId), eq(appointment.type, "inspection")));
    expect(appts).toHaveLength(1);
    expect(appts[0]!.customerId).toBe(due.customerId);
    expect(appts[0]!.startsAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("a member not yet due (started 3mo ago) is left alone", async () => {
    const { tenantId } = await makeTenant();
    await seedMember(tenantId, { startedDaysAgo: 90 });
    const r = await runMaintenanceVisitSweep(tenantId, NOW);
    expect(r.scheduled).toBe(0);
  });

  it("idempotent: a member with a visit already on the calendar is not double-booked", async () => {
    const { tenantId } = await makeTenant();
    await seedMember(tenantId, { startedDaysAgo: 360 });
    await runMaintenanceVisitSweep(tenantId, NOW);
    const r2 = await runMaintenanceVisitSweep(tenantId, NOW);
    expect(r2.scheduled).toBe(0);
    const appts = await adminDb.select().from(appointment).where(eq(appointment.tenantId, tenantId));
    expect(appts).toHaveLength(1);
  });

  it("neighbors batch onto the same day (#307 route batching)", async () => {
    const { tenantId } = await makeTenant();
    // Two west-cluster members and one far east; visitsPerDay=2 via config default 6 — force chunking with 8 members? Simpler: 3 members, visitsPerDay 2.
    const { tenant: tenantTbl } = await import("../src/schema/tenancy");
    await adminDb.update(tenantTbl).set({ settings: { maintenance: { visitsPerDay: 2 } } }).where(eq(tenantTbl.id, tenantId));
    await seedMember(tenantId, { startedDaysAgo: 360, lat: 33.45, lng: -112.07 });
    await seedMember(tenantId, { startedDaysAgo: 360, lat: 33.46, lng: -112.08 });
    await seedMember(tenantId, { startedDaysAgo: 360, lat: 33.42, lng: -111.05 });

    const r = await runMaintenanceVisitSweep(tenantId, NOW);
    expect(r.scheduled).toBe(3);
    const appts = await adminDb.select().from(appointment).where(eq(appointment.tenantId, tenantId));
    const days = new Set(appts.map((a) => a.startsAt.toISOString().slice(0, 10)));
    expect(days.size).toBe(2); // two neighbors share a day; the far one rides day 2
  });
});

describe("sendDueVisitReports — every visit produces a report < 48h (#308)", () => {
  it("a completed maintenance visit gets a tokenized report link texted to a reachable member", async () => {
    const { tenantId } = await makeTenant();
    const { customerId, propertyId } = await seedMember(tenantId);
    await adminDb.update(customer).set({ phone: "+15551119999" }).where(eq(customer.id, customerId));
    const [insp] = await adminDb.insert(inspection).values({
      tenantId, propertyId, kind: "maintenance_annual", status: "published",
      completedAt: new Date(NOW.getTime() - 6 * 3_600_000),
    }).returning();

    const r = await sendDueVisitReports(tenantId, NOW);
    expect(r.sent).toBe(1);

    const [after] = await adminDb.select().from(inspection).where(eq(inspection.id, insp!.id));
    expect(after!.reportToken).toBeTruthy();
    expect(after!.reportSentAt).not.toBeNull();
    const comms = await adminDb.select().from(communication).where(eq(communication.tenantId, tenantId));
    expect(comms.some((c) => c.body?.includes(after!.reportToken!))).toBe(true);
  });

  it("an unreachable member still gets the report minted and marked — the invariant never hangs on a phone number", async () => {
    const { tenantId } = await makeTenant();
    const { propertyId } = await seedMember(tenantId); // no phone
    await adminDb.insert(inspection).values({
      tenantId, propertyId, kind: "maintenance_annual", status: "published", completedAt: NOW,
    });

    const r = await sendDueVisitReports(tenantId, NOW);
    expect(r.sent).toBe(1);
    const [insp] = await adminDb.select().from(inspection).where(eq(inspection.tenantId, tenantId));
    expect(insp!.reportToken).toBeTruthy();
    expect(insp!.reportSentAt).not.toBeNull();
  });

  it("idempotent: an already-sent report is not re-sent", async () => {
    const { tenantId } = await makeTenant();
    const { propertyId } = await seedMember(tenantId);
    await adminDb.insert(inspection).values({
      tenantId, propertyId, kind: "maintenance_annual", status: "published", completedAt: NOW,
    });
    await sendDueVisitReports(tenantId, NOW);
    const r2 = await sendDueVisitReports(tenantId, NOW);
    expect(r2.sent).toBe(0);
  });
});

describe("getVisitReport — the tokenized homeowner page data", () => {
  it("resolves a valid token to score, zones, and repair quotes; junk tokens resolve to nothing", async () => {
    const { tenantId } = await makeTenant();
    const { propertyId } = await seedMember(tenantId);
    const [insp] = await adminDb.insert(inspection).values({
      tenantId, propertyId, kind: "maintenance_annual", status: "published",
      completedAt: NOW, narrative: "Roof is in solid shape overall.",
    }).returning();
    const { inspectionZone, inspectionFinding } = await import("../src/schema/inspection");
    const [zone] = await adminDb.insert(inspectionZone).values({
      tenantId, inspectionId: insp!.id, zoneKey: "valley-1", zoneLabel: "North valley", zoneKind: "valley", grade: "monitor",
    }).returning();
    await adminDb.insert(inspectionFinding).values({
      tenantId, inspectionZoneId: zone!.id, whatItIs: "Sealant wear at valley lap",
      disposition: "repair_quoted", repairEstimateCents: 22_500,
    });
    await sendDueVisitReports(tenantId, NOW);
    const [withToken] = await adminDb.select().from(inspection).where(eq(inspection.id, insp!.id));

    const report = await getVisitReport(withToken!.reportToken!);
    expect(report).not.toBeNull();
    expect(report!.score.label).toBe("watch");
    expect(report!.zones[0]).toMatchObject({ zoneLabel: "North valley", grade: "monitor" });
    expect(report!.repairQuotes[0]).toMatchObject({ repairEstimateCents: 22_500 });

    expect(await getVisitReport("nope")).toBeNull();
    expect(await getVisitReport("f".repeat(32))).toBeNull();
  });
});
