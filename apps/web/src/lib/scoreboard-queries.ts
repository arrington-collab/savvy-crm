import "server-only";
import { getTenantRollup } from "@savvy/db";
import { getTenantId } from "./tenant";

/** Page-facing wrapper: the active tenant's Coverage Map snapshot (null pre-first-sweep). */
export async function loadTenantRollup() {
  return getTenantRollup(await getTenantId());
}
