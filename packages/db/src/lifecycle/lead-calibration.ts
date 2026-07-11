import { withTenant } from "../tenant";
import { lead } from "../schema/crm";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { CalibrationInput, LeadOutcome, ScoreBand } from "@savvy/core";

// Outcomes that count as "resolved" for calibration: a lead that reached a booked
// appointment, was won, or was lost (its status IS the outcome). Leads still in
// new/contacted/qualified haven't resolved yet and are excluded.
const RESOLVED_STATUSES = ["booked", "won", "lost"] as const;
const VALID_BANDS = new Set<ScoreBand>(["hot", "warm", "cool", "cold"]);

/**
 * Resolved leads (band + outcome) for the slice-5 calibration report. Only leads
 * that carry a score band and reached a booked/won/lost outcome are returned.
 */
export async function getCalibrationInputs(tenantId: string): Promise<CalibrationInput[]> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select({ band: lead.scoreBand, status: lead.status })
      .from(lead)
      .where(
        and(
          eq(lead.tenantId, tenantId),
          inArray(lead.status, [...RESOLVED_STATUSES]),
          isNotNull(lead.scoreBand),
        ),
      ),
  );
  return rows
    .filter((r): r is { band: ScoreBand; status: LeadOutcome } => VALID_BANDS.has(r.band as ScoreBand))
    .map((r) => ({ band: r.band, outcome: r.status }));
}
