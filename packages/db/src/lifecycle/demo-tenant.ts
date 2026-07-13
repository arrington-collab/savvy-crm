import { eq } from "drizzle-orm";
import { adminDb } from "../admin-client";
import { tenant } from "../schema/tenancy";

// Short-lived cache: comms resolvers call this on every send; a demo flag never
// changes mid-process. Cleared implicitly by process restart (seeder is a script).
const cache = new Map<string, boolean>();

/** True when the tenant is flagged demo=true (comms hard-muted). Fail-safe: on any
 *  error returns false so a DB hiccup never silently mutes a real tenant's comms. */
export async function isDemoTenant(tenantId: string): Promise<boolean> {
  const hit = cache.get(tenantId);
  if (hit !== undefined) return hit;
  try {
    const [row] = await adminDb.select({ demo: tenant.demo }).from(tenant).where(eq(tenant.id, tenantId));
    const val = row?.demo ?? false;
    cache.set(tenantId, val);
    return val;
  } catch {
    return false;
  }
}

/** Test hook: clear the memoized flags. */
export function __clearDemoTenantCache(): void {
  cache.clear();
}
