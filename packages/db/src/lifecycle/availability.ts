import { and, eq, lt, gt, asc } from "drizzle-orm";
import { repAvailabilityBlock, appointment } from "../schema/index";
import { tenant } from "../schema/tenancy";
import { adminDb } from "../admin-client";
import { withTenant } from "../tenant";
import { getAssignmentCandidates } from "./assignment";
import { repsFreeAt, parseSchedulingConfig, type RepBusy } from "@savvy/core";

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

/** Reps with no scheduled appointment and no block overlapping the requested window.
 *  Window = [startsAt, startsAt + duration + buffer) for the appointment type. RLS-scoped.
 *
 *  NOTE: reads tenant.settings.scheduling directly via adminDb (bypassing RLS) to get the
 *  scheduling config — getAssignmentSettings only returns the assignment sub-key, not
 *  the full settings object, so we mirror how recommended-slots.ts reads settings. */
export async function repsAvailableAt(
  tenantId: string,
  args: { startsAt: Date; type?: "inspection" | "cm" | "crew" },
): Promise<string[]> {
  const type = args.type ?? "inspection";

  // Read full tenant settings to reach .scheduling (getAssignmentSettings returns .assignment only)
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const cfg = parseSchedulingConfig((t?.settings as { scheduling?: unknown } | null)?.scheduling ?? undefined);

  const typeCfg = cfg.types[type];
  const startsAt = args.startsAt;
  const endsAt = new Date(startsAt.getTime() + (typeCfg.durationMin + typeCfg.bufferMin) * 60_000);

  return withTenant(tenantId, async (tx) => {
    const candidates = await getAssignmentCandidates(tx, tenantId);
    const reps: RepBusy[] = await Promise.all(
      candidates.map(async (c) => {
        const appts = await tx
          .select({ startsAt: appointment.startsAt, endsAt: appointment.endsAt })
          .from(appointment)
          .where(and(eq(appointment.assigneeUserId, c.userId), eq(appointment.status, "scheduled")));
        const blocks = await getRepBlocks(tx, { tenantId, userId: c.userId, from: startsAt, to: endsAt });
        return { userId: c.userId, busy: [...appts, ...blocks] };
      }),
    );
    return repsFreeAt({ requested: { startsAt, endsAt }, reps });
  });
}
