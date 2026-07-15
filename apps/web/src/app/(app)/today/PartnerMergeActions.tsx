"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { resolveMergeCandidateAction } from "@/lib/partner-actions";

export function PartnerMergeActions({ candidateId }: { candidateId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="mt-3 flex gap-2">
      <Button size="sm" disabled={pending} data-testid="partner-merge-confirm"
        onClick={() => startTransition(async () => { await resolveMergeCandidateAction(candidateId, "merge"); })}>
        Same person — merge
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} data-testid="partner-merge-keep"
        onClick={() => startTransition(async () => { await resolveMergeCandidateAction(candidateId, "keep_separate"); })}>
        Different people — keep both
      </Button>
    </div>
  );
}
