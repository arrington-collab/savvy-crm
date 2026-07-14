import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import {
  customer, property, job, estimate, inspection, inspectionZone, inspectionFinding,
  repairCredit, crewCheckin, crewEodReport, productionPhase, municipalInspection,
  productionUpdate, materialOrder, relationshipTouch, relationshipEnrollment,
  moveEvent, warrantyTransfer,
} from "../src/schema/index.js";
import { makeTenant, makeUser, makeJobWithCustomer } from "./helpers.js";

// The bulk evidence pass: shipped program queries (Roof Record, Production
// Pulse, Customer for Life) re-expressed as evidenceChecks SQL invariants so
// the nightly sweep + Coverage Map can prove them. Each test seeds a violation
// (fail) and a benign/fixed shape (pass).

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const WINDOW = { start: daysAgo(7), end: new Date(Date.now() + DAY) };

const run = (checkKey: string, tenantId: string) => {
  const ctx: EvidenceCtx = { tenantId, db: adminPool, params: {}, window: WINDOW };
  const check = evidenceChecks[checkKey];
  expect(check, `check "${checkKey}" must be registered`).toBeDefined();
  return check!(ctx);
};

async function makeProperty(tenantId: string, opts: { baseline?: string | null } = {}) {
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Evidence Eve" }).returning();
  const [p] = await adminDb.insert(property).values({
    tenantId, customerId: c!.id, address: "1 Evidence Way",
    baselineInspectionId: opts.baseline ?? null, baselineAt: opts.baseline ? new Date() : null,
  }).returning();
  return { customerId: c!.id, propertyId: p!.id };
}

afterAll(async () => { await adminPool.end(); });

describe("Roof Record checks", () => {
  it("roof_record.no_unsupported_action: an ACTION zone without a photo-backed confirmed finding fails", async () => {
    const { tenantId } = await makeTenant();
    const { propertyId } = await makeProperty(tenantId);
    const [insp] = await adminDb.insert(inspection).values({ tenantId, propertyId }).returning();

    const [badZone] = await adminDb.insert(inspectionZone).values({
      tenantId, inspectionId: insp!.id, zoneKey: "north_slope", zoneLabel: "North slope", grade: "action",
    }).returning();
    expect((await run("roof_record.no_unsupported_action", tenantId)).status).toBe("fail");

    await adminDb.insert(inspectionFinding).values({
      tenantId, inspectionZoneId: badZone!.id, whatItIs: "Hail bruising",
      confirmedAt: new Date(), photoIds: ["doc-1"],
    });
    expect((await run("roof_record.no_unsupported_action", tenantId)).status).toBe("pass");
  });

  it("roof_record.baseline_coverage: a published initial Record without a property baseline fails", async () => {
    const { tenantId } = await makeTenant();
    const { propertyId } = await makeProperty(tenantId);
    const [insp] = await adminDb.insert(inspection).values({
      tenantId, propertyId, kind: "initial", status: "published",
    }).returning();
    expect((await run("roof_record.baseline_coverage", tenantId)).status).toBe("fail");

    await adminDb.update(property).set({ baselineInspectionId: insp!.id, baselineAt: new Date() })
      .where(eq(property.id, propertyId));
    expect((await run("roof_record.baseline_coverage", tenantId)).status).toBe("pass");
  });

  it("inspection.linked_reinspection: a post_storm inspection with no baseline link fails", async () => {
    const { tenantId } = await makeTenant();
    const { propertyId } = await makeProperty(tenantId);
    await adminDb.insert(inspection).values({ tenantId, propertyId, kind: "post_storm" });
    expect((await run("inspection.linked_reinspection", tenantId)).status).toBe("fail");
  });

  it("repair.credit_checkin: a credit that expired with an empty check-in log fails; a logged cadence passes", async () => {
    const { tenantId } = await makeTenant();
    const { customerId } = await makeProperty(tenantId);
    await adminDb.insert(repairCredit).values({
      tenantId, customerId, amountCents: 25000, expiresAt: daysAgo(2), status: "expired", checkinLog: [],
    });
    expect((await run("repair.credit_checkin", tenantId)).status).toBe("fail");

    const clean = await makeTenant();
    const cc = await makeProperty(clean.tenantId);
    await adminDb.insert(repairCredit).values({
      tenantId: clean.tenantId, customerId: cc.customerId, amountCents: 25000,
      expiresAt: daysAgo(2), status: "expired", checkinLog: [{ at: daysAgo(400).toISOString(), kind: "12mo", commId: null }],
    });
    expect((await run("repair.credit_checkin", clean.tenantId)).status).toBe("pass");
  });
});

