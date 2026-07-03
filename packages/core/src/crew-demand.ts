export type CrewDemandAssessment = {
  pendingInstalls: number;
  crewCount: number;
  buildCapacity: number;
  recommendAnotherCrew: boolean;
  suggestedCrews: number;
};

/**
 * "You need another crew" (§K): close the sales↔ops loop by comparing install demand to
 * build capacity over the window. Capacity = one full-day install per crew per workday, so
 * `crewCount × workdaysInWindow`. Demand = `pendingInstalls` (approved/production jobs with no
 * scheduled crew install). When demand outruns capacity, recommend hiring, sized to the deficit.
 */
export function assessCrewDemand(input: {
  pendingInstalls: number;
  crewCount: number;
  workdaysInWindow: number;
}): CrewDemandAssessment {
  const buildCapacity = Math.max(0, input.crewCount) * Math.max(0, input.workdaysInWindow);
  const deficit = Math.max(0, input.pendingInstalls - buildCapacity);
  const perCrew = Math.max(1, input.workdaysInWindow); // installs one crew clears in the window
  const suggestedCrews = deficit > 0 ? Math.ceil(deficit / perCrew) : 0;
  return {
    pendingInstalls: input.pendingInstalls,
    crewCount: input.crewCount,
    buildCapacity,
    recommendAnotherCrew: deficit > 0,
    suggestedCrews,
  };
}
