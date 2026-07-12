import { describe, it, expect } from "vitest";
import { adminDb, estimate, auditLog, eq, and } from "../src/index.js";
import { makeTenant, makeLeadWithCustomer } from "./helpers.js";
import { logBallparkQuote, loadBallparkPairs } from "../src/lifecycle/ballpark.js";

describe("logBallparkQuote + loadBallparkPairs", () => {
  it("logs a quote to audit_log and pairs it with the lead's accepted estimate", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithCustomer(tenantId);
    await adminDb.insert(estimate).values({ tenantId, leadId, status: "accepted", total: 750000 });

    await logBallparkQuote(tenantId, {
      leadId,
      lowCents: 600000,
      highCents: 900000,
      confidence: "high",
      basis: "measured roof",
      inputs: { squares: 25 },
    });

    const rows = await adminDb.select().from(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, "ballpark.quoted")));
    expect(rows.length).toBe(1);
    expect(rows[0]!.entityId).toBe(leadId);

    const pairs = await loadBallparkPairs(tenantId);
    expect(pairs).toContainEqual({ lowCents: 600000, highCents: 900000, estimateCents: 750000 });
  });

  it("does not pair a quote whose lead has no accepted estimate", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithCustomer(tenantId);
    await adminDb.insert(estimate).values({ tenantId, leadId, status: "draft", total: 700000 });
    await logBallparkQuote(tenantId, { leadId, lowCents: 600000, highCents: 900000, confidence: "high", basis: "measured roof", inputs: {} });
    expect(await loadBallparkPairs(tenantId)).toHaveLength(0);
  });
});
