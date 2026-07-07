import { and, eq, desc, sql } from "drizzle-orm";
import { claim } from "../schema/index";
import { appointment } from "../schema/comms";
import { withTenant } from "../tenant";
import type { ClaimStatus, InsuranceEstimateLine } from "@savvy/core";
import { bookAppointment } from "./appointments";

export type ClaimRow = typeof claim.$inferSelect;

export type UpsertClaimInput = {
  tenantId: string; jobId: string;
  claimNumber?: string | null; carrierName?: string | null;
  adjusterName?: string | null; adjusterPhone?: string | null;
  status?: ClaimStatus; acvCents?: number | null; rcvCents?: number | null;
  deductibleCents?: number | null; filedAt?: Date | null;
};

/** Insert-or-update the job's single claim (one per job via the jobId unique index). */
export async function upsertClaim(input: UpsertClaimInput): Promise<ClaimRow> {
  const { tenantId, jobId, ...rest } = input;
  // Only set columns that were provided (so an update doesn't null untouched fields).
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) set[k] = v;
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.insert(claim)
      .values({ tenantId, jobId, ...set })
      .onConflictDoUpdate({ target: claim.jobId, targetWhere: sql`${claim.jobId} is not null`, set })
      .returning();
    return row!;
  });
}

export async function getClaimForJob(tenantId: string, jobId: string): Promise<ClaimRow | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.select().from(claim).where(and(eq(claim.tenantId, tenantId), eq(claim.jobId, jobId)));
    return row ?? null;
  });
}

export type AdjusterAppointment = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  assigneeUserId: string | null;
};

/**
 * Returns the most recent status='scheduled' appointment with type='adjuster'
 * for the given job, or null if none exists.
 */
export async function getAdjusterAppointmentForJob(
  tenantId: string,
  jobId: string,
): Promise<AdjusterAppointment | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: appointment.id,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        assigneeUserId: appointment.assigneeUserId,
      })
      .from(appointment)
      .where(
        and(
          eq(appointment.tenantId, tenantId),
          eq(appointment.jobId, jobId),
          eq(appointment.type, "adjuster"),
          eq(appointment.status, "scheduled"),
        ),
      )
      .orderBy(desc(appointment.createdAt))
      .limit(1);
    return row ?? null;
  });
}

export type BookAdjusterMeetingInput = {
  tenantId: string;
  jobId: string;
  startsAt: Date;
  endsAt: Date;
  assigneeUserId?: string | null;
  customerId?: string;
};

/**
 * Books an adjuster appointment for the job and flips the job's claim status
 * to 'adjuster_scheduled'. Creates the claim row if one does not yet exist.
 * Returns the appointmentId.
 *
 * Ordering is deliberate: the appointment is booked first so a slot conflict
 * (SlotTakenError from the no-overlap EXCLUDE constraint) aborts before any
 * claim mutation. The two writes are separate tenant-scoped transactions; the
 * only non-atomic tail is the claim upsert failing after a committed
 * appointment, which leaves a valid appointment with an un-flipped status —
 * visible and self-healing (re-saving the status fixes it).
 */
export async function bookAdjusterMeeting(
  input: BookAdjusterMeetingInput,
): Promise<{ appointmentId: string }> {
  const { tenantId, jobId, startsAt, endsAt, assigneeUserId, customerId } = input;

  const { id: appointmentId } = await bookAppointment({
    tenantId,
    jobId,
    startsAt,
    endsAt,
    type: "adjuster",
    assigneeUserId: assigneeUserId ?? null,
    customerId,
  });

  await upsertClaim({ tenantId, jobId, status: "adjuster_scheduled" });

  return { appointmentId };
}

/**
 * Attach a parsed carrier estimate to the lead's claim, or create a lead-scoped shell
 * (jobId null). Parsed money/carrier fields only FILL a null (never overwrite a
 * human-confirmed value); lineItems + parseConfidence are always written.
 */
export async function attachOrCreateLeadClaim(input: {
  tenantId: string;
  leadId: string;
  propertyId: string | null;
  carrierName: string | null;
  claimNumber: string | null;
  acvCents: number | null;
  rcvCents: number | null;
  deductibleCents: number | null;
  lineItems: InsuranceEstimateLine[];
  parseConfidence: number;
}): Promise<{ claimId: string; created: boolean }> {
  return withTenant(input.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(claim)
      .where(and(eq(claim.tenantId, input.tenantId), eq(claim.leadId, input.leadId)))
      .orderBy(desc(claim.createdAt))
      .limit(1);

    if (existing) {
      await tx
        .update(claim)
        .set({
          carrierName: existing.carrierName ?? input.carrierName,
          claimNumber: existing.claimNumber ?? input.claimNumber,
          acvCents: existing.acvCents ?? input.acvCents,
          rcvCents: existing.rcvCents ?? input.rcvCents,
          deductibleCents: existing.deductibleCents ?? input.deductibleCents,
          lineItems: input.lineItems,
          parseConfidence: input.parseConfidence,
        })
        .where(eq(claim.id, existing.id));
      return { claimId: existing.id, created: false };
    }

    const [row] = await tx
      .insert(claim)
      .values({
        tenantId: input.tenantId,
        leadId: input.leadId,
        propertyId: input.propertyId,
        carrierName: input.carrierName,
        claimNumber: input.claimNumber,
        acvCents: input.acvCents,
        rcvCents: input.rcvCents,
        deductibleCents: input.deductibleCents,
        lineItems: input.lineItems,
        parseConfidence: input.parseConfidence,
      })
      .returning({ id: claim.id });
    return { claimId: row!.id, created: true };
  });
}
