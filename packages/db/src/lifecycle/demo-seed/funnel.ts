import { and, eq } from "drizzle-orm";
import type { RoofSketch } from "@savvy/core";
import { adminDb } from "../../admin-client";
import { withTenant } from "../../tenant";
import { user } from "../../schema/tenancy";
import { estimate } from "../../schema/finance";
import { createLeadForTenant } from "../lead-intake";
import { setLeadOwner } from "../leads";
import { bookLeadSlot } from "../booking";
import { setAppointmentStatus } from "../appointments";
import { convertLeadToJob } from "../appointments";
import { saveSketchMeasurement } from "../measurement";
import { draftLeadEstimateIfReady, setEstimateStatus } from "../estimate";
import { ConversionBlockedError } from "../lead-tasks";
import { squareSketch } from "./sketch-fixture";

/**
 * Input to the funnel seeders. `sketch` overrides the default 20×20 square DIY sketch.
 * `assigneeUserId` becomes the lead owner (so the inspection + resulting job carry the
 * right rep for demo attribution).
 */
export interface DemoLeadInput {
  name: string;
  phone: string;
  email: string;
  address: string;
  assigneeUserId: string;
  sketch?: RoofSketch;
}

/** Resolve a demo staff user id by its deterministic clerk id. */
export async function demoStaff(tenantId: string, clerkUserId: string): Promise<string> {
  const [u] = await adminDb
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.tenantId, tenantId), eq(user.clerkUserId, clerkUserId)));
  if (!u) throw new Error(`demo staff ${clerkUserId} not found — run provisionDemoTenant first`);
  return u.id;
}

// A fixed weekday slot (a future Thursday 10:00–12:00 local) so bookings are deterministic
// and never collide with weekend/holiday scheduling rules.
function inspectionSlot(): { startsAt: string; endsAt: string } {
  const d = new Date();
  d.setUTCHours(17, 0, 0, 0); // 10:00 America/Phoenix (UTC-7)
  // advance to the next Thursday (getUTCDay: Thu = 4)
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() !== 4);
  const starts = new Date(d);
  const ends = new Date(d.getTime() + 2 * 3600_000);
  return { startsAt: starts.toISOString(), endsAt: ends.toISOString() };
}

/**
 * Drive a lead up through the `inspected` evidence gate: create the lead, book +
 * complete an inspection, and save a DIY sketch measurement. No job exists yet — a
 * job only appears at acceptance/approval. Returns the lead id.
 */
export async function seedLeadToInspected(
  tenantId: string,
  input: DemoLeadInput,
): Promise<{ leadId: string }> {
  const leadId = await createLeadForTenant(tenantId, {
    name: input.name,
    phone: input.phone,
    email: input.email,
    address: input.address,
    source: "web",
  });

  // Own the lead so the inspection + eventual job carry the intended rep.
  await withTenant(tenantId, async (tx) => {
    await setLeadOwner(tx, { tenantId, leadId, userId: input.assigneeUserId });
  });

  const booked = await bookLeadSlot({ leadId, ...inspectionSlot() });
  if ("error" in booked) throw new Error(`bookLeadSlot failed: ${booked.error}`);
  await setAppointmentStatus({ tenantId, appointmentId: booked.appointmentId, status: "done" });

  const saved = await saveSketchMeasurement({
    tenantId,
    scope: { kind: "lead", id: leadId },
    sketch: input.sketch ?? squareSketch(),
  });
  if ("error" in saved) throw new Error(`saveSketchMeasurement failed: ${saved.error}`);

  return { leadId };
}

/**
 * Extend the funnel through `estimate` + delivery: draft the lead-stage estimate off
 * the inspection + measurement evidence, then mark it 'sent'. Returns lead + estimate id.
 */
export async function seedLeadToEstimateSent(
  tenantId: string,
  input: DemoLeadInput,
): Promise<{ leadId: string; estimateId: string }> {
  const { leadId } = await seedLeadToInspected(tenantId, input);

  const drafted = await draftLeadEstimateIfReady({ tenantId, leadId });
  let estimateId: string;
  if ("estimateId" in drafted) {
    estimateId = drafted.estimateId;
  } else {
    // Idempotent path: an estimate already exists for this lead.
    const [row] = await adminDb
      .select({ id: estimate.id })
      .from(estimate)
      .where(and(eq(estimate.tenantId, tenantId), eq(estimate.leadId, leadId)));
    if (!row) throw new Error(`draftLeadEstimateIfReady skipped (${drafted.skipped}) and no estimate found`);
    estimateId = row.id;
  }

  await setEstimateStatus({ tenantId, estimateId, status: "sent" });
  return { leadId, estimateId };
}

/**
 * Accept the estimate and convert the lead to a job. The job lands at its
 * evidence-supported stage — with an accepted estimate + completed inspection +
 * measurement that is `approved`. Never forces a stage; `convertLeadToJob` derives it.
 */
export async function seedApprovedJob(
  tenantId: string,
  input: DemoLeadInput,
): Promise<{ jobId: string }> {
  const { leadId, estimateId } = await seedLeadToEstimateSent(tenantId, input);

  // Replicates advanceJobForAcceptedEstimate's effect via @savvy/db primitives:
  // mark accepted, then convert the lead (which requires the accepted estimate and
  // auto-lands the job at its evidence-derived stage).
  await setEstimateStatus({ tenantId, estimateId, status: "accepted" });

  try {
    const { jobId } = await convertLeadToJob({ tenantId, leadId, trigger: "estimate-sign" });
    return { jobId };
  } catch (err) {
    // Open MANUAL lead tasks block conversion — auto-resolve them (not_applicable) and retry.
    if (err instanceof ConversionBlockedError) {
      const resolutions: Record<number, { status: "not_applicable"; reason: string }> = {};
      for (const taskId of err.openManualTaskIds) {
        resolutions[taskId] = { status: "not_applicable", reason: "demo seed: funnel superseded" };
      }
      const { jobId } = await convertLeadToJob({ tenantId, leadId, trigger: "estimate-sign", resolutions });
      return { jobId };
    }
    throw err;
  }
}
