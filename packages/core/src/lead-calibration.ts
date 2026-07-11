import type { ScoreBand } from "./lead-scoring";

/**
 * Slice 5 calibration report (no ML): a monthly artifact comparing score bands to
 * actual resolved outcomes so a tenant can see whether the score predicts reality.
 * Below the resolved-lead threshold it reports "insufficient data — n=X" instead of
 * publishing noise. The per-tenant monthly cron feeds resolved leads in; the shape
 * that consumes/surfaces it (digest) reads this pure output.
 */
export const CALIBRATION_MIN_RESOLVED = 50;

export type LeadOutcome = "booked" | "won" | "lost";
export type CalibrationInput = { band: ScoreBand; outcome: LeadOutcome };
export type BandCalibration = { booked: number; won: number; lost: number; total: number; wonRate: number };

export type CalibrationReport =
  | { status: "insufficient"; n: number; message: string }
  | { status: "active"; n: number; bands: Record<ScoreBand, BandCalibration> };

const emptyBand = (): BandCalibration => ({ booked: 0, won: 0, lost: 0, total: 0, wonRate: 0 });

export function computeCalibration(leads: CalibrationInput[]): CalibrationReport {
  const n = leads.length;
  if (n < CALIBRATION_MIN_RESOLVED) {
    return { status: "insufficient", n, message: `insufficient data — n=${n}` };
  }
  const bands: Record<ScoreBand, BandCalibration> = {
    hot: emptyBand(), warm: emptyBand(), cool: emptyBand(), cold: emptyBand(),
  };
  for (const l of leads) {
    const b = bands[l.band];
    b[l.outcome] += 1;
    b.total += 1;
  }
  for (const b of Object.values(bands)) b.wonRate = b.total ? b.won / b.total : 0;
  return { status: "active", n, bands };
}

const BAND_LABEL: Record<ScoreBand, string> = { hot: "Hot", warm: "Warm", cool: "Cool", cold: "Cold" };

/** One-line digest summary of an active calibration report, or null while insufficient. */
export function buildCalibrationLine(report: CalibrationReport): string | null {
  if (report.status !== "active") return null;
  const parts = (Object.entries(report.bands) as [ScoreBand, BandCalibration][])
    .filter(([, b]) => b.total > 0)
    .map(([band, b]) => `${BAND_LABEL[band]} ${Math.round(b.wonRate * 100)}%`);
  return `Lead-score calibration (n=${report.n}): ${parts.join(" · ")} won-rate`;
}
