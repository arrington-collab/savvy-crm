import { and, eq, inArray } from "drizzle-orm";
import type { RoofSketch } from "@savvy/core";
import { adminDb } from "../../admin-client";
import { withTenant } from "../../tenant";
import { user } from "../../schema/tenancy";
import { estimate } from "../../schema/finance";
import { appointment } from "../../schema/comms";
import { createLeadForTenant } from "../lead-intake";
import { setLeadOwner } from "../leads";
import { bookLeadSlot } from "../booking";
import { setAppointmentStatus, convertLeadToJob } from "../appointments";
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
// and never collide with weekend/holiday scheduling rules by default.
//
// Arizona has no DST, so Phoenix local time is a fixed UTC-7 offset year-round: business
// hours 08:00–17:00 local map to a fixed UTC-hour window [15, 22] with no day-rollover
// ambiguity, which is what makes the retry stepping below simple integer arithmetic.
const PHOENIX_BUSINESS_START_UTC_HOUR = 15; // 08:00 America/Phoenix
const PHOENIX_BUSINESS_LAST_START_UTC_HOUR = 22; // 15:00 America/Phoenix (2h appt ends 17:00)

function isWeekdayUTC(d: Date): boolean {
  const day = d.getUTCDay();
  return day >= 1 && day <= 5;
}

function firstInspectionSlotStart(): Date {
  const d = new Date();
  d.setUTCHours(PHOENIX_BUSINESS_START_UTC_HOUR + 2, 0, 0, 0); // 10:00 America/Phoenix
  // advance to the next Thursday (getUTCDay: Thu = 4)
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() !== 4);
  return d;
}

/** Step a slot start forward by one hour, rolling to the next weekday's opening once
 * business hours are exhausted for the day. Used to walk past `slot_taken` collisions
 * deterministically (same starting point + same number of prior collisions ⇒ same slot). */
function nextInspectionSlotStart(prevStart: Date): Date {
  const d = new Date(prevStart.getTime() + 3600_000);
  if (d.getUTCHours() > PHOENIX_BUSINESS_LAST_START_UTC_HOUR || d.getUTCHours() < PHOENIX_BUSINESS_START_UTC_HOUR) {
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(PHOENIX_BUSINESS_START_UTC_HOUR, 0, 0, 0);
  }
  while (!isWeekdayUTC(d)) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

function slotFromStart(start: Date): { startsAt: string; endsAt: string } {
  return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 2 * 3600_000).toISOString() };
}

/** Compute an arbitrary weekday, business-hours slot N hours past the deterministic
 * first-choice slot. Exposed for tests that need to pre-occupy a *known* slot (as a
 * `scheduled` appointment) to exercise the `slot_taken` retry path without touching the
 * shared "next Thursday 10:00" slot real seed runs converge on (this repo's local
 * Postgres is shared across worktrees, so that slot may carry leftover bookings). */
export function inspectionSlotForTesting(hoursPastFirst: number): { startsAt: string; endsAt: string } {
  let start = firstInspectionSlotStart();
  for (let i = 0; i < hoursPastFirst; i++) start = nextInspectionSlotStart(start);
  return slotFromStart(start);
}

const MAX_SLOT_COLLISION_RETRIES = 40;

/**
 * Book a lead's inspection slot, advancing deterministically past any `slot_taken`
 * collision (same rep double-booked by a prior lead in this seed run) until an open
 * slot is found. Multi-lead-per-rep seeding relies on this — a fixed slot would collide
 * on the 2nd+ lead for the same rep. `startAt` overrides the deterministic first-choice
 * slot (test-only — production callers always start from the real first-choice slot).
 */
async function bookInspectionSlotWithRetry(leadId: string, startAt?: Date): Promise<{ appointmentId: string }> {
  let start = startAt ?? firstInspectionSlotStart();
  for (let attempt = 0; attempt < MAX_SLOT_COLLISION_RETRIES; attempt++) {
    const booked = await bookLeadSlot({ leadId, ...slotFromStart(start) });
    if (!("error" in booked)) return { appointmentId: booked.appointmentId };
    if (booked.error !== "slot_taken") throw new Error(`bookLeadSlot failed: ${booked.error}`);
    start = nextInspectionSlotStart(start);
  }
  throw new Error(`bookLeadSlot: exhausted ${MAX_SLOT_COLLISION_RETRIES} slot_taken retries for lead ${leadId}`);
}

/** Idempotency: reuse a lead's existing inspection appointment (scheduled or done)
 * instead of booking a second one on re-run. */
async function findExistingInspectionAppointment(
  tenantId: string,
  leadId: string,
): Promise<{ id: string; status: string } | undefined> {
  const [row] = await adminDb
    .select({ id: appointment.id, status: appointment.status })
    .from(appointment)
    .where(
      and(
        eq(appointment.tenantId, tenantId),
        eq(appointment.leadId, leadId),
        eq(appointment.type, "inspection"),
        inArray(appointment.status, ["scheduled", "done"]),
      ),
    );
  return row;
}

/**
 * Idempotently ensure a lead has a completed inspection appointment: reuse an existing
 * scheduled/done inspection if one is already booked for this lead (re-run safe), else
 * book one, retrying past `slot_taken` collisions from other leads already booked on the
 * same rep in this seed run. Exported for direct testing of the collision-retry +
 * find-or-reuse idempotency behavior in isolation from lead creation.
 */
export async function ensureLeadInspectionAppointment(
  tenantId: string,
  leadId: string,
  startAtForTesting?: Date,
): Promise<{ appointmentId: string }> {
  const existing = await findExistingInspectionAppointment(tenantId, leadId);
  const appointmentId = existing ? existing.id : (await bookInspectionSlotWithRetry(leadId, startAtForTesting)).appointmentId;
  if (existing?.status !== "done") {
    await setAppointmentStatus({ tenantId, appointmentId, status: "done" });
  }
  return { appointmentId };
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

  await ensureLeadInspectionAppointment(tenantId, leadId);

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
