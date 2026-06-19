"use client";
import { buildCrewView, type ScheduleAppt } from "@savvy/core";

export function CrewBoard({ appts, anchor, tz, crew, onSelect }: { appts: ScheduleAppt[]; anchor: string; tz: string; crew: { id: string; name: string }[]; onSelect: (a: ScheduleAppt) => void }) {
  const view = buildCrewView(appts, anchor, tz, crew);
  return (
    <div className="overflow-x-auto" data-testid="crew-board">
      <div className="flex gap-3">
        {view.columns.map((col) => (
          <div key={col.userId ?? "unassigned"} data-testid={`crew-col-${col.userId ?? "unassigned"}`} className="w-56 shrink-0 rounded-xl p-2" style={{ background: "var(--surface-panel)", border: "1px solid var(--border-panel)" }}>
            <div className="mono mb-2 px-1 text-[12px] uppercase tracking-wider" style={{ color: "var(--text-body)" }}>
              {col.name} <span style={{ color: "var(--text-faint)" }}>· {col.appts.length}</span>
            </div>
            <div className="space-y-1">
              {col.days.flatMap((d) => d.appts.map((a) => (
                <button key={a.id} data-testid="appt-card" onClick={() => onSelect(a)}
                  className="block w-full rounded-md px-2 py-1 text-left text-[11px]"
                  style={{ background: "var(--surface-app)", color: "var(--text-body)" }}>
                  <span className="mono" style={{ color: "var(--text-faint)" }}>{d.weekday}</span> {a.customerName ?? a.type}
                </button>
              )))}
              {col.appts.length === 0 ? <div className="px-2 py-1 text-[11px]" style={{ color: "var(--text-faint)" }}>—</div> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
