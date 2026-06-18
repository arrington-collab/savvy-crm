import { listTeam } from "@/lib/team-queries";
import { isOrgAdmin } from "@/lib/authz";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { TeamManager } from "./TeamManager";

export const dynamic = "force-dynamic";

export default async function TeamSettingsPage() {
  if (!(await isOrgAdmin())) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Settings" title="Team" />
        <p className="text-sm" style={{ color: "var(--text-faint)" }} data-testid="team-forbidden">Admins only.</p>
      </div>
    );
  }
  const team = await listTeam();
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Settings" title="Team" />
      <TeamManager team={team} />
    </div>
  );
}
