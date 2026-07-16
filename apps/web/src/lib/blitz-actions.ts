"use server";
import { approveBlitzCampaign, resolveBoostCard } from "@savvy/db";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "./current-user";

export async function approveBlitzAction(campaignId: string): Promise<{ ok: true } | { error: string }> {
  try {
    const { tenantId, userId } = await getCurrentUser();
    // TEST_MODE's sentinel "test-user" is not a UUID — store null (lead-note pattern).
    await approveBlitzCampaign(tenantId, { campaignId, userId: userId === "test-user" ? null : userId });
    revalidatePath("/today");
    return { ok: true };
  } catch {
    return { error: "could not approve" };
  }
}

export async function resolveBoostCardAction(
  boostCardId: string,
  outcome: "boosted" | "skipped",
): Promise<{ ok: true } | { error: string }> {
  try {
    const { tenantId, userId } = await getCurrentUser();
    await resolveBoostCard(tenantId, { boostCardId, outcome, userId: userId === "test-user" ? null : userId });
    revalidatePath("/today");
    return { ok: true };
  } catch {
    return { error: "could not record" };
  }
}
