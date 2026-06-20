"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { APPOINTMENT_TYPE, type AppointmentType } from "@savvy/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createAppointmentAction, searchJobsAction, type SchedulableJob } from "@/lib/scheduling-actions";

type Crew = { id: string; name: string };

const DURATIONS = [30, 60, 90, 120, 480];
// Per-type default duration (matches parseSchedulingConfig DEFAULTS.types).
const TYPE_DEFAULT_MIN: Record<AppointmentType, number> = { inspection: 60, cm: 60, crew: 480 };

export function CreateAppointmentForm(props: {
  startLocal: string; // "YYYY-MM-DDTHH:mm" in tenant tz, prefilled from the clicked slot
  crew: Crew[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [pending, start] = useTransition();
  const [type, setType] = useState<AppointmentType>("inspection");
  const [assignee, setAssignee] = useState<string>(""); // "" = Unassigned
  const [startVal, setStartVal] = useState(props.startLocal);
  const [durationMin, setDurationMin] = useState(TYPE_DEFAULT_MIN.inspection);
  const [jobQuery, setJobQuery] = useState("");
  const [results, setResults] = useState<SchedulableJob[]>([]);
  const [picked, setPicked] = useState<SchedulableJob | null>(null);
  const [slotTaken, setSlotTaken] = useState(false);
  const [, startSearch] = useTransition();

  function onType(next: AppointmentType) {
    setType(next);
    setDurationMin(TYPE_DEFAULT_MIN[next]);
  }
  function onQuery(v: string) {
    setJobQuery(v);
    setPicked(null);
    startSearch(async () => setResults(await searchJobsAction(v)));
  }
  function submit() {
    if (!picked) return;
    setSlotTaken(false);
    const s = new Date(startVal);
    const e = new Date(s.getTime() + durationMin * 60_000);
    start(async () => {
      const r = await createAppointmentAction({
        jobId: picked.jobId, type, assigneeUserId: assignee || null,
        startsAt: s.toISOString(), endsAt: e.toISOString(),
      });
      if ("error" in r) { setSlotTaken(true); return; }
      toast.success("Appointment created");
      props.onCreated();
      props.onClose();
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.4)" }} onClick={props.onClose}>
      <div data-testid="create-appt-form" onClick={(e) => e.stopPropagation()} className="w-full max-w-sm space-y-3 rounded-xl p-4"
        style={{ background: "var(--surface-app)", border: "1px solid var(--border-panel)" }}>
        <div className="font-medium" style={{ color: "var(--text-primary)" }}>New appointment</div>

        {/* Job typeahead */}
        <div className="space-y-1">
          <Input data-testid="create-job-search" placeholder="Search customer or address…" value={picked ? picked.customerName : jobQuery}
            disabled={pending} onChange={(e) => onQuery(e.target.value)} className="text-sm" />
          {!picked && jobQuery.trim().length >= 2 ? (
            <div data-testid="create-job-results" className="max-h-40 overflow-auto rounded-md border" style={{ borderColor: "var(--border-panel)" }}>
              {results.map((j) => (
                <button key={j.jobId} data-testid="create-job-option" onClick={() => { setPicked(j); setResults([]); }}
                  className="block w-full px-2 py-1 text-left text-sm hover:bg-[var(--surface-panel)]" style={{ color: "var(--text-body)" }}>
                  {j.customerName}{j.address ? ` · ${j.address}` : ""}
                </button>
              ))}
              {results.length === 0 ? (
                <Link href="/leads/new" data-testid="create-new-lead" className="block px-2 py-1 text-sm text-accent-gold hover:underline">
                  + New lead
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex gap-2">
          <label className="flex-1 text-xs" style={{ color: "var(--text-muted)" }}>Type
            <select data-testid="create-type" value={type} onChange={(e) => onType(e.target.value as AppointmentType)}
              className="mt-0.5 w-full rounded-md border bg-transparent px-2 py-1 text-sm" style={{ borderColor: "var(--border-panel)", color: "var(--text-body)" }}>
              {APPOINTMENT_TYPE.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="flex-1 text-xs" style={{ color: "var(--text-muted)" }}>Crew
            <select data-testid="create-crew" value={assignee} onChange={(e) => setAssignee(e.target.value)}
              className="mt-0.5 w-full rounded-md border bg-transparent px-2 py-1 text-sm" style={{ borderColor: "var(--border-panel)", color: "var(--text-body)" }}>
              <option value="">Unassigned</option>
              {props.crew.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        </div>

        <div className="flex gap-2">
          <label className="flex-1 text-xs" style={{ color: "var(--text-muted)" }}>Start
            <Input type="datetime-local" data-testid="create-start" value={startVal} disabled={pending}
              onChange={(e) => { setStartVal(e.target.value); setSlotTaken(false); }} className="mt-0.5 text-sm" />
          </label>
          <label className="flex-1 text-xs" style={{ color: "var(--text-muted)" }}>Duration
            <select data-testid="create-duration" value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value))}
              className="mt-0.5 w-full rounded-md border bg-transparent px-2 py-1 text-sm" style={{ borderColor: "var(--border-panel)", color: "var(--text-body)" }}>
              {DURATIONS.map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
          </label>
        </div>

        {slotTaken ? <p className="text-xs text-destructive">That time is taken for this crew — pick another time or crew.</p> : null}

        <div className="flex items-center justify-between pt-1">
          <Button size="sm" variant="outline" onClick={props.onClose} disabled={pending}>Cancel</Button>
          <Button size="sm" data-testid="create-submit" disabled={pending || !picked} onClick={submit}>Create</Button>
        </div>
      </div>
    </div>
  );
}
