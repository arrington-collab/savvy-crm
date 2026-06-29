import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { getHomeownerStatus, listStageEventsToNotify, markStageEventNotified } from "../src/lifecycle/homeowner.js";
import { jobStageEvent, appointment } from "../src/schema/index.js";
import { adminDb } from "../src/admin-client.js";
import { eq } from "drizzle-orm";
import { makeTenant, makeJobWithProperty } from "./helpers.js";

async function seed(): Promise<{ tenantId: string; jobId: string; customerId: string }> {
  const { tenantId } = await makeTenant();
  const { jobId, customerId } = await makeJobWithProperty(tenantId);
  return { tenantId, jobId, customerId };
}

describe("getHomeownerStatus", () => {
  it("returns job journey + next appointment", async () => {
    const { tenantId, jobId } = await seed();
    const future = new Date(Date.now() + 3 * 86_400_000);
    await adminDb.insert(jobStageEvent).values({ tenantId, jobId, toStage: "approved", enteredAt: new Date() });
    await adminDb.insert(appointment).values({ tenantId, jobId, type: "crew", status: "scheduled", startsAt: future, endsAt: new Date(future.getTime() + 3_600_000) });
    const s = await getHomeownerStatus(tenantId, jobId);
    expect(s).not.toBeNull();
    expect(s!.events.some((e) => e.toStage === "approved")).toBe(true);
    expect(s!.nextAppointment?.type).toBe("crew");
    expect(s!.companyName.length).toBeGreaterThan(0);
  });
});

describe("listStageEventsToNotify + markStageEventNotified", () => {
  it("returns recent un-notified events for the given stages, then dedupes after marking", async () => {
    const { tenantId, jobId } = await seed();
    const [ev] = await adminDb.insert(jobStageEvent).values({ tenantId, jobId, toStage: "production", enteredAt: new Date() }).returning();
    // an OLD event must be excluded by the recency window
    await adminDb.insert(jobStageEvent).values({ tenantId, jobId, toStage: "production", enteredAt: new Date(Date.now() - 5 * 86_400_000) });
    const now = new Date();
    let rows = await listStageEventsToNotify(tenantId, { stages: ["production"], sinceMs: 2 * 3_600_000, now });
    expect(rows.map((r) => r.eventId)).toContain(ev!.id);
    expect(rows.length).toBe(1); // old one excluded
    await markStageEventNotified(tenantId, ev!.id);
    rows = await listStageEventsToNotify(tenantId, { stages: ["production"], sinceMs: 2 * 3_600_000, now });
    expect(rows.find((r) => r.eventId === ev!.id)).toBeUndefined();
    const [after] = await withTenant(tenantId, (tx) => tx.select({ n: jobStageEvent.homeownerNotifiedAt }).from(jobStageEvent).where(eq(jobStageEvent.id, ev!.id)));
    expect(after!.n).not.toBeNull();
  });
});
