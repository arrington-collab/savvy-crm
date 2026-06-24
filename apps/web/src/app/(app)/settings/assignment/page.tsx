import { getTenantId } from "@/lib/tenant";
import { getSalesReps, getAssignmentConfig } from "@/lib/assignment-queries";
import { LeadAssignmentSettings } from "@/components/LeadAssignmentSettings";
import { isOrgAdmin } from "@/lib/authz";
import { PageHeader } from "@/components/cockpit/PageHeader";

export const dynamic = "force-dynamic";

export default async function AssignmentSettingsPage() {
  if (!(await isOrgAdmin())) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Settings" title="Lead Assignment" />
        <p className="text-sm" style={{ color: "var(--text-faint)" }} data-testid="assignment-forbidden">Admins only.</p>
      </div>
    );
  }
  const tenantId = await getTenantId();
  const [reps, initial] = await Promise.all([getSalesReps(tenantId), getAssignmentConfig(tenantId)]);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Lead Assignment</h1>
        <p className="text-sm text-muted-foreground">Choose how new leads are routed to reps.</p>
      </div>
      <LeadAssignmentSettings reps={reps} initial={initial} />
    </div>
  );
}
