"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import { toggleDripActive } from "@/lib/comms-actions";

export function DripToggle({ dripId, active }: { dripId: string; active: boolean }) {
  const [pending, start] = useTransition();
  return (
    <button
      disabled={pending}
      onClick={() => start(async () => { await toggleDripActive(dripId, !active); toast.success(active ? "Paused" : "Activated"); })}
      className="rounded border px-2 py-1 text-xs disabled:opacity-50"
      data-testid="drip-toggle"
    >
      {active ? "Active" : "Paused"}
    </button>
  );
}
