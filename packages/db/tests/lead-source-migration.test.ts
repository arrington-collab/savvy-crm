import { describe, it, expect } from "vitest";
import { adminDb, lead, referralPayment, eq, sql } from "../src/index.js";
import { makeTenant, makeLeadWithProperty, makeJobWithProperty } from "./helpers.js";
import { LEAD_SOURCE_VALUES } from "@savvy/core";

describe("Slice 3 schema + legacy mapping", () => {
  it("round-trips source + source_detail", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);
    await adminDb.update(lead).set({ source: "referral", sourceDetail: { referrer_name: "Sue" } }).where(eq(lead.id, leadId));
    const [l] = await adminDb.select().from(lead).where(eq(lead.id, leadId));
    expect(l!.source).toBe("referral");
    expect((l!.sourceDetail as { referrer_name: string }).referrer_name).toBe("Sue");
  });

  it("leaves zero lead.source values outside the enum after migration", async () => {
    const rows = await adminDb.execute<{ n: number }>(
      sql`select count(*)::int as n from lead where source is not null and source <> all(${sql.raw(`array[${LEAD_SOURCE_VALUES.map((v) => `'${v}'`).join(",")}]`)})`,
    );
    expect(rows.rows[0]!.n).toBe(0);
  });

  it("referral_payment enforces one row per (tenant, job)", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);
    const { jobId } = await makeJobWithProperty(tenantId);
    await adminDb.insert(referralPayment).values({ tenantId, jobId, leadId, payeeName: "Sue", amountCents: 10000, status: "approved" });
    await adminDb.insert(referralPayment).values({ tenantId, jobId, leadId, payeeName: "Sue", amountCents: 10000, status: "approved" }).onConflictDoNothing();
    const all = await adminDb.select().from(referralPayment).where(eq(referralPayment.jobId, jobId));
    expect(all).toHaveLength(1);
  });
});
