// Estimate Experience slice 4: the 60-second rep race — pure decision logic.
// A hot page signal notifies the assigned rep; if the rep doesn't engage
// within 60 seconds, NOVA texts the homeowner. Owner choreography, settled
// with data by raceMetrics.

export interface RaceEvent {
  kind: string;
  sessionId?: string | null;
  createdAt: Date;
}

const RETURN_VISIT_GAP_MS = 30 * 60_000;

/** Hot = first open ever, or a NEW session after 30+ quiet minutes (a return
 *  visit). Same-session re-opens and rapid multi-tab opens are not hot. */
export function isHotSignal(events: RaceEvent[], sessionId: string): boolean {
  const opens = events.filter((e) => e.kind === "open");
  if (opens.length === 0) return true;
  if (opens.some((e) => e.sessionId === sessionId)) return false;
  const lastOpen = Math.max(...opens.map((e) => e.createdAt.getTime()));
  return Date.now() - lastOpen >= RETURN_VISIT_GAP_MS;
}

/** Throttle: one race per browsing session, max one per customer per day. */
export function raceAllowed(events: RaceEvent[], sessionId: string, now = new Date()): boolean {
  const races = events.filter((e) => e.kind === "race_rep_notified");
  if (races.some((e) => e.sessionId === sessionId)) return false;
  const dayAgo = now.getTime() - 24 * 60 * 60_000;
  return !races.some((e) => e.createdAt.getTime() >= dayAgo);
}

export interface RaceMetrics {
  races: number;
  repAcked: number;
  repAckRateBps: number;
  repAckedCloseRateBps: number | null;
  novaTextedCloseRateBps: number | null;
}

const rate = (num: number, den: number): number => Math.round((num / den) * 10_000);

/** Per-estimate race outcomes → the numbers that settle the choreography:
 *  rep 60s response rate, and close rate split by who answered the open. */
export function raceMetrics(
  estimates: { events: RaceEvent[]; accepted: boolean }[],
): RaceMetrics {
  let races = 0;
  let repAcked = 0;
  let repAckedClosed = 0;
  let novaTexted = 0;
  let novaTextedClosed = 0;

  for (const est of estimates) {
    const notified = est.events.filter((e) => e.kind === "race_rep_notified");
    if (notified.length === 0) continue;
    races += 1;

    const firstNotify = Math.min(...notified.map((e) => e.createdAt.getTime()));
    const ackedIn60 = est.events.some(
      (e) => e.kind === "race_rep_ack" && e.createdAt.getTime() - firstNotify <= 60_000,
    );
    if (ackedIn60) {
      repAcked += 1;
      if (est.accepted) repAckedClosed += 1;
    } else if (est.events.some((e) => e.kind === "race_nova_text")) {
      novaTexted += 1;
      if (est.accepted) novaTextedClosed += 1;
    }
  }

  return {
    races,
    repAcked,
    repAckRateBps: races ? rate(repAcked, races) : 0,
    repAckedCloseRateBps: repAcked ? rate(repAckedClosed, repAcked) : null,
    novaTextedCloseRateBps: novaTexted ? rate(novaTextedClosed, novaTexted) : null,
  };
}
