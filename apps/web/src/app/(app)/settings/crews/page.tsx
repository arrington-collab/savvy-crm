import { getTenantId } from "@/lib/tenant";
import { listCrews } from "@savvy/db";
import { listCrewUsers } from "@/lib/crew-admin-actions";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { CrewsManager } from "./CrewsManager";

export const dynamic = "force-dynamic";

export default async function CrewsSettingsPage() {
  const tenantId = await getTenantId();
  const [allCrews, crewUsers] = await Promise.all([listCrews(tenantId), listCrewUsers()]);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Settings" title="Install crews" />
      <CrewsManager initialCrews={allCrews} crewUsers={crewUsers} />
    </div>
  );
}
