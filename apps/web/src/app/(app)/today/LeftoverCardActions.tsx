"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { logLeftoverAction, confirmNoLeftoversAction } from "@/lib/materials-actions";

export function LeftoverCardActions({ jobId, items }: { jobId: string; items: { key: string; name: string }[] }) {
  const [pending, startTransition] = useTransition();
  const [itemKey, setItemKey] = useState(items[0]?.key ?? "");
  const [qty, setQty] = useState("");

  function log() {
    startTransition(async () => {
      const r = await logLeftoverAction({ jobId, itemKey, quantity: Number(qty) });
      if ("error" in r) { toast.error(r.error); return; }
      toast.success("Leftover logged — returnables queued for credit");
      setQty("");
    });
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <select className="h-8 rounded-md border bg-transparent px-2 text-xs" value={itemKey}
              onChange={(e) => setItemKey(e.target.value)} data-testid="leftover-item">
        {items.map((i) => <option key={i.key} value={i.key}>{i.name}</option>)}
      </select>
      <Input type="number" inputMode="decimal" placeholder="qty" className="h-8 w-20 text-xs"
             value={qty} onChange={(e) => setQty(e.target.value)} data-testid="leftover-qty" />
      <Button size="sm" disabled={pending || !qty || !itemKey} data-testid="leftover-log" onClick={log}>
        Log leftover
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} data-testid="leftover-none"
        onClick={() => startTransition(async () => { await confirmNoLeftoversAction(jobId); })}>
        Nothing left over
      </Button>
    </div>
  );
}
