"use server";
import { revalidatePath } from "next/cache";
import { upsertClaim, bookAdjusterMeeting, SlotTakenError } from "@savvy/db";
import type { ClaimStatus } from "@savvy/core";
import { getTenantId } from "./tenant";

function dollarsToCents(s: string): number | null {
  if (s.trim() === "") return null;
  const v = Math.round(parseFloat(s) * 100);
  return isNaN(v) ? null : v;
}

function textOrNull(s: string): string | null {
  const t = s.trim();
  return t === "" ? null : t;
}

function dateOrNull(s: string): Date | null {
  return s ? new Date(s) : null;
}

export async function saveClaimAction(input: {
  jobId: string;
  claimNumber: string;
  carrierName: string;
  adjusterName: string;
  adjusterPhone: string;
  status: ClaimStatus;
  acvDollars: string;
  rcvDollars: string;
  deductibleDollars: string;
  filedAt: string;
}) {
  const tenantId = await getTenantId();
  await upsertClaim({
    tenantId,
    jobId: input.jobId,
    claimNumber: textOrNull(input.claimNumber),
    carrierName: textOrNull(input.carrierName),
    adjusterName: textOrNull(input.adjusterName),
    adjusterPhone: textOrNull(input.adjusterPhone),
    status: input.status,
    acvCents: dollarsToCents(input.acvDollars),
    rcvCents: dollarsToCents(input.rcvDollars),
    deductibleCents: dollarsToCents(input.deductibleDollars),
    filedAt: dateOrNull(input.filedAt),
  });
  revalidatePath(`/jobs/${input.jobId}`);
  return { ok: true as const };
}

export async function bookAdjusterMeetingAction(input: {
  jobId: string;
  startsAtISO: string;
  durationMin?: number;
}) {
  const tenantId = await getTenantId();
  const startsAt = new Date(input.startsAtISO);
  if (isNaN(startsAt.getTime())) return { error: "invalid_time" as const };
  const endsAt = new Date(startsAt.getTime() + (input.durationMin ?? 60) * 60_000);
  try {
    await bookAdjusterMeeting({ tenantId, jobId: input.jobId, startsAt, endsAt });
  } catch (e) {
    if (e instanceof SlotTakenError) return { error: "slot_taken" as const };
    throw e;
  }
  revalidatePath(`/jobs/${input.jobId}`);
  return { ok: true as const };
}
