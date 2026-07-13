const MIN_PAIRS = 20; // below this the report is noise — say so instead of guessing

export type BallparkCalibration =
  | { status: "insufficient"; n: number; report: string }
  | { status: "active"; n: number; hitRate: number; report: string };

/**
 * Monthly calibration: how often the quoted range contained the eventual
 * estimate value (inclusive of the boundaries). Below MIN_PAIRS pairs it
 * reports "insufficient data — n=X" rather than a misleading rate. This is
 * what earns the feature wider autonomy. Pure.
 */
export function computeBallparkCalibration(
  pairs: { lowCents: number; highCents: number; estimateCents: number }[],
): BallparkCalibration {
  const n = pairs.length;
  if (n < MIN_PAIRS) return { status: "insufficient", n, report: `insufficient data — n=${n}` };
  const hits = pairs.filter((p) => p.estimateCents >= p.lowCents && p.estimateCents <= p.highCents).length;
  const hitRate = hits / n;
  return {
    status: "active",
    n,
    hitRate,
    report: `${Math.round(hitRate * 100)}% of quotes landed within range (n=${n})`,
  };
}
