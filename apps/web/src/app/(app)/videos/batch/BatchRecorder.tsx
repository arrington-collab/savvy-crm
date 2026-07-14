"use client";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { TakeRecorder } from "@/components/video/TakeRecorder";
import type { VideoBatchEntry } from "@savvy/db";

// The batch flow: current customer's card + recorder; approve auto-advances.
export function BatchRecorder({ queue }: { queue: VideoBatchEntry[] }) {
  const [idx, setIdx] = useState(0);
  const [done, setDone] = useState(0);
  const entry = queue[idx];

  if (!entry) {
    return (
      <Card className="p-6 text-center" data-testid="batch-complete">
        <p className="text-lg font-semibold" style={{ color: "var(--text-body)" }}>
          {done} video{done === 1 ? "" : "s"} recorded 🎉
        </p>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          NOVA delivers them day-after with your wrapper — nothing else to do.
        </p>
      </Card>
    );
  }

  const overlayLines = [
    entry.item.repLine,
    entry.item.priceLine,
    entry.item.nugget,
    ...(entry.item.phoneticNeeded ? ["(Say the name slowly — double-check it)"] : []),
  ];

  return (
    <div className="space-y-3" data-testid="batch-recorder">
      <div className="flex items-center justify-between text-sm" style={{ color: "var(--text-muted)" }}>
        <span data-testid="batch-progress">
          {idx + 1} of {queue.length}
        </span>
        <button className="underline" data-testid="batch-skip" onClick={() => setIdx((i) => i + 1)}>
          Skip this one →
        </button>
      </div>
      <Card className="p-4" data-testid="batch-card">
        <p className="text-lg font-semibold" style={{ color: "var(--text-body)" }}>{entry.item.headline}</p>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>{entry.item.repLine}</p>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>{entry.item.priceLine}</p>
        <p className="text-sm font-medium" style={{ color: "var(--text-body)" }}>{entry.item.nugget}</p>
      </Card>
      <TakeRecorder
        key={entry.estimateId}
        estimateId={entry.estimateId}
        role="owner"
        overlay={{ headline: entry.item.headline, lines: overlayLines }}
        onDone={() => {
          setDone((d) => d + 1);
          setIdx((i) => i + 1);
        }}
      />
    </div>
  );
}
