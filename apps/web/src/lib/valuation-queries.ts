import "server-only";
import { listValuationSnapshots, recordValuationSnapshot, adminDb, tenant, eq } from "@savvy/db";
import { parseValuationConfig, buildValueLevers, type ValuationConfig, type ValuationSnapshotResult, type ValueLever } from "@savvy/core";
import { getTenantId } from "./tenant";

export type ValuationSnapshotRow = Awaited<ReturnType<typeof listValuationSnapshots>>[number];

export type OwnersRoomData = {
  latest: ValuationSnapshotRow;
  /** Likely-value delta vs ~3 periods back; null until history exists. */
  quarterDeltaCents: number | null;
  levers: ValueLever[];
  config: ValuationConfig;
};

/**
 * The room reads the monthly snapshot; a tenant that has never snapshotted
 * gets one computed on first visit (automatic, no button) — the cron keeps it
 * fresh after that.
 */
export async function getOwnersRoom(): Promise<OwnersRoomData> {
  const tenantId = await getTenantId();
  const [t] = await adminDb.select({ settings: tenant.settings, timezone: tenant.timezone })
    .from(tenant).where(eq(tenant.id, tenantId));
  const config = parseValuationConfig((t?.settings as { valuation?: unknown } | null)?.valuation);

  let snaps = await listValuationSnapshots(tenantId, 13);
  if (snaps.length === 0) {
    const now = new Date();
    const periodKey = now.toLocaleDateString("en-CA", { timeZone: t?.timezone ?? "America/Phoenix" }).slice(0, 7);
    await recordValuationSnapshot(tenantId, periodKey, now);
    snaps = await listValuationSnapshots(tenantId, 13);
  }
  const latest = snaps[0]!;

  const prior = snaps.slice(3).find((s) => s.status === "ok" && s.valueLikelyCents != null);
  const quarterDeltaCents = latest.status === "ok" && latest.valueLikelyCents != null && prior
    ? latest.valueLikelyCents - prior.valueLikelyCents!
    : null;

  // Rebuild the engine result shape from the stored row so levers derive from
  // the SAME ledger the page renders (never recomputed from fresher data —
  // the room and its levers always agree).
  const snapResult = {
    status: latest.status as "ok" | "insufficient_data",
    reasons: (latest.reasons as string[] | null) ?? undefined,
    sdeCents: latest.sdeCents,
    bandKey: null,
    baseMultipleLow: 0, baseMultipleHigh: 0,
    adjustments: (latest.adjustments as ValuationSnapshotResult["adjustments"]) ?? [],
    multipleLow: latest.multipleLow ?? 0, multipleHigh: latest.multipleHigh ?? 0,
    valueLowCents: latest.valueLowCents, valueLikelyCents: latest.valueLikelyCents, valueHighCents: latest.valueHighCents,
    inputQuality: (latest.inputQuality as ValuationSnapshotResult["inputQuality"]) ?? { real: 0, estimated: 0, missing: 0, flags: {} },
    methodologyVersion: latest.methodologyVersion,
  } satisfies ValuationSnapshotResult;

  return { latest, quarterDeltaCents, levers: buildValueLevers(snapResult, config), config };
}

/** Compact range for the Today portfolio strip (owner-tier surface). */
export async function getPortfolioValuationLine(): Promise<string | null> {
  const tenantId = await getTenantId();
  const snaps = await listValuationSnapshots(tenantId, 1);
  const s = snaps[0];
  if (!s || s.status !== "ok" || s.valueLowCents == null || s.valueHighCents == null) return null;
  const k = (c: number) => `$${(c / 100_000_000).toFixed(1)}M`;
  return `${k(s.valueLowCents)} – ${k(s.valueHighCents)}`;
}
