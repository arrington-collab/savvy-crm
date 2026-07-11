"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { OdometerView } from "@savvy/core";
import { useReducedMotion } from "@/hooks/useReducedMotion";

// useLayoutEffect on the client so the animate decision (and any reset to 0)
// happens before paint; useEffect on the server to avoid the SSR warning. Reduced
// motion comes from useReducedMotion (useSyncExternalStore) so it is already
// correct on first commit — a reduced-motion user never sees a frame of movement.
// Motion users may briefly see the SSR-rendered final numbers before the ramp
// restarts from 0; that is an accepted cosmetic tradeoff for opted-in motion.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;
const COUNT_MS = 900;

/**
 * The Today-header odometer. Count-ups actions + minutes from 0 on mount; under
 * reduced motion it snaps straight to the final value (same facts, no movement).
 * "quiet" mode renders honest copy with no numbers to animate.
 */
export function Odometer({ view }: { view: OdometerView }) {
  const reduced = useReducedMotion();
  const [progress, setProgress] = useState(1); // SSR/hydrate at the final value (honest + a11y)
  const raf = useRef<number | null>(null);

  useIsoLayoutEffect(() => {
    if (reduced || view.mode === "quiet") {
      setProgress(1);
      return;
    }
    setProgress(0);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / COUNT_MS);
      setProgress(1 - Math.pow(1 - t, 3)); // easeOutCubic
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [reduced, view.mode, view.actions, view.minutes]);

  if (view.mode === "quiet") {
    return (
      <span data-testid="odometer" data-mode="quiet" className="text-sm" style={{ color: "var(--text-muted)" }}>
        A quiet night — no agent actions in the last 24h.
      </span>
    );
  }

  const actions = Math.round(view.actions * progress);
  const minutes = Math.round(view.minutes * progress);

  return (
    <span data-testid="odometer" data-mode="counting" className="group relative inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-sm" style={{ color: "var(--text-muted)" }}>
      <b data-testid="odometer-actions" className="mono" style={{ color: "var(--accent-gold)" }}>{actions}</b>
      <span>agent action{view.actions === 1 ? "" : "s"} today</span>
      {view.minutes > 0 && (
        <>
          <span style={{ color: "var(--text-faint)" }}>·</span>
          <b data-testid="odometer-minutes" className="mono" style={{ color: "var(--text-body)" }}>~{minutes}</b>
          <span
            tabIndex={0}
            data-testid="odometer-minutes-label"
            className="cursor-help underline decoration-dotted underline-offset-2"
          >
            min of your time saved
            <span
              role="tooltip"
              data-testid="odometer-methodology"
              className="pointer-events-none absolute left-0 top-full z-10 mt-1 hidden w-max max-w-xs rounded-md border p-2 text-[11px] group-hover:block group-focus-within:block"
              style={{ background: "var(--popover)", borderColor: "var(--accent-030)", color: "var(--text-muted)" }}
            >
              <b style={{ color: "var(--text-body)" }}>How this is counted</b> — completed actions only, conservative per-task equivalents:
              <ul className="mono mt-1 space-y-0.5">
                {view.lines.map((l) => (
                  <li key={l.taskKey}>
                    {l.verb} × {l.count} · {l.minutesEach}m = {l.subtotal}m
                  </li>
                ))}
              </ul>
            </span>
          </span>
        </>
      )}
    </span>
  );
}
