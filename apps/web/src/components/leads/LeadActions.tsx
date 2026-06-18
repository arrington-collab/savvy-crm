"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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

  function doLost() {
    start(async () => {
      const r = await markLeadLost(leadId);
      if ("error" in r) return void toast.error(r.error);
      toast.success("Marked lost");
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
      <Button variant="outline" onClick={doLost} disabled={pending} data-testid="mark-lost">
        Mark lost
      </Button>
    </div>
  );
}
