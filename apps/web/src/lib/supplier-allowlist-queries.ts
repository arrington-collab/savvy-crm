import "server-only";
import { listSupplierAllowlist } from "@savvy/db";
import { getTenantId } from "./tenant";

export async function getSupplierAllowlist() {
  const tenantId = await getTenantId();
  return listSupplierAllowlist(tenantId);
}
