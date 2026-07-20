import { adminDb, tenant, eq } from "@savvy/db";
import { parseBrandConfig, parseMarkets, type BrandConfig, type Market } from "@savvy/core";
import { getTenantId } from "./tenant";

const NO_BRAND: BrandConfig = { name: null, logoUrl: null, logoUrlDark: null, accent: null, theme: null };

/** Load the tenant's chrome settings (settings.brand + settings.markets) in
 *  one fetch. Fail-soft: any error means the default Savvy chrome — branding
 *  must never take the app down. */
export async function loadTenantChrome(): Promise<{ brand: BrandConfig; markets: Market[] }> {
  try {
    const tenantId = await getTenantId();
    const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
    const settings = t?.settings as { brand?: unknown; markets?: unknown } | null;
    return { brand: parseBrandConfig(settings?.brand), markets: parseMarkets(settings?.markets) };
  } catch {
    return { brand: NO_BRAND, markets: [] };
  }
}
