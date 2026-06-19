"use client";
import { DndContext, useDraggable, useDroppable, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { buildMonthView, applyDragToMonth, type ScheduleAppt, type MonthChip, type MonthCell } from "@savvy/core";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Chip({ c, onSelect }: { c: MonthChip; onSelect: (a: ScheduleAppt) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: c.id });
  return (
    <button ref={setNodeRef} {...listeners} {...attributes} data-testid="appt-chip" onClick={() => onSelect(c)}
      className="block w-full truncate rounded px-1 text-left text-[10px]"
      style={{ background: "var(--surface-panel)", borderLeft: `3px solid ${c.tone}`, color: "var(--text-body)", opacity: isDragging ? 0.7 : 1 }}>
      {c.customerName ?? c.type}
    </button>
  );
}

function Cell({ cell, onSelect }: { cell: MonthCell; onSelect: (a: ScheduleAppt) => void }) {
  const { setNodeRef } = useDroppable({ id: cell.date });
  return (
    <div ref={setNodeRef} data-testid={`month-cell-${cell.date}`} className="min-h-24 border-b border-r p-1" style={{ borderColor: "var(--border-panel)", opacity: cell.outside ? 0.4 : 1 }}>
      <div className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>{cell.day}</div>
      <div className="mt-0.5 space-y-0.5">
        {cell.chips.slice(0, 3).map((c) => <Chip key={c.id} c={c} onSelect={onSelect} />)}
        {cell.chips.length > 3 ? <div className="mono text-[10px]" style={{ color: "var(--text-faint)" }}>+{cell.chips.length - 3} more</div> : null}
      </div>
    </div>
  );
}

export function MonthGrid({ appts, anchor, tz, onSelect, onReschedule }: {
  appts: ScheduleAppt[]; anchor: string; tz: string;
  onSelect: (a: ScheduleAppt) => void; onReschedule: (id: string, next: { startsAt: string; endsAt: string }) => void;
}) {
  const view = buildMonthView(appts, anchor, tz);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  function handleDragEnd(e: DragEndEvent) {
    const appt = appts.find((a) => a.id === String(e.active.id));
    const overDate = e.over ? String(e.over.id) : null;
    if (!appt || !overDate) return;
    onReschedule(appt.id, applyDragToMonth({ startsAt: appt.startsAt, endsAt: appt.endsAt }, overDate, tz));
  }
  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div data-testid="month-grid">
        <div className="grid grid-cols-7">
          {DOW.map((d) => <div key={d} className="mono px-2 py-1 text-[11px]" style={{ color: "var(--text-muted)" }}>{d}</div>)}
        </div>
        <div className="grid grid-cols-7" style={{ borderTop: "1px solid var(--border-panel)" }}>
          {view.weeks.flat().map((cell) => <Cell key={cell.date} cell={cell} onSelect={onSelect} />)}
        </div>
      </div>
    </DndContext>
  );
}
