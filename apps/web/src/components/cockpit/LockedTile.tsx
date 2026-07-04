"use client";
import { useState } from "react";
import { Card } from "@/components/ui/card";

/**
 * A blurred, locked teaser for a not-yet-built capability (e.g. a future phase).
 * Click reveals a one-paragraph thesis. Read-only — no data, pure teaser.
 */
export function LockedTile({ phase, title, tease, thesis }: { phase: string; title: string; tease: string; thesis: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="relative overflow-hidden p-4" data-testid="locked-tile">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full text-left" aria-expanded={open}>
        <div className="flex items-center justify-between">
          <span className="eyebrow">{phase}</span>
          <span aria-hidden className="text-[12px]" style={{ color: "var(--text-faint)" }}>{open ? "▾" : "🔒"}</span>
        </div>
        <div className="mt-1 font-semibold">{title}</div>
        {open ? (
          <p className="mt-2 text-[13px] leading-relaxed" style={{ color: "var(--text-muted)" }} data-testid="locked-thesis">{thesis}</p>
        ) : (
          <p className="mt-2 select-none text-[13px] leading-relaxed" style={{ color: "var(--text-faint)", filter: "blur(3px)" }} aria-hidden>{tease}</p>
        )}
        <span className="mono mt-2 inline-block text-[10px]" style={{ color: "var(--accent-gold)" }}>{open ? "Hide" : "Locked · tap to preview"}</span>
      </button>
    </Card>
  );
}
