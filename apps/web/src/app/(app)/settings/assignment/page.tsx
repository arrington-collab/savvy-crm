import { getTenantId } from "@/lib/tenant";
import { getSalesReps, getAssignmentConfig } from "@/lib/assignment-queries";
import { LeadAssignmentSettings } from "@/components/LeadAssignmentSettings";

export const dynamic = "force-dynamic";

export default async function AssignmentSettingsPage() {
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
