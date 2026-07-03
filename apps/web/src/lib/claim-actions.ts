"use server";
import { revalidatePath } from "next/cache";
import { upsertClaim, bookAdjusterMeeting, SlotTakenError, draftDepreciationInvoice, sendDepreciationInvoice } from "@savvy/db";
import { inngest } from "@savvy/agents";
import type { ClaimStatus } from "@savvy/core";
import { getTenantId } from "./tenant";
import { log } from "./log";

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

/**
 * Office-staff step of the depreciation-recovery workflow (§G): the staffer has updated the
 * Xactimate pricing to current (optionally supplying the new RCV). This auto-drafts the
 * depreciation invoice and holds it in Needs-you for a one-tap send — nothing goes to the
 * carrier yet.
 */
export async function uploadXactimatePricingAction(input: { jobId: string; updatedRcvDollars: string }) {
  const tenantId = await getTenantId();
  const updatedRcvCents = dollarsToCents(input.updatedRcvDollars);
  const r = await draftDepreciationInvoice({
    tenantId,
    jobId: input.jobId,
    updatedRcvCents: updatedRcvCents ?? undefined,
  });
  revalidatePath(`/jobs/${input.jobId}`);
  if ("skipped" in r) return { error: r.skipped as string };
  return { ok: true as const, invoiceId: r.invoiceId, amountCents: r.amountCents };
}

/**
 * The one-tap "send to carrier" approval: flips the draft depreciation invoice to sent and
 * emits invoice/sent (QBO push + billing-stage advance). Nothing reaches the carrier without it.
 */
export async function sendDepreciationInvoiceAction(input: { jobId: string; invoiceId: string }) {
  const tenantId = await getTenantId();
  const r = await sendDepreciationInvoice({ tenantId, jobId: input.jobId, invoiceId: input.invoiceId });
  if ("skipped" in r) {
    revalidatePath(`/jobs/${input.jobId}`);
    return { error: r.skipped as string };
  }
  try { await inngest.send({ name: "invoice/sent", data: { tenantId, invoiceId: input.invoiceId } }); }
  catch (e) { log.error("invoice/sent emit failed (depreciation)", { jobId: input.jobId, msg: String(e) }); }
  revalidatePath(`/jobs/${input.jobId}`);
  return { ok: true as const };
}
