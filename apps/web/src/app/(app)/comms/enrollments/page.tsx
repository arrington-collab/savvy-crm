import { listEnrollments } from "@/lib/comms-queries";
import { Card } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function EnrollmentsPage() {
  const rows = await listEnrollments();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Enrollments</h1>
      <div className="space-y-2">
        {rows.map((r) => (
          <Card key={r.id} className="flex items-center justify-between p-3" data-testid="enrollment-row">
            <div>
              <div className="font-medium">{r.customerName} · {r.dripName}</div>
              <div className="text-xs text-muted-foreground">
                step {r.currentStep} · {r.status}{r.stoppedReason ? ` (${r.stoppedReason})` : ""}
              </div>
            </div>
          </Card>
        ))}
        {rows.length === 0 && <p className="text-sm text-muted-foreground">No enrollments yet.</p>}
      </div>
    </div>
  );
}
