"use server";
import { addLeadSource } from "@savvy/db";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";

export async function addLeadSourceAction(
  source: string,
): Promise<{ ok: true; sources: string[] } | { error: string }> {
  const clean = (source ?? "").trim();
  if (!clean) return { error: "Source cannot be empty" };
  try {
    const tenantId = await getTenantId();
    const sources = await addLeadSource(tenantId, clean);
    revalidatePath("/leads/new");
    return { ok: true, sources };
  } catch {
    return { error: "Could not add source" };
  }
}
