"use server";
import { withTenant, convertLeadToJob, setLeadOwner, setLeadLost, markLeadContacted, addLeadNote, property, eq } from "@savvy/db";
import { leadIntakeSchema, ROOF_TYPE_VALUES, ROOF_REPLACEMENT_SOURCE_VALUES } from "@savvy/core";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";
import { createLeadForTenant } from "./intake";
import { inngest } from "@savvy/agents";
import { getCurrentUser } from "./current-user";

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
    const { jobId } = await convertLeadToJob({ tenantId, leadId, manualJob: true, reason: "manual convert (out-of-funnel)" });
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

/** Human-supplied primary + optional secondary roof type. Both validated against the enum. */
export async function setPropertyRoofTypes(
  leadId: string,
  propertyId: string,
  roofTypes: { primary: string; secondary: string | null },
): Promise<{ ok: true } | { error: string }> {
  const okPrimary = (ROOF_TYPE_VALUES as readonly string[]).includes(roofTypes.primary);
  const okSecondary = roofTypes.secondary === null || (ROOF_TYPE_VALUES as readonly string[]).includes(roofTypes.secondary);
  if (!okPrimary || !okSecondary) return { error: "invalid roof type" };
  try {
    const tenantId = await getTenantId();
    await withTenant(tenantId, (tx) =>
      tx.update(property).set({ roofType: roofTypes.primary, roofTypeSecondary: roofTypes.secondary }).where(eq(property.id, propertyId)));
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/exceptions");
    return { ok: true };
  } catch {
    return { error: "could not set roof type" };
  }
}

/** Human-supplied last roof-replacement date + source. Rejects invalid source/date and future dates. */
export async function setRoofReplacement(
  leadId: string,
  propertyId: string,
  input: { at: string; source: string },
): Promise<{ ok: true } | { error: string }> {
  if (!(ROOF_REPLACEMENT_SOURCE_VALUES as readonly string[]).includes(input.source)) return { error: "invalid source" };
  const at = new Date(input.at);
  if (Number.isNaN(at.getTime())) return { error: "invalid date" };
  if (at.getTime() > Date.now()) return { error: "replacement date cannot be in the future" };
  try {
    const tenantId = await getTenantId();
    await withTenant(tenantId, (tx) =>
      tx.update(property).set({ lastRoofReplacementAt: input.at, lastRoofReplacementSource: input.source }).where(eq(property.id, propertyId)));
    revalidatePath(`/leads/${leadId}`);
    return { ok: true };
  } catch {
    return { error: "could not save replacement" };
  }
}

/** Append-only lead note quick-add. Rejects empty/whitespace bodies. No edit/delete by design. */
export async function addLeadNoteAction(
  leadId: string,
  body: string,
): Promise<{ ok: true } | { error: string }> {
  if (!body.trim()) return { error: "empty note" };
  try {
    const { tenantId, userId } = await getCurrentUser();
    // TEST_MODE's getCurrentUser returns the non-UUID sentinel "test-user"; the
    // lead_note author_user_id FK takes null rather than a fake id (same pattern
    // as job_task.owner / audit.user_id).
    const localUserId = userId === "test-user" ? null : userId;
    await withTenant(tenantId, (tx) =>
      addLeadNote(tx, { tenantId, leadId, authorUserId: localUserId, body }),
    );
    revalidatePath(`/leads/${leadId}`);
    return { ok: true };
  } catch {
    return { error: "could not add note" };
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
