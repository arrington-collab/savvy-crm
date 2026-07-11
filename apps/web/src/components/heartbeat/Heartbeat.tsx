import Link from "next/link";
import type { HeartbeatState } from "@savvy/core";

/** Static last-touch chip + optional cold badge. No animation (spec: heartbeat is
 *  static). The cold badge deep-links to the entity's activity feed. */
export function Heartbeat({ kind, id, state }: { kind: "job" | "lead"; id: string; state: HeartbeatState }) {
  return (
    <span data-testid="heartbeat" data-cold={state.cold} className="inline-flex items-center gap-1.5">
      <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }} data-testid="heartbeat-label">
        {state.label}
      </span>
      {state.cold && (
        <Link
          href={`/activity?${kind}=${id}`}
          data-testid="heartbeat-cold"
          className="mono rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
          style={{ background: "var(--status-error-010, rgba(229,86,75,0.12))", color: "var(--status-error)" }}
        >
          cold
        </Link>
      )}
    </span>
  );
}
