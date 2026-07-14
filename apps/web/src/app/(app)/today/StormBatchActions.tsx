"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { approveStormBatch, dismissStormBatch } from "./storm-batch-actions";

export function StormBatchActions({ batchId, status }: { batchId: string; status: string }) {
  const [pending, startTransition] = useTransition();
  if (status === "approved") {
    return <p className="mt-3 text-xs font-medium" style={{ color: "var(--text-muted)" }}>Approved — outreach sending…</p>;
  }
  return (
    <div className="mt-3 flex gap-2">
      <Button size="sm" disabled={pending} data-testid="storm-batch-approve"
        onClick={() => startTransition(async () => { await approveStormBatch(batchId); })}>
        Approve outreach
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} data-testid="storm-batch-dismiss"
        onClick={() => startTransition(async () => { await dismissStormBatch(batchId); })}>
        Dismiss
      </Button>
    </div>
  );
}
