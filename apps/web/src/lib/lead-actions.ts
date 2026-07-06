"use server";
import { withTenant, convertLeadToJob, setLeadOwner, setLeadLost, markLeadContacted, property, eq } from "@savvy/db";
import { leadIntakeSchema, ROOF_TYPE_VALUES } from "@savvy/core";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";
import { createLeadForTenant } from "./intake";
import { inngest } from "@savvy/agents";

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
    // Manual "convert lead" is the out-of-funnel escape hatch (insurance
    // emergencies): create the job without requiring an accepted estimate.
    const { jobId } = await convertLeadToJob({ tenantId, leadId, manualJob: true });
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
    try { await inngest.send({ name: "lead/disqualified", data: { leadId, tenantId } }); } catch (e) { console.error(e); }
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/leads");
    return { ok: true };
  } catch {
    return { error: "could not mark lead lost" };
  }
}

/** Human-supplied roof type (resolves a roof_type_needed exception). Validated against the enum. */
export async function setPropertyRoofType(
  leadId: string,
  propertyId: string,
  roofType: string,
): Promise<{ ok: true } | { error: string }> {
  if (!(ROOF_TYPE_VALUES as readonly string[]).includes(roofType)) return { error: "invalid roof type" };
  try {
    const tenantId = await getTenantId();
    await withTenant(tenantId, (tx) => tx.update(property).set({ roofType }).where(eq(property.id, propertyId)));
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/exceptions");
    return { ok: true };
  } catch {
    return { error: "could not set roof type" };
  }
}

export async function logLeadContact(leadId: string): Promise<{ ok: true } | { error: string }> {
  try {
    const tenantId = await getTenantId();
    const set = await withTenant(tenantId, (tx) => markLeadContacted(tx, { tenantId, leadId }));
    if (set) {
      try { await inngest.send({ name: "lead/contacted", data: { leadId, tenantId } }); } catch (e) { console.error(e); }
    }
    revalidatePath(`/leads/${leadId}`);
    return { ok: true };
  } catch {
    return { error: "could not log contact" };
  }
}
