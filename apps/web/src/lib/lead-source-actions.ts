"use server";
import { addLeadSource } from "@savvy/db";
import { getTenantId } from "./tenant";

export async function addLeadSourceAction(
  source: string,
): Promise<{ ok: true; sources: string[] } | { error: string }> {
  const clean = (source ?? "").trim();
  if (!clean) return { error: "Source cannot be empty" };
  if (clean.length > 100) return { error: "Source name is too long" };
  try {
    const tenantId = await getTenantId();
    const sources = await addLeadSource(tenantId, clean);
    return { ok: true, sources };
  } catch {
    return { error: "Could not add source" };
  }
}
