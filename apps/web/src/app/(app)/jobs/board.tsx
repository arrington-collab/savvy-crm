"use client";

import { useState, useTransition, useEffect, useRef } from "react";
import Link from "next/link";
import {
  DndContext,
  useDraggable,
  useDroppable,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { BoardCard } from "@/lib/pipeline-queries";
import type { JobStage } from "@savvy/core";
import { moveJobToStage } from "@/lib/job-actions";
import { resolveAgent, resolveAgentForStage, personaLine } from "@/lib/agents";
import { AgentAvatar } from "@/components/cockpit/AgentAvatar";

const ACTIVE_STAGES: JobStage[] = [
  "lead",
  "inspected",
  "estimate",
  "approved",
  "production",
  "closeout",
  "billing",
  "complete",
];
const ALL_STAGES: JobStage[] = [...ACTIVE_STAGES, "lost"];

function daysInStage(stageEnteredAt: string): number {
  return Math.floor((Date.now() - Date.parse(stageEnteredAt)) / 86_400_000);
}
function formatValue(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString()}`;
}
// Stable seed from the card id so the in-voice line doesn't reshuffle on render.
function seedFromId(id: string): number {
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (n + id.charCodeAt(i)) % 997;
  return n;
}

function JobCard({ card }: { card: BoardCard }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({ id: card.id });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  // Real owning agent (latest run on this job) with stage heuristic as fallback.
  const { persona } = card.agent ? resolveAgent({ agent: card.agent, taskKey: card.taskKey }) : resolveAgentForStage(card.stage);
  return (
    <Card
      ref={setNodeRef}
      size="sm"
      style={style}
      data-testid="job-card"
      data-job-id={card.id}
      className={cn("gap-2 p-3", isDragging && "opacity-50")}
    >
      <div className="flex items-start gap-1.5">
        <button
          ref={setActivatorNodeRef}
          {...listeners}
          {...attributes}
          aria-label="Drag to move"
          data-testid="job-card-grip"
          className="mt-0.5 shrink-0 cursor-grab touch-none text-[13px] leading-none"
          style={{ color: "var(--text-faint)", background: "transparent", border: "none" }}
        >
          ⠿
        </button>
        <Link
          href={`/jobs/${card.id}`}
          data-testid="job-card-link"
          className="min-w-0 flex-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]"
        >
          <div className="font-medium" style={{ color: "var(--text-primary)" }}>{card.customerName}</div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>{card.address}</div>
          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="mono font-medium" style={{ color: persona.colorToken }}>{formatValue(card.valueEstimate)}</span>
            <span className="mono rounded px-1.5 py-0.5 text-[10px]" style={{ color: "var(--text-faint)", background: "var(--surface-panel)" }}>
              {daysInStage(card.stageEnteredAt)}d
            </span>
          </div>
          {(card.health.stuck || card.health.late) && (
            <div className="mt-1 flex flex-wrap gap-1">
              {card.health.stuck && (
                <span title={card.health.reasons.join("; ")} className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">At risk</span>
              )}
              {card.health.late && (
                <span title={card.health.reasons.join("; ")} className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-200">Late</span>
              )}
            </div>
          )}
          <div className="mt-2 flex min-w-0 items-center gap-1.5" style={{ borderTop: "1px solid var(--border-panel)", paddingTop: 8 }}>
            <AgentAvatar persona={persona} size="sm" />
            <span className="truncate text-[11px]" style={{ color: "var(--text-muted)" }}>{personaLine(persona, seedFromId(card.id))}</span>
          </div>
        </Link>
      </div>
    </Card>
  );
}

function Column({ stage, cards, focused }: { stage: JobStage; cards: BoardCard[]; focused?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  const colRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focused) colRef.current?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [focused]);
  const muted = stage === "lost";
  const accent = resolveAgentForStage(stage).persona.colorToken;
  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        colRef.current = el;
      }}
      data-testid={`col-${stage}`}
      data-focused={focused ? "true" : undefined}
      className={cn("flex w-64 shrink-0 flex-col gap-2 rounded-xl p-2", muted && "opacity-60")}
      style={{
        border: focused
          ? "1px solid var(--accent-gold)"
          : isOver
            ? "1px solid var(--accent-040)"
            : "1px solid var(--border-panel)",
        background: "var(--surface-panel)",
        boxShadow: focused ? "0 0 0 2px var(--accent-gold)" : isOver ? "var(--active-shadow)" : "none",
      }}
    >
      <div className="flex items-center justify-between px-1">
        <span className="mono flex items-center gap-1.5 text-[12px] uppercase tracking-wider" style={{ color: "var(--text-body)" }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: accent }} />
          {stage}
        </span>
        <span className="mono text-[12px]" style={{ color: "var(--text-faint)" }}>{cards.length}</span>
      </div>
      <div className="flex flex-col gap-2">
        {cards.map((c) => (
          <JobCard key={c.id} card={c} />
        ))}
      </div>
    </div>
  );
}

export function Board({ initialBoard, focusStage }: { initialBoard: Record<string, BoardCard[]>; focusStage?: string }) {
  const [board, setBoard] = useState<Record<string, BoardCard[]>>(initialBoard);
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [, startTransition] = useTransition();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const needsAttention = Object.values(board).flat().filter((c) => c.health.stuck || c.health.late);

  function handleDragEnd(event: DragEndEvent) {
    const jobId = String(event.active.id);
    const toStage = event.over ? (String(event.over.id) as JobStage) : null;
    if (!toStage) return;

    let fromStage: string | null = null;
    let moved: BoardCard | undefined;
    for (const [stage, cards] of Object.entries(board)) {
      const found = cards.find((c) => c.id === jobId);
      if (found) {
        fromStage = stage;
        moved = found;
        break;
      }
    }
    if (!moved || fromStage === null || fromStage === toStage) return;

    const prevBoard = board;
    const optimistic: BoardCard = { ...moved, stage: toStage, stageEnteredAt: new Date().toISOString() };
    setBoard((b) => ({
      ...b,
      [fromStage!]: (b[fromStage!] ?? []).filter((c) => c.id !== jobId),
      [toStage]: [optimistic, ...(b[toStage] ?? [])],
    }));

    startTransition(async () => {
      try {
        const result = await moveJobToStage(jobId, toStage);
        if ("error" in result) {
          setBoard(prevBoard);
          toast.error(`Can't mark complete — missing photos: ${result.missing.join(", ")}`);
          return;
        }
      } catch {
        setBoard(prevBoard);
        toast.error("Couldn't move job. Reverted.");
      }
    });
  }

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="mb-3 flex items-center gap-3">
        <button
          onClick={() => setOnlyAttention((v) => !v)}
          className={cn(
            "text-sm font-medium underline-offset-2 hover:underline",
            onlyAttention && "underline",
          )}
          style={{ color: onlyAttention ? "var(--accent-gold)" : "var(--text-body)" }}
        >
          Needs attention ({needsAttention.length})
        </button>
      </div>
      <div data-testid="board" className="flex gap-3 overflow-x-auto pb-4">
        {ALL_STAGES.map((stage) => {
          const cards = board[stage] ?? [];
          const visible = onlyAttention ? cards.filter((c) => c.health.stuck || c.health.late) : cards;
          return <Column key={stage} stage={stage} cards={visible} focused={stage === focusStage} />;
        })}
      </div>
    </DndContext>
  );
}
