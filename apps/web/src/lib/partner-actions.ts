"use server";
import { searchPartners, listPartnerMergeCandidates, resolveMergeCandidate, findOrCreatePartner, logPartnerExpense, resolveCDecision } from "@savvy/db";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";
import { getCurrentUser } from "./current-user";

export async function searchPartnersAction(
  query: string,
): Promise<Array<{ id: string; name: string; org: string | null; class: string }>> {
  if (!query.trim()) return [];
  const tenantId = await getTenantId();
  return searchPartners(tenantId, query);
}

export async function listPartnerMergeCandidatesAction(): Promise<
  Awaited<ReturnType<typeof listPartnerMergeCandidates>>
> {
  const tenantId = await getTenantId();
  return listPartnerMergeCandidates(tenantId);
}

/** Phone-friendly expense quick-log: amount + note + picked/created partner. */
export async function logPartnerExpenseAction(input: {
  partnerId?: string;
  partner?: { name: string; org?: string };
  amountCents: number;
  note: string;
}): Promise<{ ok: true } | { error: string }> {
  try {
    const { tenantId, userId } = await getCurrentUser();
    let partnerId = input.partnerId ?? null;
    if (!partnerId && input.partner) {
      partnerId = (await findOrCreatePartner(tenantId, input.partner)).id;
    }
    if (!partnerId) return { error: "Pick a partner" };
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) return { error: "Enter an amount" };
    // TEST_MODE's getCurrentUser returns the non-UUID sentinel "test-user" —
    // created_by_user_id takes null rather than a fake id (lead-note pattern).
    const createdByUserId = userId === "test-user" ? null : userId;
    await logPartnerExpense(tenantId, { partnerId, amountCents: input.amountCents, note: input.note, createdByUserId });
    revalidatePath("/partners/expense");
    return { ok: true };
  } catch {
    return { error: "could not log expense" };
  }
}

/** Human resolution of a C-partner decision card (cards, never cutoffs). */
export async function resolveCDecisionAction(
  partnerId: string,
  resolution: "conversation" | "slack_capacity_only" | "dismissed",
): Promise<{ ok: true } | { error: string }> {
  try {
    const tenantId = await getTenantId();
    await resolveCDecision(tenantId, { partnerId, resolution });
    revalidatePath("/today");
    revalidatePath("/partners");
    revalidatePath(`/partners/${partnerId}`);
    return { ok: true };
  } catch {
    return { error: "could not resolve" };
  }
}

export async function resolveMergeCandidateAction(
  candidateId: string,
  action: "merge" | "keep_separate",
): Promise<{ ok: true } | { error: string }> {
  try {
    const tenantId = await getTenantId();
    await resolveMergeCandidate(tenantId, { candidateId, action });
    revalidatePath("/partners/review");
    revalidatePath("/today");
    return { ok: true };
  } catch {
    return { error: "could not resolve merge" };
  }
}
