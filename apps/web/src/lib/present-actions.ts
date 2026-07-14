"use server";
import { redirect } from "next/navigation";
import { ensureEstimateLink } from "@savvy/db";
import { getTenantId } from "./tenant";

/** Slice 5: the rep launches the kitchen-table close from the lead tile. */
export async function launchPresentMode(estimateId: string): Promise<never> {
  const tenantId = await getTenantId();
  const { code } = await ensureEstimateLink({ tenantId, estimateId });
  redirect(`/estimate/${code}?present=1`);
}
