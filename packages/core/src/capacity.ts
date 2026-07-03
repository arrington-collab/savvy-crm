import type { SchedulingConfig, Weekday } from "./scheduling";

const WD_OF_INDEX: Record<number, Weekday> = { 0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat" };

/** Total office minutes across the given civil dates (YYYY-MM-DD), using the config's per-weekday hours. */
export function officeMinutesForWindow(config: SchedulingConfig, civilDates: string[]): number {
  let total = 0;
  for (const d of civilDates) {
    const wd = WD_OF_INDEX[new Date(`${d}T00:00:00Z`).getUTCDay()]!;
    const h = config.hours[wd];
    if (h && h.length === 2) total += Math.max(0, h[1]! - h[0]!) * 60;
  }
  return total;
}

/** Count of civil dates (YYYY-MM-DD) that are workdays — i.e. have configured office hours. */
export function countWorkdays(config: SchedulingConfig, civilDates: string[]): number {
  let n = 0;
  for (const d of civilDates) {
    const wd = WD_OF_INDEX[new Date(`${d}T00:00:00Z`).getUTCDay()]!;
    const h = config.hours[wd];
    if (h && h.length === 2 && h[1]! > h[0]!) n += 1;
  }
  return n;
}

/** Minutes of [aStart,aEnd) that fall inside [wStart,wEnd). Never negative. */
export function overlapMinutes(aStart: Date, aEnd: Date, wStart: Date, wEnd: Date): number {
  const start = Math.max(aStart.getTime(), wStart.getTime());
  const end = Math.min(aEnd.getTime(), wEnd.getTime());
  return end > start ? Math.round((end - start) / 60000) : 0;
}

export type RepCapacityInput = { userId: string; name: string; scheduledMin: number; blockedMin: number; apptCount: number };
export type CapacityStatus = "over" | "high" | "ok" | "free";
export type RepCapacity = {
  userId: string; name: string; availableMin: number; scheduledMin: number; apptCount: number; utilizationPct: number; status: CapacityStatus;
};
export type CapacityView = { reps: RepCapacity[]; teamUtilizationPct: number; overCount: number; windowDays: number };

function util(scheduledMin: number, availableMin: number): number {
  if (availableMin > 0) return Math.round((scheduledMin / availableMin) * 100);
  return scheduledMin > 0 ? 100 : 0;
}

function statusOf(pct: number): CapacityStatus {
  if (pct >= 100) return "over";
  if (pct >= 80) return "high";
  return pct > 0 ? "ok" : "free";
}

/** Per-rep utilization (booked vs. available = office − blocked), sorted most-loaded first. */
export function buildCapacityView(input: { officeMinutesInWindow: number; windowDays: number; reps: RepCapacityInput[] }): CapacityView {
  const reps: RepCapacity[] = input.reps.map((r) => {
    const availableMin = Math.max(0, input.officeMinutesInWindow - r.blockedMin);
    const utilizationPct = util(r.scheduledMin, availableMin);
    return { userId: r.userId, name: r.name, availableMin, scheduledMin: r.scheduledMin, apptCount: r.apptCount, utilizationPct, status: statusOf(utilizationPct) };
  });
  reps.sort((a, b) => b.utilizationPct - a.utilizationPct);
  const totalScheduled = reps.reduce((s, r) => s + r.scheduledMin, 0);
  const totalAvailable = reps.reduce((s, r) => s + r.availableMin, 0);
  return {
    reps,
    teamUtilizationPct: util(totalScheduled, totalAvailable),
    overCount: reps.filter((r) => r.status === "over").length,
    windowDays: input.windowDays,
  };
}

export type CrewCapacityInput = { crewId: string; name: string; scheduledMin: number; apptCount: number };
export type CrewCapacity = {
  crewId: string; name: string; availableMin: number; scheduledMin: number; apptCount: number; utilizationPct: number; status: CapacityStatus;
};
export type CrewCapacityView = { crews: CrewCapacity[]; teamUtilizationPct: number; overCount: number; windowDays: number };

/** Per-crew utilization (booked vs. available = office, no per-crew blocks), sorted most-loaded first. */
export function buildCrewCapacityView(input: { officeMinutesInWindow: number; windowDays: number; crews: CrewCapacityInput[] }): CrewCapacityView {
  const crews: CrewCapacity[] = input.crews.map((c) => {
    const availableMin = input.officeMinutesInWindow;
    const utilizationPct = util(c.scheduledMin, availableMin);
    return { crewId: c.crewId, name: c.name, availableMin, scheduledMin: c.scheduledMin, apptCount: c.apptCount, utilizationPct, status: statusOf(utilizationPct) };
  });
  crews.sort((a, b) => b.utilizationPct - a.utilizationPct);
  const totalScheduled = crews.reduce((s, c) => s + c.scheduledMin, 0);
  const totalAvailable = crews.reduce((s, c) => s + c.availableMin, 0);
  return {
    crews,
    teamUtilizationPct: util(totalScheduled, totalAvailable),
    overCount: crews.filter((c) => c.status === "over").length,
    windowDays: input.windowDays,
  };
}
