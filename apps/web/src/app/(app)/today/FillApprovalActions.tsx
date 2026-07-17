"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { approveFillPlayAction } from "@/lib/fill-actions";

export function FillApprovalActions({ playId }: { playId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="mt-3 flex gap-2">
      <Button size="sm" disabled={pending} data-testid="fill-approve"
        onClick={() => startTransition(async () => { await approveFillPlayAction(playId); })}>
        Approve offer
      </Button>
    </div>
  );
}
