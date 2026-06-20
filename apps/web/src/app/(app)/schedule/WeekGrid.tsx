"use client";
import { DndContext, useDraggable, useDroppable, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { buildWeekView, applyDragToWeek, minutesFromOffset, type ScheduleAppt, type PositionedAppt, type WeekDay } from "@savvy/core";

function WeekBlock({ b, onSelect }: { b: PositionedAppt; onSelect: (a: ScheduleAppt) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: b.id });
  const drag = transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined;
  return (
    <button ref={setNodeRef} {...listeners} {...attributes} data-testid="appt-block" onClick={(e) => { e.stopPropagation(); onSelect(b); }}
      className="absolute overflow-hidden rounded-md px-1.5 py-0.5 text-left text-[11px]"
      style={{
        top: `${b.topPct}%`, height: `${b.heightPct}%`, left: `${(b.lane / b.lanes) * 100}%`, width: `${(1 / b.lanes) * 100}%`,
        transform: drag, zIndex: isDragging ? 20 : undefined, opacity: isDragging ? 0.7 : 1,
        background: "var(--surface-panel)", borderLeft: `3px solid ${b.tone}`, color: "var(--text-body)",
      }}>
      <span className="truncate">{b.customerName ?? b.type}</span>
    </button>
  );
}

function WeekCol({ day, onSelect, onCreate }: {
  day: WeekDay; onSelect: (a: ScheduleAppt) => void; onCreate: (date: string, minutes: number) => void;
}) {
  const { setNodeRef } = useDroppable({ id: day.date });
  return (
    <div ref={setNodeRef} data-testid={`week-col-${day.date}`} className="relative border-l" style={{ height: 560, borderColor: "var(--border-panel)" }}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onCreate(day.date, minutesFromOffset(e.clientY - rect.top, rect.height));
      }}>
      {day.blocks.map((b) => <WeekBlock key={b.id} b={b} onSelect={onSelect} />)}
    </div>
  );
}

export function WeekGrid({ appts, anchor, tz, onSelect, onReschedule, onCreate }: {
  appts: ScheduleAppt[]; anchor: string; tz: string;
  onSelect: (a: ScheduleAppt) => void; onReschedule: (id: string, next: { startsAt: string; endsAt: string }) => void;
  onCreate: (date: string, minutes: number) => void;
}) {
  const view = buildWeekView(appts, anchor, tz);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  function handleDragEnd(e: DragEndEvent) {
    const appt = appts.find((a) => a.id === String(e.active.id));
    const overDate = e.over ? String(e.over.id) : null;
    if (!appt || !overDate) return;
    onReschedule(appt.id, applyDragToWeek({ startsAt: appt.startsAt, endsAt: appt.endsAt }, e.delta.y, 560, overDate, tz));
  }
  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="overflow-x-auto" data-testid="week-grid">
        <div className="grid min-w-[700px]" style={{ gridTemplateColumns: "48px repeat(7, 1fr)" }}>
          <div />
          {view.days.map((d) => (
            <div key={d.date} className="mono px-1 pb-2 text-center text-[11px]" style={{ color: "var(--text-muted)" }}>{d.weekday} {Number(d.date.slice(8))}</div>
          ))}
          <div className="relative" style={{ height: 560 }}>
            {view.hourLabels.map((h, i) => (
              <div key={h} className="mono absolute right-1 text-[10px]" style={{ top: `${(i / (view.hourLabels.length - 1)) * 100}%`, color: "var(--text-faint)" }}>{h}</div>
            ))}
          </div>
          {view.days.map((d) => <WeekCol key={d.date} day={d} onSelect={onSelect} onCreate={onCreate} />)}
        </div>
      </div>
    </DndContext>
  );
}
