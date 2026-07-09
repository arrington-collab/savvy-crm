/**
 * Task 11: automated conversion callers (estimate-sign, canvass-contract) catch
 * ConversionBlockedError and skip gracefully instead of crashing the Inngest step
 * when a lead has an open MANUAL lead task with no resolution (Task 10's gate).
 *
 * Run with:
 *   DATABASE_URL=... DATABASE_ADMIN_URL=... pnpm test conversion-block
 */
import { afterAll, describe, expect, it } from "vitest";
import { adminDb, adminPool, tenant, customer, property, lead, estimate, document, taskRegistry, tenantTaskConfig, leadTask, eq, and, inArray } from "@savvy/db";
import { advanceJobForAcceptedEstimate } from "./estimate-sign";
import { convertCanvassContractOrSkip } from "./canvass-contract";

// Synthetic per_lead MANUAL registry task (id well above the 212 real ones) — used
// to force Task 10's conversion resolution gate to block, without depending on
// which real registry tasks happen to be manual.
const MANUAL_TASK = 9201;

async function makeTenant(name: string): Promise<string> {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name, publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` })
    .returning();
  return t!.id;
}

async function seedManualTaskRegistry(): Promise<void> {
  await adminDb
    .insert(taskRegistry)
    .values({
      id: MANUAL_TASK,
      slug: `synl.${MANUAL_TASK}`,
      name: `synl-${MANUAL_TASK}`,
      phase: 2,
      defaultOwner: "HUMAN",
      defaultMode: "manual",
      scope: "per_lead",
      appliesTo: {},
    })
    .onConflictDoNothing({ target: taskRegistry.id });
}

async function makeLeadWithOpenManualTask(tenantId: string): Promise<{ leadId: string; estimateId: string }> {
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Lead Larry", email: "larry@e2e.test" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "3 Lead Ln" }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "test", lane: "standard" }).returning();
  const [e] = await adminDb
    .insert(estimate)
    .values({ tenantId, leadId: l!.id, propertyId: p!.id, source: "roofr", status: "sent", total: 500_000 })
    .returning();
  await adminDb.insert(document).values({ tenantId, leadId: l!.id, kind: "photo", r2Key: `${tenantId}/${l!.id}/insp.jpg` });
  await adminDb.insert(leadTask).values({ tenantId, leadId: l!.id, taskId: MANUAL_TASK, status: "pending" });
  return { leadId: l!.id, estimateId: e!.id };
}

afterAll(async () => {
  await adminDb.delete(leadTask).where(eq(leadTask.taskId, MANUAL_TASK));
  await adminDb.delete(tenantTaskConfig).where(eq(tenantTaskConfig.taskId, MANUAL_TASK));
  await adminDb.delete(taskRegistry).where(eq(taskRegistry.id, MANUAL_TASK));
  await adminPool.end();
});

describe("advanceJobForAcceptedEstimate — conversion resolution gate", () => {
  it("skips conversion_blocked (does not throw) when the lead has an open manual lead task", async () => {
    await seedManualTaskRegistry();
    const tenantId = await makeTenant("conv-block-est");
    const { estimateId, leadId } = await makeLeadWithOpenManualTask(tenantId);

    const res = await advanceJobForAcceptedEstimate(tenantId, estimateId);
    expect(res).toMatchObject({ skipped: "conversion_blocked", openManualTaskIds: [MANUAL_TASK] });

    // The lead stays unconverted — no job was created, the open task remains open.
    const rows = await adminDb
      .select({ status: leadTask.status })
      .from(leadTask)
      .where(and(eq(leadTask.leadId, leadId), inArray(leadTask.taskId, [MANUAL_TASK])));
    expect(rows[0]!.status).toBe("pending");
  });
});

describe("convertCanvassContractOrSkip — conversion resolution gate", () => {
  it("skips conversion_blocked (does not throw) when the lead has an open manual lead task", async () => {
    await seedManualTaskRegistry();
    const tenantId = await makeTenant("conv-block-canvass");
    const [c] = await adminDb.insert(customer).values({ tenantId, name: "Canvass Cathy" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "5 Canvass Ct" }).returning();
    const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "door-knocking" }).returning();
    await adminDb.insert(leadTask).values({ tenantId, leadId: l!.id, taskId: MANUAL_TASK, status: "pending" });

    const res = await convertCanvassContractOrSkip({
      tenantId,
      leadId: l!.id,
      contract: {
        kind: "insurance",
        document: "Insurance Proposal Contract",
        fields: {},
        scopeItems: [],
        rep: "Marcus R.",
        signedAt: "2026-07-04T20:00:00.000Z",
        consentElectronic: true,
        integrityHash: "cd".repeat(32),
        signaturePng: "data:image/png;base64,iVBORw0KGgo=",
      },
    });
    expect(res).toMatchObject({ skipped: "conversion_blocked", openManualTaskIds: [MANUAL_TASK] });
  });
});
