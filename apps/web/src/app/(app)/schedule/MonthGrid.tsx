"use client";
import { buildMonthView, type ScheduleAppt } from "@savvy/core";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function MonthGrid({ appts, anchor, tz, onSelect }: { appts: ScheduleAppt[]; anchor: string; tz: string; onSelect: (a: ScheduleAppt) => void }) {
  const view = buildMonthView(appts, anchor, tz);
  return (
    <div data-testid="month-grid">
      <div className="grid grid-cols-7">
        {DOW.map((d) => <div key={d} className="mono px-2 py-1 text-[11px]" style={{ color: "var(--text-muted)" }}>{d}</div>)}
      </div>
      <div className="grid grid-cols-7" style={{ borderTop: "1px solid var(--border-panel)" }}>
        {view.weeks.flat().map((cell) => (
          <div key={cell.date} data-testid={`month-cell-${cell.date}`} className="min-h-24 border-b border-r p-1"
            style={{ borderColor: "var(--border-panel)", opacity: cell.outside ? 0.4 : 1 }}>
            <div className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>{cell.day}</div>
            <div className="mt-0.5 space-y-0.5">
              {cell.chips.slice(0, 3).map((c) => (
                <button key={c.id} data-testid="appt-chip" onClick={() => onSelect(c)}
                  className="block w-full truncate rounded px-1 text-left text-[10px]"
                  style={{ background: "var(--surface-panel)", borderLeft: `3px solid ${c.tone}`, color: "var(--text-body)" }}>
                  {c.customerName ?? c.type}
                </button>
              ))}
              {cell.chips.length > 3 ? <div className="mono text-[10px]" style={{ color: "var(--text-faint)" }}>+{cell.chips.length - 3} more</div> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
