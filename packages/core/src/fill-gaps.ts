import type { SchedulingConfig, Weekday } from "./scheduling";

// Phase 26 slice 5 — pure crew-gap detection over the capacity look-ahead
// window. A gap is a contiguous run of under-utilized workdays for one crew;
// non-workdays neither create nor split gaps. A crew with no appointments at
// all must surface as a gap — an idle crew is the loudest signal.

const WD_OF_INDEX: Record<number, Weekday> = { 0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat" };

export interface CrewDayLoad {
  crewId: string;
  name: string;
  civilDate: string;
  scheduledMin: number;
}

export interface CrewGapWindow {
  crewId: string;
  name: string;
  /** Civil dates (YYYY-MM-DD), inclusive, in the tenant's timezone. */
  gapStart: string;
  gapEnd: string;
  freeMinutes: number;
}

function dayOfficeMinutes(config: SchedulingConfig, civilDate: string): number {
  const wd = WD_OF_INDEX[new Date(`${civilDate}T00:00:00Z`).getUTCDay()]!;
  const h = config.hours[wd];
  return h && h.length === 2 ? Math.max(0, h[1]! - h[0]!) * 60 : 0;
}

export function detectCrewGapWindows(input: {
  config: SchedulingConfig;
  civilDates: string[];
  crews: { crewId: string; name: string }[];
  loads: CrewDayLoad[];
  minUtilizationPct: number;
}): CrewGapWindow[] {
  const loadByCrewDay = new Map<string, number>();
  for (const l of input.loads) loadByCrewDay.set(`${l.crewId}:${l.civilDate}`, l.scheduledMin);

  const gaps: CrewGapWindow[] = [];
  for (const crew of input.crews) {
    let open: CrewGapWindow | null = null;
    for (const d of input.civilDates) {
      const officeMin = dayOfficeMinutes(input.config, d);
      if (officeMin <= 0) continue; // non-workday: no gap contribution, no split
      const scheduledMin = loadByCrewDay.get(`${crew.crewId}:${d}`) ?? 0;
      const underUtilized = (scheduledMin / officeMin) * 100 < input.minUtilizationPct;
      if (underUtilized) {
        const freeMin = officeMin - scheduledMin;
        if (open) {
          open.gapEnd = d;
          open.freeMinutes += freeMin;
        } else {
          open = { crewId: crew.crewId, name: crew.name, gapStart: d, gapEnd: d, freeMinutes: freeMin };
        }
      } else if (open) {
        gaps.push(open);
        open = null;
      }
    }
    if (open) gaps.push(open);
  }
  return gaps;
}
