import "server-only";
import { listRunningRuns } from "@savvy/db";
import { shapeInflight, SHOWCASE, type InflightMap } from "@savvy/core";
import { getTenantId } from "./tenant";

/** Tenant-scoped in-flight dots (running agent runs) for the command center poll. */
export async function loadInflight(): Promise<InflightMap> {
  const rows = await listRunningRuns(await getTenantId());
  return shapeInflight(rows, new Date(), SHOWCASE.SPINNER_MAX_SECONDS);
}
