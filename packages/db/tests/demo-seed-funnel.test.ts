import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { job } from "../src/schema/jobs";
import { appointment } from "../src/schema/comms";
import { provisionDemoTenant } from "../src/lifecycle/demo-seed/config";
import {
  seedApprovedJob,
  seedLeadToInspected,
  ensureLeadInspectionAppointment,
  inspectionSlotForTesting,
  demoStaff,
} from "../src/lifecycle/demo-seed/funnel";
import { bookLeadSlot } from "../src/lifecycle/booking";
import { createLeadForTenant } from "../src/lifecycle/lead-intake";
import { withTenant } from "../src/tenant";
import { setLeadOwner } from "../src/lifecycle/leads";

// Hermetic isolation: own demo tenant per run (unique clerkOrgId), unpolluted by the singleton.
const SUFFIX = `funnel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

describe("funnel: lead → approved job through the gates", () => {
  it("produces a job whose stage is at least 'approved' with real evidence", async () => {
    const { tenantId } = await provisionDemoTenant({ keySuffix: SUFFIX });
    const repId = await demoStaff(tenantId, "usr_demo_repA");
    const { jobId } = await seedApprovedJob(tenantId, {
      name: "Approved Homeowner",
      phone: "+16025550201",
      email: "approved@demo.test",
      address: "101 W Camelback Rd, Phoenix, AZ 85013",
      assigneeUserId: repId,
    });
    const [j] = await adminDb.select().from(job).where(eq(job.id, jobId));
    // 'approved' or beyond — assert the funnel didn't leave it stuck at lead/inspected/estimate.
    expect(["approved", "production", "closeout", "billing", "complete"]).toContain(j!.stage);
  });

  it("books distinct, non-colliding inspection slots for two leads on the same rep", async () => {
    const { tenantId } = await provisionDemoTenant({ keySuffix: SUFFIX });
    const repId = await demoStaff(tenantId, "usr_demo_repB");

    // Pick a slot well past the shared deterministic "next Thursday 10:00" default so
    // this test doesn't collide with leftover bookings from other runs against this
    // repo's shared local Postgres (worktrees share one DB instance).
    const testHoursOffset = 200 + Math.floor(Math.random() * 400);
    const targetSlot = inspectionSlotForTesting(testHoursOffset);
    const targetStart = new Date(targetSlot.startsAt);

    // Lead 1 occupies that slot and is left `scheduled` (NOT marked done) — this is what
    // actually collides against the exclusion constraint, which only guards `scheduled`
    // rows. It reproduces the real Task 9-11 shape: several leads on one rep with
    // inspections booked before any of them is completed (concurrent seeding, or
    // upcoming-but-not-yet-done appointments).
    const lead1Id = await createLeadForTenant(tenantId, {
      name: "Same-Rep Lead One", phone: "+16025550301", email: "samerep1@demo.test",
      address: "201 W Camelback Rd, Phoenix, AZ 85013", source: "web",
    });
    await withTenant(tenantId, (tx) => setLeadOwner(tx, { tenantId, leadId: lead1Id, userId: repId }));
    const occupied = await bookLeadSlot({ leadId: lead1Id, ...targetSlot });
    if ("error" in occupied) throw new Error(`setup: failed to occupy target slot: ${occupied.error}`);

    // Lead 2, same rep, told to start from the SAME occupied slot — must retry past the
    // collision instead of throwing `slot_taken`.
    const lead2Id = await createLeadForTenant(tenantId, {
      name: "Same-Rep Lead Two", phone: "+16025550302", email: "samerep2@demo.test",
      address: "301 W Camelback Rd, Phoenix, AZ 85013", source: "web",
    });
    await withTenant(tenantId, (tx) => setLeadOwner(tx, { tenantId, leadId: lead2Id, userId: repId }));
    const { appointmentId: appt2Id } = await ensureLeadInspectionAppointment(tenantId, lead2Id, targetStart);

    const appts = await adminDb
      .select({ id: appointment.id, startsAt: appointment.startsAt, status: appointment.status })
      .from(appointment)
      .where(and(eq(appointment.tenantId, tenantId), eq(appointment.leadId, lead2Id), eq(appointment.type, "inspection")));
    const appt2 = appts.find((a) => a.id === appt2Id);

    expect(appt2).toBeDefined();
    // Distinct appointment at a distinct time from the occupied slot — the collision
    // retry actually advanced instead of throwing.
    expect(appt2!.startsAt.getTime()).not.toBe(targetStart.getTime());
    expect(appt2!.status).toBe("done");
  });

  it("is idempotent: re-running the inspection booking for the same lead reuses its appointment", async () => {
    const { tenantId } = await provisionDemoTenant({ keySuffix: SUFFIX });
    const repId = await demoStaff(tenantId, "usr_demo_repA");
    const { leadId } = await seedLeadToInspected(tenantId, {
      name: "Idempotent Lead",
      phone: "+16025550303",
      email: "idempotent@demo.test",
      address: "401 W Camelback Rd, Phoenix, AZ 85013",
      assigneeUserId: repId,
    });

    // Re-run the same find-or-book step against the SAME leadId (what a reconciliation
    // re-run of the seeder would do for a lead that already exists) — must reuse the
    // existing appointment, not book a second one.
    const first = await adminDb
      .select({ id: appointment.id })
      .from(appointment)
      .where(and(eq(appointment.tenantId, tenantId), eq(appointment.leadId, leadId), eq(appointment.type, "inspection")));
    expect(first).toHaveLength(1);

    const { appointmentId } = await ensureLeadInspectionAppointment(tenantId, leadId);
    expect(appointmentId).toBe(first[0]!.id);

    const after = await adminDb
      .select({ id: appointment.id })
      .from(appointment)
      .where(and(eq(appointment.tenantId, tenantId), eq(appointment.leadId, leadId), eq(appointment.type, "inspection")));
    expect(after).toHaveLength(1);
  });
});
