"use client";
import { DndContext, useDraggable, useDroppable, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { buildCrewView, type ScheduleAppt, type CrewColumn } from "@savvy/core";

function Card({ a, weekday, onSelect }: { a: ScheduleAppt; weekday: string; onSelect: (x: ScheduleAppt) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: a.id });
  return (
    <button ref={setNodeRef} {...listeners} {...attributes} data-testid="appt-card" onClick={() => onSelect(a)}
      className="block w-full rounded-md px-2 py-1 text-left text-[11px]"
      style={{ background: "var(--surface-app)", color: "var(--text-body)", opacity: isDragging ? 0.7 : 1 }}>
      <span className="mono" style={{ color: "var(--text-faint)" }}>{weekday}</span> {a.customerName ?? a.type}
    </button>
  );
}

function Col({ col, onSelect }: { col: CrewColumn; onSelect: (a: ScheduleAppt) => void }) {
  const { setNodeRef } = useDroppable({ id: col.userId ?? "unassigned" });
  return (
    <div ref={setNodeRef} data-testid={`crew-col-${col.userId ?? "unassigned"}`} className="w-56 shrink-0 rounded-xl p-2" style={{ background: "var(--surface-panel)", border: "1px solid var(--border-panel)" }}>
      <div className="mono mb-2 px-1 text-[12px] uppercase tracking-wider" style={{ color: "var(--text-body)" }}>
        {col.name} <span style={{ color: "var(--text-faint)" }}>· {col.appts.length}</span>
      </div>
      <div className="space-y-1">
        {col.days.flatMap((d) => d.appts.map((a) => <Card key={a.id} a={a} weekday={d.weekday} onSelect={onSelect} />))}
        {col.appts.length === 0 ? <div className="px-2 py-1 text-[11px]" style={{ color: "var(--text-faint)" }}>—</div> : null}
      </div>
    </div>
  );
}

export function CrewBoard({ appts, anchor, tz, crew, onSelect, onReassign }: {
  appts: ScheduleAppt[]; anchor: string; tz: string; crew: { id: string; name: string }[];
  onSelect: (a: ScheduleAppt) => void; onReassign: (id: string, userId: string | null) => void;
}) {
  const view = buildCrewView(appts, anchor, tz, crew);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  function handleDragEnd(e: DragEndEvent) {
    const appt = appts.find((a) => a.id === String(e.active.id));
    if (!appt || !e.over) return;
    const target = String(e.over.id); // a userId or "unassigned"
    const targetUserId = target === "unassigned" ? null : target;
    if (targetUserId === appt.assigneeUserId) return; // dropped on its own column -> no-op
    onReassign(appt.id, targetUserId);
  }
  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="overflow-x-auto" data-testid="crew-board">
        <div className="flex gap-3">
          {view.columns.map((col) => <Col key={col.userId ?? "unassigned"} col={col} onSelect={onSelect} />)}
        </div>
      </div>
    </DndContext>
  );
}
