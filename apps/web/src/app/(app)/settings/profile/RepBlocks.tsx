"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { addMyBlock, removeMyBlock } from "@/lib/profile-actions";

export type RepBlockView = { id: string; startsAt: string; endsAt: string; reason: string | null };

const fmt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function RepBlocks({ blocks }: { blocks: RepBlockView[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [startVal, setStartVal] = useState("");
  const [endVal, setEndVal] = useState("");
  const [reason, setReason] = useState("");

  function add() {
    if (!startVal || !endVal) { toast.error("Pick a start and end time"); return; }
    start(async () => {
      // datetime-local is the rep's wall-clock time; convert via the browser tz to an ISO instant.
      const r = await addMyBlock({ startsAt: new Date(startVal).toISOString(), endsAt: new Date(endVal).toISOString(), reason });
      if ("error" in r) { toast.error(r.error); return; }
      toast.success("Time blocked");
      setStartVal(""); setEndVal(""); setReason("");
      router.refresh();
    });
  }

  function remove(id: string) {
    start(async () => {
      const r = await removeMyBlock(id);
      if ("error" in r) { toast.error(r.error); return; }
      toast.success("Block removed");
      router.refresh();
    });
  }

  return (
    <Card className="p-4">
      <div className="eyebrow mb-2">Block time</div>
      <p className="mb-3 text-sm" style={{ color: "var(--text-muted)" }}>
        Carve out time you&apos;re unavailable — it won&apos;t be offered as an inspection slot.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="block-start">From</Label>
          <Input id="block-start" type="datetime-local" data-testid="block-start" value={startVal} onChange={(e) => setStartVal(e.target.value)} className="w-52" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="block-end">To</Label>
          <Input id="block-end" type="datetime-local" data-testid="block-end" value={endVal} onChange={(e) => setEndVal(e.target.value)} className="w-52" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="block-reason">Reason (optional)</Label>
          <Input id="block-reason" data-testid="block-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Dentist" className="w-40" />
        </div>
        <Button disabled={pending} data-testid="block-add" onClick={add}>Block time</Button>
      </div>

      {blocks.length > 0 && (
        <div className="mt-4 divide-y divide-white/5" data-testid="block-list">
          {blocks.map((b) => (
            <div key={b.id} className="flex items-center gap-3 py-2" data-testid="block-row">
              <div className="min-w-0 flex-1 text-sm">
                {fmt(b.startsAt)} – {fmt(b.endsAt)}
                {b.reason ? <span style={{ color: "var(--text-muted)" }}> · {b.reason}</span> : null}
              </div>
              <Button variant="outline" disabled={pending} data-testid="block-remove" onClick={() => remove(b.id)}>Remove</Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
