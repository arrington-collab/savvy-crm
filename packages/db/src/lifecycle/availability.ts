import { and, eq, lt, gt, asc } from "drizzle-orm";
import { repAvailabilityBlock } from "../schema/index";

type Tx = Parameters<Parameters<typeof import("../client").db.transaction>[0]>[0];

/** Blocks for one rep that overlap [from, to), ordered by start. Tenant-scoped via RLS (tx). */
export async function getRepBlocks(
  tx: Tx,
  args: { tenantId: string; userId: string; from: Date; to: Date },
): Promise<{ startsAt: Date; endsAt: Date }[]> {
  const rows = await tx
    .select({ startsAt: repAvailabilityBlock.startsAt, endsAt: repAvailabilityBlock.endsAt })
    .from(repAvailabilityBlock)
    .where(
      and(
        eq(repAvailabilityBlock.tenantId, args.tenantId),
        eq(repAvailabilityBlock.userId, args.userId),
        lt(repAvailabilityBlock.startsAt, args.to),
        gt(repAvailabilityBlock.endsAt, args.from),
      ),
    )
    .orderBy(asc(repAvailabilityBlock.startsAt));
  return rows.map((r) => ({ startsAt: r.startsAt, endsAt: r.endsAt }));
}
