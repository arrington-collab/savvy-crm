import { and, eq } from "drizzle-orm";
import { lead, user } from "../schema/index";
import { db } from "../client";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Sets (or clears, when userId is null) the lead's owner. Validates that a
 * non-null user belongs to the tenant; throws otherwise. Idempotent.
 */
export async function setLeadOwner(
  tx: Tx,
  opts: { tenantId: string; leadId: string; userId: string | null },
): Promise<void> {
  if (opts.userId !== null) {
    const [u] = await tx
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.id, opts.userId), eq(user.tenantId, opts.tenantId)));
    if (!u) throw new Error("user not in tenant");
  }
  await tx
    .update(lead)
    .set({ assignedUserId: opts.userId })
    .where(and(eq(lead.id, opts.leadId), eq(lead.tenantId, opts.tenantId)));
}

/** Marks the lead lost (status='lost'). No-op if already lost. */
export async function setLeadLost(
  tx: Tx,
  opts: { tenantId: string; leadId: string },
): Promise<void> {
  await tx
    .update(lead)
    .set({ status: "lost" })
    .where(and(eq(lead.id, opts.leadId), eq(lead.tenantId, opts.tenantId)));
}