describe("Production Pulse checks", () => {
  it("production.phase_evidence: a DONE phase with no evidence photos fails; evidence passes", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(tenantId);
    const [phase] = await adminDb.insert(productionPhase).values({
      tenantId, jobId, phaseKey: "tear_off", label: "Tear-off", status: "done", evidencePhotoIds: [],
    }).returning();
    expect((await run("production.phase_evidence", tenantId)).status).toBe("fail");

    await adminDb.update(productionPhase).set({ evidencePhotoIds: ["doc-1"] })
      .where(eq(productionPhase.id, phase!.id));
    expect((await run("production.phase_evidence", tenantId)).status).toBe("pass");
  });

  it("production.ho_updates: a customer-visible DONE phase with no update ledger row fails", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(tenantId);
    await adminDb.insert(productionPhase).values({
      tenantId, jobId, phaseKey: "dry_in", label: "Dry-in", status: "done",
      customerVisible: true, evidencePhotoIds: ["doc-1"],
    });
    expect((await run("production.ho_updates", tenantId)).status).toBe("fail");

    await adminDb.insert(productionUpdate).values({ tenantId, jobId, kind: "phase_complete", phaseKey: "dry_in" });
    expect((await run("production.ho_updates", tenantId)).status).toBe("pass");
  });

  it("production.delivery_notice: a due delivery missing its notices fails; both sends pass", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(tenantId);
    const [est] = await adminDb.insert(estimate).values({ tenantId }).returning();
    await adminDb.insert(materialOrder).values({
      tenantId, jobId, estimateId: est!.id, status: "delivered", neededByAt: daysAgo(1),
    });
    expect((await run("production.delivery_notice", tenantId)).status).toBe("fail");

    await adminDb.insert(productionUpdate).values([
      { tenantId, jobId, kind: "delivery_3day" },
      { tenantId, jobId, kind: "delivery_eve" },
    ]);
    expect((await run("production.delivery_notice", tenantId)).status).toBe("pass");
  });

  it("production.eod: a crew day older than the grace with no EOD report fails; a filed report passes", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(tenantId);
    const { userId } = await makeUser(tenantId);
    const checkedInAt = new Date(Date.now() - 26 * 3_600_000);
    await adminDb.insert(crewCheckin).values({ tenantId, jobId, crewUserId: userId, checkedInAt });
    expect((await run("production.eod", tenantId)).status).toBe("fail");

    await adminDb.insert(crewEodReport).values({
      tenantId, jobId, dayKey: checkedInAt.toISOString().slice(0, 10), whatGotDone: "Tear-off done",
    });
    expect((await run("production.eod", tenantId)).status).toBe("pass");
  });

  it("production.inspection_gate: a gated phase running without a passed municipal record fails", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(tenantId);
    await adminDb.insert(productionPhase).values({
      tenantId, jobId, phaseKey: "underlayment", label: "Underlayment", status: "in_progress",
      requiredInspectionKey: "sheathing", evidencePhotoIds: ["doc-1"],
    });
    expect((await run("production.inspection_gate", tenantId)).status).toBe("fail");

    await adminDb.insert(municipalInspection).values({ tenantId, jobId, inspectionKey: "sheathing", status: "passed" });
    expect((await run("production.inspection_gate", tenantId)).status).toBe("pass");
  });
});

