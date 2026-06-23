import { getCustomLeadSources } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { NewLeadForm } from "./NewLeadForm";

export const dynamic = "force-dynamic";

export default async function NewLeadPage() {
  const tenantId = await getTenantId();
  const initialCustomSources = await getCustomLeadSources(tenantId);
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Funnel" title="New Lead" />
      <NewLeadForm initialCustomSources={initialCustomSources} />
    </div>
  );
}
