import { describe, it, expect } from "vitest";
import { adminDb } from "../src/admin-client.js";
import { withTenant } from "../src/tenant.js";
import { lead } from "../src/schema/crm.js";
import { job } from "../src/schema/jobs.js";
import { invoice } from "../src/schema/finance.js";
import { eq } from "drizzle-orm";
import { makeTenant, makeLeadWithProperty, makeJobWithProperty } from "./helpers.js";
import { leadSourceSummary, referredRevenueByPerson } from "../src/index.js";

describe("lead source analytics", () => {
  it("leadSourceSummary counts leads by source", async () => {
    const { tenantId } = await makeTenant();

    const { leadId: lead1 } = await makeLeadWithProperty(tenantId);
    await adminDb.update(lead).set({ source: "web" }).where(eq(lead.id, lead1));
    const { leadId: lead2 } = await makeLeadWithProperty(tenantId);
    await adminDb.update(lead).set({ source: "web" }).where(eq(lead.id, lead2));

    const rows = await leadSourceSummary(tenantId);
    expect(rows.find((r) => r.source === "web")?.leadCount).toBeGreaterThanOrEqual(2);
  });

  it("referredRevenueByPerson groups by referrer name", async () => {
    const { tenantId } = await makeTenant();

    // Referral lead with sourceDetail.referrer_name = "Sue"
    const { leadId } = await makeLeadWithProperty(tenantId);
    await adminDb
      .update(lead)
      .set({ source: "referral", sourceDetail: { referrer_name: "Sue" } })
      .where(eq(lead.id, leadId));

    // Job tied to that lead, with a paid invoice of $500
    const { jobId, customerId, propertyId } = await makeJobWithProperty(tenantId);
    await adminDb.update(job).set({ leadId }).where(eq(job.id, jobId));
    void customerId;
    void propertyId;

    await withTenant(tenantId, (tx) =>
      tx.insert(invoice).values({
        tenantId,
        jobId,
        amountDue: 50_000,
        amountPaid: 50_000,
        status: "paid",
      }),
    );

    const rows = await referredRevenueByPerson(tenantId);
    expect(rows.some((r) => r.name === "Sue")).toBe(true);
    const sueRow = rows.find((r) => r.name === "Sue");
    expect(sueRow?.source).toBe("referral");
    expect(sueRow?.jobCount).toBeGreaterThanOrEqual(1);
    expect(sueRow?.revenueCents).toBeGreaterThanOrEqual(50_000);
  });
});
