import { adminDb, tenant, eq } from "@savvy/db";
import { parseBrandConfig, type BrandConfig } from "@savvy/core";
import { getTenantId } from "./tenant";

/** Load the tenant's brand (settings.brand). Fail-soft: any error means the
 *  default Savvy chrome — branding must never take the app down. */
export async function loadTenantBrand(): Promise<BrandConfig> {
  try {
    const tenantId = await getTenantId();
    const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
    return parseBrandConfig((t?.settings as { brand?: unknown } | null)?.brand);
  } catch {
    return { name: null, logoUrl: null, accent: null, theme: null };
  }
}
