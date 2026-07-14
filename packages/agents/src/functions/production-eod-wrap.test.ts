import { describe, it, expect, vi } from "vitest";
import { adminDb, tenant, customer, property, job, productionUpdate, eq, submitCrewEodReport } from "@savvy/db";
import { sendEodWrap } from "./production-eod-wrap.js";

async function seedReportedDay() {
  const [t] = await adminDb.insert(tenant).values({
    name: "EODWrap", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
    settings: { homeowner: { quietHours: { startHour: 0, endHour: 0 } } } as never,
  }).returning();
  const tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Wendy Wrap", phone: "+16025551100" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "6 Wrap Way" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  const { dayKey } = await submitCrewEodReport({
    tenantId, jobId: j!.id, whatGotDone: "Dry-in finished, install 40%", tomorrowPlan: "Ridge caps and cleanup",
  });
  return { tenantId, jobId: j!.id, dayKey };
}

function fakeDeps(draft = "Crew's done for today — dry-in finished and install is well underway. Tomorrow: ridge caps and cleanup.") {
  const sent: { to: string; body: string }[] = [];
  return {
    sent,
    ai: { complete: vi.fn(async () => ({ text: draft, model: "fake" })) },
    getTenantSms: (async () => ({
      sender: { sendSms: async (m: { to: string; body: string }) => { sent.push(m); return { providerId: "fake" }; } },
      from: "+15555550000",
    })) as never,
  };
}

describe("sendEodWrap", () => {
  it("sends the wrap from the crew's report and logs it once per job-day", async () => {
    const { tenantId, jobId, dayKey } = await seedReportedDay();
    const deps = fakeDeps();

    const res = await sendEodWrap({ tenantId, jobId, dayKey }, deps as never);
    expect(res).toEqual({ sent: true });
    expect(deps.sent[0]!.body).toContain("ridge caps");
    expect(deps.sent[0]!.body).toMatch(/\/b\//);

    const replay = await sendEodWrap({ tenantId, jobId, dayKey }, deps as never);
    expect(replay).toMatchObject({ sent: false, suppressed: "already_wrapped" });
    const rows = await adminDb.select().from(productionUpdate).where(eq(productionUpdate.jobId, jobId));
    expect(rows).toHaveLength(1);
  });

  it("no report for the day ⇒ nothing sends and nothing logs (the exception is slice 3's)", async () => {
    const { tenantId, jobId } = await seedReportedDay();
    const deps = fakeDeps();
    const res = await sendEodWrap({ tenantId, jobId, dayKey: "1999-01-01" }, deps as never);
    expect(res).toMatchObject({ sent: false, suppressed: "no_report" });
    expect(deps.sent).toHaveLength(0);
  });
});