describe("Customer for Life checks", () => {
  it("relationship.governor: a customer with more SENT touches than the rolling-year cap fails", async () => {
    const { tenantId } = await makeTenant();
    const { customerId } = await makeProperty(tenantId);
    for (let i = 0; i < 6; i++) {
      await adminDb.insert(relationshipTouch).values({
        tenantId, customerId, program: "custom", channel: "text",
        scheduledFor: daysAgo(i + 1), sentAt: daysAgo(i + 1),
      });
    }
    expect((await run("relationship.governor", tenantId)).status).toBe("fail");

    const clean = await makeTenant();
    const cc = await makeProperty(clean.tenantId);
    for (let i = 0; i < 5; i++) {
      await adminDb.insert(relationshipTouch).values({
        tenantId: clean.tenantId, customerId: cc.customerId, program: "custom", channel: "text",
        scheduledFor: daysAgo(i + 1), sentAt: daysAgo(i + 1),
      });
    }
    expect((await run("relationship.governor", clean.tenantId)).status).toBe("pass");
  });

  it("relationship.enrollment: a completed job without an enrollment row fails; enrolling clears it", async () => {
    const { tenantId } = await makeTenant();
    const { jobId, customerId } = await makeJobWithCustomer(tenantId);
    await adminDb.update(job).set({ stage: "complete", stageEnteredAt: daysAgo(3) }).where(eq(job.id, jobId));
    expect((await run("relationship.enrollment", tenantId)).status).toBe("fail");

    await adminDb.insert(relationshipEnrollment).values({ tenantId, customerId, jobId, completedAt: daysAgo(3) });
    expect((await run("relationship.enrollment", tenantId)).status).toBe("pass");
  });

  it("relationship.cadence: an enrolled customer silent >18 months fails; a sent touch clears it", async () => {
    const { tenantId } = await makeTenant();
    const { jobId, customerId } = await makeJobWithCustomer(tenantId);
    await adminDb.insert(relationshipEnrollment).values({
      tenantId, customerId, jobId, completedAt: daysAgo(700), enrolledAt: daysAgo(700),
    });
    expect((await run("relationship.cadence", tenantId)).status).toBe("fail");

    await adminDb.insert(relationshipTouch).values({
      tenantId, customerId, program: "roofiversary", channel: "text",
      scheduledFor: daysAgo(30), sentAt: daysAgo(30),
    });
    expect((await run("relationship.cadence", tenantId)).status).toBe("pass");
  });

  it("relationship.move_play: a confirmed move missing either play fails; both plays pass", async () => {
    const { tenantId } = await makeTenant();
    const { customerId, propertyId } = await makeProperty(tenantId);
    const [ev] = await adminDb.insert(moveEvent).values({
      tenantId, customerId, propertyId, status: "confirmed", confidence: 100, confirmedAt: new Date(),
    }).returning();
    expect((await run("relationship.move_play", tenantId)).status).toBe("fail");

    await adminDb.insert(relationshipTouch).values({
      tenantId, customerId, program: "move_play", channel: "text",
      scheduledFor: new Date(), sourceRef: `${ev!.id}:play_a`,
    });
    await adminDb.insert(warrantyTransfer).values({
      tenantId, propertyId, fromCustomerId: customerId, moveEventId: ev!.id,
    });
    expect((await run("relationship.move_play", tenantId)).status).toBe("pass");
  });

  it("relationship.warranty_record: a transfer on a baselined property without the Roof Record link fails", async () => {
    const { tenantId } = await makeTenant();
    const baselineId = crypto.randomUUID();
    const { customerId, propertyId } = await makeProperty(tenantId, { baseline: baselineId });
    const [wt] = await adminDb.insert(warrantyTransfer).values({
      tenantId, propertyId, fromCustomerId: customerId, baselineInspectionId: null,
    }).returning();
    expect((await run("relationship.warranty_record", tenantId)).status).toBe("fail");

    await adminDb.update(warrantyTransfer).set({ baselineInspectionId: baselineId }).where(eq(warrantyTransfer.id, wt!.id));
    expect((await run("relationship.warranty_record", tenantId)).status).toBe("pass");
  });
});
