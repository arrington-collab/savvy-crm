import { withTenant } from "../tenant";
import { lead } from "../schema/crm";
import { measurement } from "../schema/ops";
import { estimate } from "../schema/finance";
import { desc, eq } from "drizzle-orm";

export type LeadArtifacts = {
  measurement: {
    id: string;
    provider: string | null;
    squares: number | null;
    pitch: string | null;
    reportUrl: string | null;
  } | null;
  estimate: {
    id: string;
    status: string;
    total: number | null;
    wastePctUsed: number | null;
    approvalRequiredAt: Date | null;
    jobId: string | null;
  } | null;
};

/**
 * Slice 1 lead tile: the lead's measurement (newest for its property; Roofr or DIY)
 * and its estimate (newest). Powers the Measurement + Estimate sections on the lead
 * detail page.
 */
export async function getLeadArtifacts(input: { tenantId: string; leadId: string }): Promise<LeadArtifacts> {
  return withTenant(input.tenantId, async (tx) => {
    const [l] = await tx.select({ propertyId: lead.propertyId }).from(lead).where(eq(lead.id, input.leadId));

    const [m] = l?.propertyId
      ? await tx.select().from(measurement).where(eq(measurement.propertyId, l.propertyId)).orderBy(desc(measurement.createdAt)).limit(1)
      : [undefined];

    const [e] = await tx.select().from(estimate).where(eq(estimate.leadId, input.leadId)).orderBy(desc(estimate.createdAt)).limit(1);

    const areas = (m?.areas ?? {}) as Record<string, unknown>;
    return {
      measurement: m
        ? {
            id: m.id,
            provider: m.provider,
            squares: typeof areas.squares === "number" ? areas.squares : null,
            pitch: m.pitch,
            reportUrl: m.reportUrl,
          }
        : null,
      estimate: e
        ? { id: e.id, status: e.status, total: e.total, wastePctUsed: e.wastePctUsed, approvalRequiredAt: e.approvalRequiredAt, jobId: e.jobId }
        : null,
    };
  });
}
