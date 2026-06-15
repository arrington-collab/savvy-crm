import { adminDb, tenant, eq } from "@savvy/db";
import { parseSchedulingConfig } from "@savvy/core";
import { getTenantId } from "@/lib/tenant";
import { SchedulingSettingsForm } from "./SchedulingSettingsForm";

export const dynamic = "force-dynamic";

export default async function SchedulingSettingsPage() {
  const tenantId = await getTenantId();
  // Read via adminDb: tenant table is the RLS isolation root; savvy_app lacks grants on it.
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
  const raw = (t?.settings as { scheduling?: unknown } | null)?.scheduling;
  const config = parseSchedulingConfig(raw);

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Scheduling Settings</h1>
      <SchedulingSettingsForm config={config} />
    </div>
  );
}
