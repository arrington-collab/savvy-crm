"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { convertLead, assignLeadOwner, markLeadLost } from "@/lib/lead-actions";

type U = { id: string; name: string };

export function LeadActions({
  leadId,
  status,
  users,
  ownerId,
}: {
  leadId: string;
  status: string;
  users: U[];
  ownerId: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [owner, setOwner] = useState(ownerId ?? "");

  const terminal = status === "won" || status === "lost";
  const canConvert = !terminal && status !== "booked";
  const canLose = !terminal && status !== "booked";

  function doConvert() {
    start(async () => {
      const r = await convertLead(leadId);
      if ("error" in r) return void toast.error(r.error);
      toast.success("Converted to job");
      router.push(`/jobs/${r.jobId}`);
    });
  }

  function doAssign(userId: string) {
    setOwner(userId);
    start(async () => {
      const r = await assignLeadOwner(leadId, userId === "" ? null : userId);
      if ("error" in r) return void toast.error(r.error);
      toast.success("Owner updated");
      router.refresh();
    });
  }

  // Phase 26 slice 4: the lost flow's OPTIONAL 10-second price-intel capture.
  // Skipping is always one click — intel never blocks closing the lead.
  const [losing, setLosing] = useState(false);
  const [lostReason, setLostReason] = useState("");
  const [compBid, setCompBid] = useState("");
  const [compName, setCompName] = useState("");

  function doLost() {
    start(async () => {
      const r = await markLeadLost(leadId, {
        reason: (lostReason || undefined) as "price" | "timing" | "went_dark" | "not_interested" | "other" | undefined,
        competitorBidCents: lostReason === "price" && compBid ? Math.round(Number(compBid) * 100) : undefined,
        competitorName: lostReason === "price" && compName.trim() ? compName.trim() : undefined,
      });
      if ("error" in r) return void toast.error(r.error);
      toast.success("Marked lost");
      setLosing(false);
      router.refresh();
    });
  }

  if (terminal) {
    return (
      <p className="text-sm" style={{ color: "var(--text-faint)" }} data-testid="lead-actions-readonly">
        No actions — this lead is {status}.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="lead-actions">
      {canConvert && (
        <Button onClick={doConvert} disabled={pending} data-testid="convert-lead">
          Convert to Job
        </Button>
      )}
      <select
        value={owner}
        onChange={(e) => doAssign(e.target.value)}
        disabled={pending}
        data-testid="assign-owner"
        className="mono rounded-md border border-white/10 bg-transparent px-2 py-1.5 text-sm"
        style={{ color: "var(--text-body)" }}
      >
        <option value="">Unassigned</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
      {canLose && !losing && (
        <Button variant="outline" onClick={() => setLosing(true)} disabled={pending} data-testid="mark-lost">
          Mark lost
        </Button>
      )}
      {canLose && losing && (
        <span className="flex flex-wrap items-center gap-2" data-testid="lost-intel">
          <select value={lostReason} onChange={(e) => setLostReason(e.target.value)} disabled={pending}
                  className="mono rounded-md border border-white/10 bg-transparent px-2 py-1.5 text-sm"
                  style={{ color: "var(--text-body)" }} data-testid="lost-reason">
            <option value="">Why? (optional)</option>
            <option value="price">Price</option>
            <option value="timing">Timing</option>
            <option value="went_dark">Went dark</option>
            <option value="not_interested">Not interested</option>
            <option value="other">Other</option>
          </select>
          {lostReason === "price" && (
            <>
              <Input type="number" inputMode="decimal" placeholder="their bid $" className="h-8 w-28 text-xs"
                     value={compBid} onChange={(e) => setCompBid(e.target.value)} data-testid="lost-competitor-bid" />
              <Input placeholder="competitor (optional)" className="h-8 w-40 text-xs"
                     value={compName} onChange={(e) => setCompName(e.target.value)} data-testid="lost-competitor-name" />
            </>
          )}
          <Button variant="outline" size="sm" onClick={doLost} disabled={pending} data-testid="confirm-lost">
            Confirm lost
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setLosing(false)} disabled={pending}>Cancel</Button>
        </span>
      )}
    </div>
  );
}
