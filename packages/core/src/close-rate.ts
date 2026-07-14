// Estimate Experience slice 7: the close-rate loop — sent/opened/accepted by
// template version and tier, plus the video personalized-vs-generic split
// (the 10% hypothesis, measured). Same honesty pattern as scoring/ballpark
// calibration: a version's rates only activate at n≥20; below that the report
// says "insufficient data — n=X" instead of pretending.

export interface CloseRateRow {
  templateVersion: string;
  tier: string | null;
  opened: boolean;
  accepted: boolean;
  videoPersonalized: boolean | null;
}

const ACTIVATION_N = 20;
const rate = (num: number, den: number): number => Math.round((num / den) * 10_000);

export interface VersionStats {
  version: string;
  n: number;
  active: boolean;
  openRateBps: number | null;
  closeRateBps: number | null;
}

export interface SplitStats {
  n: number;
  closeRateBps: number | null;
}

export function closeRateReport(rows: CloseRateRow[]): {
  versions: VersionStats[];
  tiers: { tier: string; n: number; closeRateBps: number | null }[];
  video: { personalized: SplitStats | null; generic: SplitStats | null };
} {
  const byVersion = new Map<string, CloseRateRow[]>();
  for (const r of rows) {
    byVersion.set(r.templateVersion, [...(byVersion.get(r.templateVersion) ?? []), r]);
  }
  const versions: VersionStats[] = [...byVersion.entries()].map(([version, vs]) => {
    const active = vs.length >= ACTIVATION_N;
    return {
      version,
      n: vs.length,
      active,
      openRateBps: active ? rate(vs.filter((r) => r.opened).length, vs.length) : null,
      closeRateBps: active ? rate(vs.filter((r) => r.accepted).length, vs.length) : null,
    };
  });

  const byTier = new Map<string, CloseRateRow[]>();
  for (const r of rows) {
    if (!r.tier) continue;
    byTier.set(r.tier, [...(byTier.get(r.tier) ?? []), r]);
  }
  const tiers = [...byTier.entries()].map(([tier, ts]) => ({
    tier,
    n: ts.length,
    closeRateBps: ts.length >= ACTIVATION_N ? rate(ts.filter((r) => r.accepted).length, ts.length) : null,
  }));

  const split = (want: boolean): SplitStats | null => {
    const vs = rows.filter((r) => r.videoPersonalized === want);
    if (vs.length === 0) return null;
    return {
      n: vs.length,
      closeRateBps: vs.length >= ACTIVATION_N ? rate(vs.filter((r) => r.accepted).length, vs.length) : null,
    };
  };

  return { versions, tiers, video: { personalized: split(true), generic: split(false) } };
}
