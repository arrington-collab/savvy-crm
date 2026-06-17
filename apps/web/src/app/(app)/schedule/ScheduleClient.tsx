"use client";
import { useTransition, useState } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  cancelAction,
  markStatusAction,
  rescheduleAction,
} from "@/lib/scheduling-actions";
import { StatusBadge } from "@/components/cockpit/StatusBadge";
import { personaLine, PERSONAS } from "@/lib/agents";

type AppointmentRow = {
  id: string;
  type: string | null;
  status: string | null;
  startsAt: string;
  endsAt: string | null;
  assigneeUserId: string | null;
  customerName: string | null;
  address: string | null;
};

type DayGroup = {
  day: string; // "YYYY-MM-DD"
  items: AppointmentRow[];
};

function AppointmentRow({ appt }: { appt: AppointmentRow }) {
  const [pending, start] = useTransition();
  const [showReschedule, setShowReschedule] = useState(false);
  const [rescheduleVal, setRescheduleVal] = useState("");
  const [slotTaken, setSlotTaken] = useState(false);

  const isActive = appt.status === "scheduled";

  function handleCancel() {
    start(async () => {
      await cancelAction(appt.id);
      toast.success("Appointment canceled");
    });
  }

  function handleMarkDone() {
    start(async () => {
      await markStatusAction(appt.id, "done");
      toast.success("Marked as done");
    });
  }

  function handleMarkNoShow() {
    start(async () => {
      await markStatusAction(appt.id, "no_show");
      toast.success("Marked as no-show");
    });
  }

  function handleReschedule() {
    if (!rescheduleVal) return;
    setSlotTaken(false);
    start(async () => {
      const newStart = new Date(rescheduleVal);
      const newEnd = new Date(newStart.getTime() + 60 * 60 * 1000); // +60 min
      const result = await rescheduleAction(
        appt.id,
        newStart.toISOString(),
        newEnd.toISOString(),
      );
      if ("error" in result && result.error === "slot_taken") {
        setSlotTaken(true);
        return;
      }
      toast.success("Appointment rescheduled");
      setShowReschedule(false);
      setRescheduleVal("");
    });
  }

  return (
    <Card className="p-3 space-y-2" data-testid="appointment-row">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <div className="mono font-medium text-sm">
            {new Date(appt.startsAt).toLocaleString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              hour12: true,
            })}
            {appt.endsAt
              ? ` – ${new Date(appt.endsAt).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", hour12: true })}`
              : ""}
            {appt.type ? ` · ${appt.type}` : ""}
          </div>
          {appt.customerName && (
            <div className="text-sm truncate" style={{ color: "var(--text-muted)" }}>{appt.customerName}</div>
          )}
          {appt.address && (
            <div className="text-xs truncate" style={{ color: "var(--text-faint)" }}>{appt.address}</div>
          )}
        </div>
        <StatusBadge status={appt.status ?? "unknown"} />
      </div>

      {isActive && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={handleMarkDone}
          >
            Done
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={handleMarkNoShow}
          >
            No-show
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => {
              setShowReschedule((v) => !v);
              setSlotTaken(false);
            }}
          >
            Reschedule
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={handleCancel}
            className="text-destructive hover:text-destructive"
          >
            Cancel
          </Button>
        </div>
      )}

      {isActive && showReschedule && (
        <div className="flex flex-col gap-1.5 pt-1">
          <div className="flex gap-2">
            <Input
              type="datetime-local"
              value={rescheduleVal}
              onChange={(e) => {
                setRescheduleVal(e.target.value);
                setSlotTaken(false);
              }}
              className="text-sm"
              disabled={pending}
            />
            <Button size="sm" disabled={pending || !rescheduleVal} onClick={handleReschedule}>
              Save
            </Button>
          </div>
          {slotTaken && (
            <p className="text-xs text-destructive">That time is already taken — choose another.</p>
          )}
        </div>
      )}
    </Card>
  );
}

function formatDayHeading(day: string): string {
  // day is "YYYY-MM-DD" in UTC; parse as local noon to avoid off-by-one
  const [year, month, d] = day.split("-").map(Number);
  const date = new Date(year, month - 1, d, 12, 0, 0);
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function ScheduleClient({ days }: { days: DayGroup[] }) {
  if (days.length === 0) {
    return <p className="text-sm" style={{ color: "var(--text-faint)" }}>{personaLine(PERSONAS.MILO)}</p>;
  }

  return (
    <div className="space-y-8">
      {days.map((group) => (
        <section key={group.day}>
          <h2 className="mono text-base font-semibold mb-3">{formatDayHeading(group.day)}</h2>
          <div className="space-y-2">
            {group.items.map((appt) => (
              <AppointmentRow key={appt.id} appt={appt} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
