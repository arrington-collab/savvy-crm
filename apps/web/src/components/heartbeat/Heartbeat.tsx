import Link from "next/link";
import type { HeartbeatState } from "@savvy/core";

const BADGE_CLASS = "mono rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide";
const BADGE_STYLE = { background: "var(--status-error-010, rgba(229,86,75,0.12))", color: "var(--status-error)" } as const;

/**
 * Static last-touch chip + optional cold badge. No animation (spec: heartbeat is
 * static). The cold badge normally deep-links to the entity's activity feed, but
 * on board cards the whole card is already an <a> (nesting <a> is invalid HTML and
 * triggers a hydration error), so those callers pass `interactive={false}` to
 * render the badge as a plain <span>; the card link then carries you to the detail
 * header, where the badge is a real link.
 */
export function Heartbeat({
  kind,
  id,
  state,
  interactive = true,
}: {
  kind: "job" | "lead";
  id: string;
  state: HeartbeatState;
  interactive?: boolean;
}) {
  return (
    <span data-testid="heartbeat" data-cold={state.cold} className="inline-flex items-center gap-1.5">
      <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }} data-testid="heartbeat-label">
        {state.label}
      </span>
      {state.cold &&
        (interactive ? (
          <Link href={`/activity?${kind}=${id}`} data-testid="heartbeat-cold" className={BADGE_CLASS} style={BADGE_STYLE}>
            cold
          </Link>
        ) : (
          <span data-testid="heartbeat-cold" className={BADGE_CLASS} style={BADGE_STYLE}>
            cold
          </span>
        ))}
    </span>
  );
}
