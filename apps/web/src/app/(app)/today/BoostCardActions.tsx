"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { resolveBoostCardAction } from "@/lib/blitz-actions";

export function BoostCardActions({ boostCardId }: { boostCardId: string }) {
  const [pending, startTransition] = useTransition();
  const act = (outcome: "boosted" | "skipped") =>
    startTransition(async () => { await resolveBoostCardAction(boostCardId, outcome); });
  return (
    <div className="mt-3 flex gap-2">
      <Button size="sm" disabled={pending} data-testid="boost-mark-boosted" onClick={() => act("boosted")}>
        Posted it
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} data-testid="boost-skip" onClick={() => act("skipped")}>
        Skip
      </Button>
    </div>
  );
}
