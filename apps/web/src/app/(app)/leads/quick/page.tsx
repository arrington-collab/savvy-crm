import { PageHeader } from "@/components/cockpit/PageHeader";
import { listReps } from "@/lib/intake-schedule";
import { QuickBook } from "./QuickBook";

export const dynamic = "force-dynamic";

export default async function QuickBookPage() {
  const reps = await listReps();
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Leads" title="New call — book it now" />
      <QuickBook reps={reps} />
    </div>
  );
}
