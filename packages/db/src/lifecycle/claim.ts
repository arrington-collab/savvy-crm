import { and, eq } from "drizzle-orm";
import { claim } from "../schema/index";
import { withTenant } from "../tenant";
import type { ClaimStatus } from "@savvy/core";

export type ClaimRow = typeof claim.$inferSelect;

export type UpsertClaimInput = {
  tenantId: string; jobId: string;
  claimNumber?: string | null; carrierName?: string | null;
  adjusterName?: string | null; adjusterPhone?: string | null;
  status?: ClaimStatus; acvCents?: number | null; rcvCents?: number | null;
  deductibleCents?: number | null; filedAt?: Date | null;
};

/** Insert-or-update the job's single claim (one per job via the jobId unique index). */
export async function upsertClaim(input: UpsertClaimInput): Promise<ClaimRow> {
  const { tenantId, jobId, ...rest } = input;
  // Only set columns that were provided (so an update doesn't null untouched fields).
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) set[k] = v;
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.insert(claim)
      .values({ tenantId, jobId, ...set })
      .onConflictDoUpdate({ target: claim.jobId, set })
      .returning();
    return row!;
  });
}

export async function getClaimForJob(tenantId: string, jobId: string): Promise<ClaimRow | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.select().from(claim).where(and(eq(claim.tenantId, tenantId), eq(claim.jobId, jobId)));
    return row ?? null;
  });
}
