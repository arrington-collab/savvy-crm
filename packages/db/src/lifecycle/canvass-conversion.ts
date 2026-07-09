import { eq } from "drizzle-orm";
import { withTenant } from "../tenant";
import { job } from "../schema/jobs";
import { property } from "../schema/crm";
import { tenant } from "../schema/tenancy";
import { rescissionReleaseAt } from "@savvy/core";
import type { CanvassContract } from "@savvy/core";
import { convertLeadToJob } from "./appointments";

/**
 * Convert a signed canvass contract's lead into a job (manualJob — a signed contract is the
 * authorization; no accepted estimate exists on a door sale), then stamp the statutory
 * rescission hold + denormalized rep name on the job. Idempotent: convertLeadToJob keys off
 * job.lead_id (replay returns the same job); the metadata set is a plain overwrite.
 */
export async function convertCanvassContractToJob(input: {
  tenantId: string;
  leadId: string;
  contract: CanvassContract;
}): Promise<{ jobId: string }> {
  const { jobId } = await convertLeadToJob({
    tenantId: input.tenantId, leadId: input.leadId, manualJob: true,
    // A signed canvass contract IS the authorization — it lives on the job's
    // rescissionHoldUntil/canvassRepName fields (stamped below), not a `document`
    // row, so it doesn't satisfy the generic contract-document check itself.
    reason: `canvass: signed contract (${input.contract.rep})`,
    // Task 10 conversion resolution gate: labels the auto-resolution note on open
    // non-manual lead tasks. Open MANUAL lead tasks with no resolution throw
    // ConversionBlockedError, which the caller (canvass-contract.ts) catches.
    trigger: "canvass",
  });

  await withTenant(input.tenantId, async (tx) => {
    const [j] = await tx.select({ propertyId: job.propertyId }).from(job).where(eq(job.id, jobId));
    const state = j?.propertyId
      ? (await tx.select({ state: property.state }).from(property).where(eq(property.id, j.propertyId)))[0]?.state ?? null
      : null;
    const [t] = await tx.select({ timezone: tenant.timezone, settings: tenant.settings }).from(tenant).where(eq(tenant.id, input.tenantId));
    const config = (t?.settings as { rescissionDays?: Record<string, number> } | undefined)?.rescissionDays ?? undefined;
    const holdUntil = rescissionReleaseAt({
      state,
      signedAt: new Date(input.contract.signedAt),
      timezone: t?.timezone ?? "America/Phoenix",
      config,
    });
    await tx.update(job).set({ rescissionHoldUntil: holdUntil, canvassRepName: input.contract.rep }).where(eq(job.id, jobId));
  });

  return { jobId };
}
