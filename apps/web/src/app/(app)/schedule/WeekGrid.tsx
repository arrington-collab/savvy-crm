"use client";
import { buildWeekView, type ScheduleAppt } from "@savvy/core";

export function WeekGrid({ appts, anchor, tz, onSelect }: { appts: ScheduleAppt[]; anchor: string; tz: string; onSelect: (a: ScheduleAppt) => void }) {
  const view = buildWeekView(appts, anchor, tz);
  return (
    <div className="overflow-x-auto" data-testid="week-grid">
      <div className="grid min-w-[700px]" style={{ gridTemplateColumns: "48px repeat(7, 1fr)" }}>
        <div />
        {view.days.map((d) => (
          <div key={d.date} className="mono px-1 pb-2 text-center text-[11px]" style={{ color: "var(--text-muted)" }}>
            {d.weekday} {Number(d.date.slice(8))}
          </div>
        ))}
        <div className="relative" style={{ height: 560 }}>
          {view.hourLabels.map((h, i) => (
            <div key={h} className="mono absolute right-1 text-[10px]" style={{ top: `${(i / (view.hourLabels.length - 1)) * 100}%`, color: "var(--text-faint)" }}>{h}</div>
          ))}
        </div>
        {view.days.map((d) => (
          <div key={d.date} data-testid={`week-col-${d.date}`} className="relative border-l" style={{ height: 560, borderColor: "var(--border-panel)" }}>
            {d.blocks.map((b) => (
              <button key={b.id} data-testid="appt-block" onClick={() => onSelect(b)}
                className="absolute overflow-hidden rounded-md px-1.5 py-0.5 text-left text-[11px]"
                style={{
                  top: `${b.topPct}%`, height: `${b.heightPct}%`,
                  left: `${(b.lane / b.lanes) * 100}%`, width: `${(1 / b.lanes) * 100}%`,
                  background: "var(--surface-panel)", borderLeft: `3px solid ${b.tone}`, color: "var(--text-body)",
                }}>
                <span className="truncate">{b.customerName ?? b.type}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
