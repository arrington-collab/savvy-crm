import { PageHeader } from "@/components/cockpit/PageHeader";
import { NewLeadForm } from "./NewLeadForm";

export const dynamic = "force-dynamic";

export default function NewLeadPage() {
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Funnel" title="New Lead" />
      <NewLeadForm />
    </div>
  );
}
