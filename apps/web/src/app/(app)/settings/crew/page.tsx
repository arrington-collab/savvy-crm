import { listCrewUsers } from "@/lib/crew-admin-actions";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { CrewPinManager } from "./CrewPinManager";

export const dynamic = "force-dynamic";

export default async function CrewSettingsPage() {
  const crew = await listCrewUsers();
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Settings" title="Crew PINs" />
      <CrewPinManager crew={crew} />
    </div>
  );
}
