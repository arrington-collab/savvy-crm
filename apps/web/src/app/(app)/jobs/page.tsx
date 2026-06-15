import { getBoard, getStageVelocity } from "@/lib/pipeline-queries";
import { Board } from "./board";
import { Card } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const [board, velocity] = await Promise.all([getBoard(), getStageVelocity()]);
  const activeStages = [
    "lead",
    "inspected",
    "estimate",
    "approved",
    "production",
    "closeout",
    "billing",
    "complete",
  ] as const;
  const total = activeStages.reduce((n, s) => n + (board[s]?.length ?? 0), 0);
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Pipeline</h1>
        <div className="text-sm text-muted-foreground">{total} active jobs</div>
      </div>
      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-4"
        data-testid="velocity"
      >
        {activeStages.slice(0, 4).map((s) => (
          <Card key={s} className="p-3">
            <div className="text-xs capitalize text-muted-foreground">
              {s} · avg days
            </div>
            <div className="text-xl font-semibold">{velocity[s] ?? "—"}</div>
          </Card>
        ))}
      </div>
      <Board initialBoard={board} />
    </div>
  );
}
