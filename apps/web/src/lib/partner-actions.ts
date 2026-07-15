"use server";
import { searchPartners, listPartnerMergeCandidates, resolveMergeCandidate } from "@savvy/db";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";

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
