import { pulseDurationSeconds } from "@savvy/core";
import type { CSSProperties } from "react";

/** Decorative orchestrator core — concentric rotating rings + glowing center. The
    center orb breathes at the real work rate: its pulse period is driven by
    `runsLastHour` (count of agent_run in the last 60m), so it never pulses faster
    than the machine is actually working. Motion is gated by prefers-reduced-motion
    via the .anim-* utility classes. */
export function SageCore({ runsLastHour = 0 }: { runsLastHour?: number }) {
  const orbStyle: CSSProperties = {
    width: 80,
    height: 80,
    background: "radial-gradient(circle, var(--accent-016), transparent 70%)",
    boxShadow: "var(--glow-accent)",
    ["--pulse-rate" as string]: `${pulseDurationSeconds(runsLastHour)}s`,
  };
  return (
    <div className="relative flex items-center justify-center" style={{ height: 200 }} aria-hidden data-testid="sage-core" data-runs-hour={runsLastHour}>
      <div className="anim-spin absolute rounded-full" style={{ width: 188, height: 188, border: "1px solid var(--accent-016)" }} />
      <div className="anim-spinrev absolute rounded-full" style={{ width: 142, height: 142, border: "1px solid var(--accent-030)" }} />
      <div className="anim-spin absolute rounded-full" style={{ width: 100, height: 100, border: "1px dashed var(--accent-040)" }} />
      <div className="anim-orbpulse relative flex flex-col items-center justify-center rounded-full" style={orbStyle}>
        <span className="mono font-semibold text-accent-gold" style={{ fontSize: 13, letterSpacing: "0.08em" }}>
          SAGE
        </span>
        <span className="eyebrow anim-pulse" style={{ fontSize: "0.5rem", letterSpacing: "0.2em" }}>
          orchestrating
        </span>
      </div>
    </div>
  );
}
