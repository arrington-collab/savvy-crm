"use server";
import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { startInspectionForLead, completeInspection } from "@savvy/db";
import { inngest } from "@savvy/agents";
import { getTenantId } from "@/lib/tenant";

/** Manual start from the lead tile (the non-BloomCam path). Idempotent per lead. */
export async function startLeadInspection(leadId: string): Promise<{ inspectionId: string } | { error: string }> {
  const tenantId = await getTenantId();
  const { userId } = await auth();
  const res = await startInspectionForLead({ tenantId, leadId, inspectorUserId: null, kind: "initial" });
  void userId; // Clerk user id ≠ savvy user uuid; inspector attribution lands with the BloomCam identity work (slice 2).
  if ("error" in res) return { error: res.error };
  revalidatePath(`/leads/${leadId}`);
  return { inspectionId: res.inspectionId };
}

/** Manual complete from the lead tile ("I'm down — finalize"). */
export async function completeLeadInspection(leadId: string, inspectionId: string): Promise<{ ok: boolean }> {
  const tenantId = await getTenantId();
  const res = await completeInspection({ tenantId, inspectionId });
  if (!("error" in res)) {
    // Fail-soft, same as the BloomCam route: the final re-price is an
    // optimization — the pre-draft already refreshed per photo.
    try { await inngest.send({ name: "inspection/completed", data: { tenantId, inspectionId, leadId } }); } catch { /* noop */ }
  }
  revalidatePath(`/leads/${leadId}`);
  return { ok: !("error" in res) };
}
