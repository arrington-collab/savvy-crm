"use client";

import { useState, useTransition } from "react";
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

function JobCard({ card }: { card: BoardCard }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: card.id });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return (
    <Card
      ref={setNodeRef}
      size="sm"
      style={style}
      data-testid="job-card"
      data-job-id={card.id}
      className={cn("cursor-grab gap-2 p-3", isDragging && "opacity-50")}
      {...listeners}
      {...attributes}
    >
      <div className="font-medium">{card.customerName}</div>
      <div className="text-xs text-muted-foreground">{card.address}</div>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">{formatValue(card.valueEstimate)}</span>
        <span className="text-muted-foreground">
          {daysInStage(card.stageEnteredAt)}d
        </span>
      </div>
      <Link
        href={`/jobs/${card.id}`}
        onPointerDown={(e) => e.stopPropagation()}
        className="text-xs font-medium text-primary hover:underline"
      >
        Open
      </Link>
    </Card>
  );
}

function Column({ stage, cards }: { stage: JobStage; cards: BoardCard[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  const muted = stage === "lost";
  return (
    <div
      ref={setNodeRef}
      data-testid={`col-${stage}`}
      className={cn(
        "flex w-64 shrink-0 flex-col gap-2 rounded-lg border border-border p-2",
        muted && "opacity-60",
        isOver && "ring-2 ring-primary",
      )}
    >
      <div className="flex items-center justify-between px-1 text-sm font-medium">
        <span className="capitalize">{stage}</span>
        <span className="text-muted-foreground">{cards.length}</span>
      </div>
      <div className="flex flex-col gap-2">
        {cards.map((c) => (
          <JobCard key={c.id} card={c} />
        ))}
      </div>
    </div>
  );
}

export function Board({
  initialBoard,
}: {
  initialBoard: Record<string, BoardCard[]>;
}) {
  const [board, setBoard] =
    useState<Record<string, BoardCard[]>>(initialBoard);
  const [, startTransition] = useTransition();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const jobId = String(event.active.id);
    const toStage = event.over ? (String(event.over.id) as JobStage) : null;
    if (!toStage) return;

    // Locate the card and its current column.
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
    const optimistic: BoardCard = {
      ...moved,
      stage: toStage,
      stageEnteredAt: new Date().toISOString(),
    };
    setBoard((b) => ({
      ...b,
      [fromStage!]: (b[fromStage!] ?? []).filter((c) => c.id !== jobId),
      [toStage]: [optimistic, ...(b[toStage] ?? [])],
    }));

    startTransition(async () => {
      try {
        await moveJobToStage(jobId, toStage);
      } catch {
        setBoard(prevBoard);
        toast.error("Couldn't move job. Reverted.");
      }
    });
  }

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div data-testid="board" className="flex gap-3 overflow-x-auto pb-4">
        {ALL_STAGES.map((stage) => (
          <Column key={stage} stage={stage} cards={board[stage] ?? []} />
        ))}
      </div>
    </DndContext>
  );
}
