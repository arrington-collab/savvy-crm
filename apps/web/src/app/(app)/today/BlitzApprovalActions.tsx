"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { approveBlitzAction } from "@/lib/blitz-actions";

export function BlitzApprovalActions({ campaignId }: { campaignId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="mt-3 flex gap-2">
      <Button size="sm" disabled={pending} data-testid="blitz-approve"
        onClick={() => startTransition(async () => { await approveBlitzAction(campaignId); })}>
        Approve blitz
      </Button>
    </div>
  );
}
