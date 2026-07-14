import { withTenant, tenant, eq } from "@savvy/db";
import { parseWhyUsConfig } from "@savvy/core";
import { getTenantId } from "@/lib/tenant";
import { WhyUsEditor } from "./WhyUsEditor";

export const dynamic = "force-dynamic";

export default async function WhyUsPage() {
  const tenantId = await getTenantId();
  const [t] = await withTenant(tenantId, (tx) =>
    tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId)),
  );
  const cfg = parseWhyUsConfig((t?.settings as { whyUs?: unknown } | null)?.whyUs);
  return <WhyUsEditor initial={cfg} />;
}
