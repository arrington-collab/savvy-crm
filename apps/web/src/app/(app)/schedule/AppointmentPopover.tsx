"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import type { ScheduleAppt } from "@savvy/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/cockpit/StatusBadge";
import { cancelAction, markStatusAction, rescheduleAction } from "@/lib/scheduling-actions";

export function AppointmentPopover({ appt, onClose }: { appt: ScheduleAppt; onClose: () => void }) {
  const [pending, start] = useTransition();
  const [showReschedule, setShowReschedule] = useState(false);
  const [rescheduleVal, setRescheduleVal] = useState("");
  const [slotTaken, setSlotTaken] = useState(false);
  const isActive = appt.status === "scheduled";
  const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: true });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.4)" }} onClick={onClose}>
      <div data-testid="appt-popover" onClick={(e) => e.stopPropagation()} className="w-full max-w-sm space-y-3 rounded-xl p-4"
        style={{ background: "var(--surface-app)", border: "1px solid var(--border-panel)" }}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-medium" style={{ color: "var(--text-primary)" }}>{appt.customerName ?? "Appointment"}</div>
            <div className="mono text-xs" style={{ color: "var(--text-muted)" }}>{appt.type} · {fmt(appt.startsAt)} – {fmt(appt.endsAt)}</div>
            {appt.address ? <div className="text-xs" style={{ color: "var(--text-faint)" }}>{appt.address}</div> : null}
            {appt.assigneeName ? <div className="text-xs" style={{ color: "var(--text-faint)" }}>Crew: {appt.assigneeName}</div> : null}
          </div>
          <StatusBadge status={appt.status ?? "unknown"} />
        </div>

        {isActive ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { await markStatusAction(appt.id, "done"); toast.success("Marked done"); onClose(); })}>Done</Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { await markStatusAction(appt.id, "no_show"); toast.success("No-show"); onClose(); })}>No-show</Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => { setShowReschedule((v) => !v); setSlotTaken(false); }}>Reschedule</Button>
            <Button size="sm" variant="outline" disabled={pending} className="text-destructive hover:text-destructive" onClick={() => start(async () => { await cancelAction(appt.id); toast.success("Canceled"); onClose(); })}>Cancel</Button>
          </div>
        ) : null}

        {isActive && showReschedule ? (
          <div className="space-y-1.5">
            <div className="flex gap-2">
              <Input type="datetime-local" value={rescheduleVal} disabled={pending} className="text-sm"
                onChange={(e) => { setRescheduleVal(e.target.value); setSlotTaken(false); }} />
              <Button size="sm" disabled={pending || !rescheduleVal} onClick={() => start(async () => {
                const s = new Date(rescheduleVal); const e = new Date(s.getTime() + 60 * 60 * 1000);
                const r = await rescheduleAction(appt.id, s.toISOString(), e.toISOString());
                if ("error" in r) { setSlotTaken(true); return; }
                toast.success("Rescheduled"); onClose();
              })}>Save</Button>
            </div>
            {slotTaken ? <p className="text-xs text-destructive">That time is already taken — choose another.</p> : null}
          </div>
        ) : null}

        <div className="flex items-center justify-between pt-1">
          {appt.jobId ? <Link href={`/jobs/${appt.jobId}`} className="mono text-[12px] text-accent-gold hover:underline">Open job →</Link> : <span />}
          <Button size="sm" variant="outline" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
