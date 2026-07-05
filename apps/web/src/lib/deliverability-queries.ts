import "server-only";
import { getA2pRegistration } from "@savvy/db";
import { getTenantId } from "./tenant";

export async function getDeliverabilityStatus() {
  const tenantId = await getTenantId();
  return getA2pRegistration(tenantId); // { registered, state, connectionActive }
}
