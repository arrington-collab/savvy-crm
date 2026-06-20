"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, useTransition } from "react";
import { addWeeks, addMonths, toCivilDate, zonedTimeToUtc, type ScheduleAppt } from "@savvy/core";
import { APPOINTMENT_TYPE, JOB_TYPE } from "@savvy/core";
import { WeekGrid } from "./WeekGrid";
import { MonthGrid } from "./MonthGrid";
import { CrewBoard } from "./CrewBoard";
import { AppointmentPopover } from "./AppointmentPopover";
import { CreateAppointmentForm } from "./CreateAppointmentForm";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { rescheduleAction, reassignAction } from "@/lib/scheduling-actions";

type Crew = { id: string; name: string };
type View = "week" | "month" | "crew";

export function ScheduleClient(props: {
  appts: ScheduleAppt[];
  crew: Crew[];
  cityOptions: { cities: string[]; hasUnknown: boolean };
  tz: string;
  view: View;
  anchor: string;
  filters: { crew: string; type: string; jobType: string; city: string };
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [selected, setSelected] = useState<ScheduleAppt | null>(null);
  const [createDraft, setCreateDraft] = useState<{ date: string; minutes: number } | null>(null);
  const [appts, setAppts] = useState(props.appts);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync from server: re-hydrate optimistic state on server revalidation
  useEffect(() => setAppts(props.appts), [props.appts]);
  const [, startTransition] = useTransition();
  const crewName = (id: string | null) => props.crew.find((c) => c.id === id)?.name ?? null;

  function onReschedule(id: string, next: { startsAt: string; endsAt: string }) {
    const prev = appts;
    setAppts((a) => a.map((x) => (x.id === id ? { ...x, ...next } : x)));
    startTransition(async () => {
      const r = await rescheduleAction(id, next.startsAt, next.endsAt);
      if ("error" in r) { setAppts(prev); toast.error("That time is taken — reverted."); }
    });
  }
  function onReassign(id: string, userId: string | null) {
    const prev = appts;
    setAppts((a) => a.map((x) => (x.id === id ? { ...x, assigneeUserId: userId, assigneeName: crewName(userId) } : x)));
    startTransition(async () => {
      const r = await reassignAction(id, userId);
      if ("error" in r) { setAppts(prev); toast.error("That crew is busy then — reverted."); }
    });
  }

  function setParam(patch: Record<string, string>) {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    router.push(`/schedule?${next.toString()}`);
  }
  const setView = (view: View) => setParam({ view });
  const step = (dir: -1 | 1) =>
    setParam({ anchor: props.view === "month" ? `${addMonths(props.anchor, dir).slice(0, 7)}-01` : addWeeks(props.anchor, dir) });
  const goToday = () => setParam({ anchor: toCivilDate(new Date().toISOString(), props.tz) });

  function draftStartLocal(date: string, minutes: number): string {
    // zonedTimeToUtc gives the UTC instant for that wall-clock slot; render it back
    // as a tz-local "YYYY-MM-DDTHH:mm" for the datetime-local input.
    const iso = zonedTimeToUtc(date, minutes, props.tz);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: props.tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(iso));
    const g = (t: string) => parts.find((p) => p.type === t)!.value;
    return `${g("year")}-${g("month")}-${g("day")}T${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}`;
  }

  const sel = (cls: string) => "rounded-md px-2 py-1 text-sm " + cls;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1" data-testid="view-toggle">
          {(["week", "month", "crew"] as View[]).map((v) => (
            <button key={v} data-testid={`view-${v}`} onClick={() => setView(v)}
              className={sel(props.view === v ? "bg-[var(--accent-010)] text-accent-gold" : "text-[var(--text-muted)]")}>
              {v[0]!.toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => step(-1)} data-testid="nav-prev">‹</Button>
          <Button size="sm" variant="outline" onClick={goToday} data-testid="nav-today">Today</Button>
          <Button size="sm" variant="outline" onClick={() => step(1)} data-testid="nav-next">›</Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2" data-testid="filter-bar">
        <Select label="Crew" value={props.filters.crew} onChange={(v) => setParam({ crew: v })}
          options={[["", "All crew"], ...props.crew.map((c) => [c.id, c.name] as [string, string])]} testid="filter-crew" />
        <Select label="Type" value={props.filters.type} onChange={(v) => setParam({ type: v })}
          options={[["", "All types"], ...APPOINTMENT_TYPE.map((t) => [t, t] as [string, string])]} testid="filter-type" />
        <Select label="Job" value={props.filters.jobType} onChange={(v) => setParam({ jobType: v })}
          options={[["", "All jobs"], ...JOB_TYPE.map((t) => [t, t] as [string, string])]} testid="filter-jobType" />
        <Select label="City" value={props.filters.city} onChange={(v) => setParam({ city: v })}
          options={[["", "All cities"], ...props.cityOptions.cities.map((c) => [c, c] as [string, string]),
            ...(props.cityOptions.hasUnknown ? [["__unknown__", "Unknown"] as [string, string]] : [])]} testid="filter-city" />
      </div>

      {props.view === "week" && <WeekGrid appts={appts} anchor={props.anchor} tz={props.tz} onSelect={(appt) => { setCreateDraft(null); setSelected(appt); }} onReschedule={onReschedule} onCreate={(date, minutes) => { setSelected(null); setCreateDraft({ date, minutes }); }} />}
      {props.view === "month" && <MonthGrid appts={appts} anchor={props.anchor} tz={props.tz} onSelect={(appt) => { setCreateDraft(null); setSelected(appt); }} onReschedule={onReschedule} />}
      {props.view === "crew" && <CrewBoard appts={appts} anchor={props.anchor} tz={props.tz} crew={props.crew} onSelect={(appt) => { setCreateDraft(null); setSelected(appt); }} onReassign={onReassign} />}

      {selected && <AppointmentPopover appt={selected} tz={props.tz} onClose={() => setSelected(null)} />}
      {createDraft && (
        <CreateAppointmentForm
          startLocal={draftStartLocal(createDraft.date, createDraft.minutes)}
          crew={props.crew}
          onClose={() => setCreateDraft(null)}
          onCreated={() => router.refresh()}
        />
      )}
    </div>
  );
}

function Select(props: { label: string; value: string; onChange: (v: string) => void; options: [string, string][]; testid: string }) {
  return (
    <label className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
      {props.label}
      <select data-testid={props.testid} value={props.value} onChange={(e) => props.onChange(e.target.value)}
        className="rounded-md border bg-transparent px-2 py-1 text-sm"
        style={{ borderColor: "var(--border-panel)", color: "var(--text-body)" }}>
        {props.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}
