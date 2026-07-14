"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { confirmMoveAction, dismissMoveAction } from "./move-actions";

export function MoveVerificationActions({ moveEventId, newAddress }: { moveEventId: string; newAddress: string | null }) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="mt-3 flex gap-2">
      <Button size="sm" disabled={pending} data-testid="move-confirm"
        onClick={() => startTransition(async () => { await confirmMoveAction(moveEventId, newAddress ?? undefined); })}>
        Yes, they moved
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} data-testid="move-dismiss"
        onClick={() => startTransition(async () => { await dismissMoveAction(moveEventId); })}>
        No / not sure
      </Button>
    </div>
  );
}
