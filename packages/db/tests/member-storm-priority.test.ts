import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client";
import { customer } from "../src/schema/crm";
import { membership } from "../src/schema/membership";
import { stormReinspectBatch } from "../src/schema/inspection";
import { relationshipTouch } from "../src/schema/relationship";
import { makeTenant, makeLeadWithCustomer } from "./helpers";

// Phase 20 S4 (#309): members = top Strike List tier. A member whose roof is in
// a verified swath must be contacted < 24h. This invariant proves the SLA held.

const HOURS = 3_600_000;

function run(tenantId: string) {
  const ctx: EvidenceCtx = {
    tenantId, db: adminPool, params: {},
    window: { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) },
  };
  return evidenceChecks["maintenance.member_storm_priority"]!(ctx);
}

async function activeMember(tenantId: string) {
  const { customerId } = await makeLeadWithCustomer(tenantId);
  await adminDb.insert(membership).values({
    tenantId, customerId, status: "active", annualPriceCents: 34800, source: "manual", startedAt: new Date(),
  });
  return customerId;
}

/** Approved swath batch whose properties include the given customers, approved `ageHours` ago. */
async function approvedBatch(tenantId: string, customerIds: string[], ageHours: number) {
  const approvedAt = new Date(Date.now() - ageHours * HOURS);
  const [b] = await adminDb.insert(stormReinspectBatch).values({
    tenantId, signature: `sig-${crypto.randomUUID()}`, kind: "hail", eventDate: "2026-07-12",
    properties: customerIds.map((customerId) => ({ propertyId: crypto.randomUUID(), customerId, address: "1 St", baselineAt: new Date().toISOString() })),
    status: "approved", approvedAt,
  }).returning();
  return { batchId: b!.id, approvedAt };
}

async function sentStormTouch(tenantId: string, customerId: string, batchId: string, sentAt: Date) {
  await adminDb.insert(relationshipTouch).values({
    tenantId, customerId, program: "storm_check", channel: "text",
    scheduledFor: sentAt, sentAt, sourceRef: `${batchId}:${customerId}`,
  });
}

describe("evidence: maintenance.member_storm_priority (#309)", () => {
  it("flags a member left uncontacted past 24h; clears once contacted in time", async () => {
    const { tenantId } = await makeTenant();
    const memberId = await activeMember(tenantId);
    const { batchId, approvedAt } = await approvedBatch(tenantId, [memberId], 25);

    const bad = await run(tenantId);
    expect(bad.status).toBe("fail");
    expect(bad.refs.some((r) => r.type === "membership")).toBe(true);

    // Contacted 2h after approval — inside the 24h SLA.
    await sentStormTouch(tenantId, memberId, batchId, new Date(approvedAt.getTime() + 2 * HOURS));
    const good = await run(tenantId);
    expect(good.status).toBe("pass");
  });

  it("does not flag a member contacted LATE (past the 24h SLA)", async () => {
    const { tenantId } = await makeTenant();
    const memberId = await activeMember(tenantId);
    const { batchId, approvedAt } = await approvedBatch(tenantId, [memberId], 48);
    // Contacted 30h after approval — too late; still a violation.
    await sentStormTouch(tenantId, memberId, batchId, new Date(approvedAt.getTime() + 30 * HOURS));
    expect((await run(tenantId)).status).toBe("fail");
  });

  it("gives a 24h grace window: a fresh batch (< 24h old) is never flagged", async () => {
    const { tenantId } = await makeTenant();
    const memberId = await activeMember(tenantId);
    await approvedBatch(tenantId, [memberId], 3); // approved 3h ago, no touch yet
    expect((await run(tenantId)).status).toBe("pass");
  });

  it("ignores non-members in the swath and opted-out members", async () => {
    const { tenantId } = await makeTenant();

    // Non-member in an overdue swath — not the top tier, not flagged.
    const nonMember = (await makeLeadWithCustomer(tenantId)).customerId;

    // Opted-out member — can't be contacted, so not a violation.
    const optedOut = await activeMember(tenantId);
    await adminDb.update(customer).set({ smsOptOut: true }).where(eq(customer.id, optedOut));

    await approvedBatch(tenantId, [nonMember, optedOut], 25);
    expect((await run(tenantId)).status).toBe("pass");
  });
});
