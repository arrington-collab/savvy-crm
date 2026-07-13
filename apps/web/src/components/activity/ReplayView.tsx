"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { SHOWCASE, revealedRunCount } from "@savvy/core";
import type { FeedRow } from "@/lib/command-center-queries";
import { ActivityRow } from "./ActivityRow";

const SPEEDS = [1, 2, 4] as const;
type Speed = (typeof SPEEDS)[number];

/** Subscribe to prefers-reduced-motion without setState-in-effect (server snapshot = false). */
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

const btn = (active: boolean): React.CSSProperties => ({
  color: active ? "var(--accent-deep)" : "var(--text-muted)",
  background: active ? "color-mix(in srgb, var(--accent-deep) 12%, transparent)" : "transparent",
  border: "1px solid var(--border-panel)",
  borderRadius: 6,
  padding: "2px 8px",
  fontSize: 12,
});

/**
 * Read-only replay of one past day's agent runs. The scrubber maps wall-clock
 * progress (~REPLAY_SECONDS) to `startedAt`, revealing each run only once the
 * timeline reaches the moment it really happened (revealedRunCount — unit-tested).
 * Reduced motion: the full day is revealed statically (same facts, no movement).
 * No mutation path — purely presentational over historical data.
 */
export function ReplayView({ rows, date, startMs, endMs }: { rows: FeedRow[]; date: string; startMs: number; endMs: number }) {
  const reduce = useReducedMotion();
  const startedAtMs = useMemo(() => rows.map((r) => new Date(r.startedAt).getTime()), [rows]);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<Speed>(1);
  const raf = useRef<number | null>(null);
  const lastTs = useRef<number | null>(null);

  // Auto-advance. setState lives in the rAF callback (async), not the effect body,
  // and stops itself at the end. Disabled under reduced motion (static full reveal).
  useEffect(() => {
    if (!playing || reduce || rows.length === 0) return;
    let done = false;
    const tick = (ts: number) => {
      if (done) return;
      if (lastTs.current != null) {
        const dt = (ts - lastTs.current) / 1000;
        setProgress((p) => {
          const next = Math.min(1, p + (dt * speed) / SHOWCASE.REPLAY_SECONDS);
          if (next >= 1) done = true;
          return next;
        });
      }
      lastTs.current = ts;
      if (!done) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      lastTs.current = null;
    };
  }, [playing, speed, reduce, rows.length]);

  if (rows.length === 0) {
    return (
      <p data-testid="replay-empty" className="text-sm" style={{ color: "var(--text-faint)" }}>
        Nothing to replay on {date}.
      </p>
    );
  }

  const effProgress = reduce ? 1 : progress;
  const atEnd = effProgress >= 1;
  const count = revealedRunCount(startedAtMs, startMs, endMs, effProgress);
  const revealed = rows.slice(0, count);
  const clock = new Date(startMs + effProgress * (endMs - startMs)).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

  const toggle = () => {
    if (atEnd) {
      setProgress(0);
      setPlaying(true);
    } else {
      setPlaying((p) => !p);
    }
  };

  return (
    <div className="space-y-3" data-testid="replay-view">
      <div className="flex flex-wrap items-center gap-3">
        {!reduce && (
          <button type="button" onClick={toggle} style={btn(false)} data-testid="replay-toggle">
            {atEnd ? "Replay" : playing ? "Pause" : "Play"}
          </button>
        )}
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={effProgress}
          onChange={(e) => {
            setPlaying(false);
            setProgress(Number(e.target.value));
          }}
          disabled={reduce}
          data-testid="replay-scrubber"
          aria-label="Replay position"
          className="min-w-[8rem] flex-1"
        />
        {!reduce && (
          <div className="flex gap-1">
            {SPEEDS.map((s) => (
              <button key={s} type="button" onClick={() => setSpeed(s)} style={btn(speed === s)}>
                {s}×
              </button>
            ))}
          </div>
        )}
        <span className="mono text-[12px]" style={{ color: "var(--text-muted)" }} data-testid="replay-clock">
          {clock}
        </span>
        <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }} data-testid="replay-progress">
          {count}/{rows.length}
        </span>
      </div>
      <ul className="space-y-1">
        {revealed.map((r) => (
          <ActivityRow key={r.id} r={r} />
        ))}
      </ul>
    </div>
  );
}
