import { listDrips } from "@/lib/comms-queries";
import { Card } from "@/components/ui/card";
import { DripToggle } from "./drip-toggle";
import type { DripStep } from "@savvy/core";

export const dynamic = "force-dynamic";

export default async function DripsPage() {
  const drips = await listDrips();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Drips</h1>
      <div className="space-y-2">
        {drips.map((d) => (
          <Card key={d.id} className="p-3" data-testid="drip-row">
            <div className="flex items-center justify-between">
              <div className="font-medium">{d.name} <code className="text-xs text-muted-foreground">{d.key}</code></div>
              <DripToggle dripId={d.id} active={d.active} />
            </div>
            <ol className="mt-1 text-sm text-muted-foreground">
              {(d.steps as DripStep[]).map((s) => (
                <li key={s.stepNum}>#{s.stepNum} · +{s.delayHours}h · {s.channel} · {s.templateKey ?? "AI"}</li>
              ))}
            </ol>
          </Card>
        ))}
        {drips.length === 0 && <p className="text-sm text-muted-foreground">No drips yet.</p>}
      </div>
    </div>
  );
}
