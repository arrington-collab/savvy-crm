import { and, eq } from "drizzle-orm";
import type { Tx } from "../tenant";
import { canvassAchievement } from "../schema/index";

// Insert the earned badge keys the rep doesn't already have; returns the keys
// that were actually newly inserted (for the "badge unlocked!" toast). Idempotent
// via the (tenant, rep, badge_key) unique index.
export async function unlockAchievements(tx: Tx, tenantId: string, repId: string, keys: string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await tx
    .insert(canvassAchievement)
    .values(keys.map((badgeKey) => ({ tenantId, repId, badgeKey })))
    .onConflictDoNothing({ target: [canvassAchievement.tenantId, canvassAchievement.repId, canvassAchievement.badgeKey] })
    .returning({ badgeKey: canvassAchievement.badgeKey });
  return rows.map((r) => r.badgeKey);
}

export async function listAchievementKeys(tx: Tx, tenantId: string, repId: string): Promise<string[]> {
  const rows = await tx
    .select({ badgeKey: canvassAchievement.badgeKey })
    .from(canvassAchievement)
    .where(and(eq(canvassAchievement.tenantId, tenantId), eq(canvassAchievement.repId, repId)));
  return rows.map((r) => r.badgeKey);
}
