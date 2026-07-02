/**
 * Portfolio coverage from a tenant_ops_rollup snapshot — the "empire coverage"
 * metric (full-auto tasks proven green out of the whole task list). Pure so the
 * display math is unit-tested; the Coverage Map card just renders this. Mirrors
 * summarizeAgentCoverage. `founderMinutes30d` is already coerced to a number by
 * the reader (the column is numeric/string in the DB).
 */
export type TenantRollupLite = {
  fullAutoGreen: number;
  totalTasks: number;
  greenCount: number;
  amberCount: number;
  redCount: number;
  openExceptionCount: number;
  jobs30d: number;
  founderMinutes30d: number;
  computedAt: Date;
} | null;

export type TenantCoverage = {
  hasData: boolean; // false until the first nightly sweep writes a rollup
  coveragePct: number; // fullAutoGreen / totalTasks, 0-100
  fullAutoGreen: number;
  totalTasks: number;
  green: number;
  amber: number;
  red: number;
  gray: number; // the rest of the task list: no binding / unproven
  openExceptions: number;
  jobs30d: number;
  founderMinutes30d: number;
  computedAt: Date | null;
};

export function summarizeTenantCoverage(rollup: TenantRollupLite): TenantCoverage {
  if (!rollup || rollup.totalTasks === 0) {
    return {
      hasData: false, coveragePct: 0,
      fullAutoGreen: rollup?.fullAutoGreen ?? 0, totalTasks: rollup?.totalTasks ?? 0,
      green: rollup?.greenCount ?? 0, amber: rollup?.amberCount ?? 0, red: rollup?.redCount ?? 0, gray: 0,
      openExceptions: rollup?.openExceptionCount ?? 0, jobs30d: rollup?.jobs30d ?? 0,
      founderMinutes30d: rollup?.founderMinutes30d ?? 0, computedAt: rollup?.computedAt ?? null,
    };
  }
  const gray = Math.max(0, rollup.totalTasks - rollup.greenCount - rollup.amberCount - rollup.redCount);
  return {
    hasData: true,
    coveragePct: Math.round((rollup.fullAutoGreen / rollup.totalTasks) * 100),
    fullAutoGreen: rollup.fullAutoGreen, totalTasks: rollup.totalTasks,
    green: rollup.greenCount, amber: rollup.amberCount, red: rollup.redCount, gray,
    openExceptions: rollup.openExceptionCount, jobs30d: rollup.jobs30d,
    founderMinutes30d: rollup.founderMinutes30d, computedAt: rollup.computedAt,
  };
}
