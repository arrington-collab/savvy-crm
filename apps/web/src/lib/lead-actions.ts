"use server";
import { withTenant, convertLeadToJob, setLeadOwner, setLeadLost } from "@savvy/db";
import { leadIntakeSchema } from "@savvy/core";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";
import { createLeadForTenant } from "./intake";

export async function createLead(
  input: unknown,
): Promise<{ ok: true; leadId: string } | { error: string }> {
  const parsed = leadIntakeSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "invalid input" };
  try {
    const tenantId = await getTenantId();
    const leadId = await createLeadForTenant(tenantId, parsed.data);
    revalidatePath("/leads");
    return { ok: true, leadId };
  } catch {
    return { error: "could not create lead" };
  }
}

export async function convertLead(
  leadId: string,
): Promise<{ ok: true; jobId: string } | { error: string }> {
  const tenantId = await getTenantId();
  try {
    const { jobId } = await convertLeadToJob({ tenantId, leadId });
    revalidatePath("/leads");
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/jobs");
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true, jobId };
  } catch {
    return { error: "could not convert lead" };
  }
}

export async function assignLeadOwner(
  leadId: string,
  userId: string | null,
): Promise<{ ok: true } | { error: string }> {
  const tenantId = await getTenantId();
  try {
    await withTenant(tenantId, (tx) => setLeadOwner(tx, { tenantId, leadId, userId }));
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/leads");
    return { ok: true };
  } catch {
    return { error: "could not assign owner" };
  }
}

export async function markLeadLost(
  leadId: string,
): Promise<{ ok: true } | { error: string }> {
  const tenantId = await getTenantId();
  try {
    await withTenant(tenantId, (tx) => setLeadLost(tx, { tenantId, leadId }));
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/leads");
    return { ok: true };
  } catch {
    return { error: "could not mark lead lost" };
  }
}
