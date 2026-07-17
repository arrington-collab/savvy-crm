// Customer for Life slice 1: the touch governor. A past customer should never
// feel like a transaction — so EVERY post-completion program schedules through
// this calendar, a hard rolling-year cap keeps the relationship sparse, and
// priority resolves conflicts the owner's way. Nothing sends outside it.

export const TOUCH_PRIORITY = [
  "storm_check",
  "credit_checkin",
  "move_play",
  // Phase 26 S5 fill plays: revenue-recovering, so above the standing cadence —
  // but never safety-critical, so they refuse at cap when nothing is displaceable.
  "fill_discount",
  "fill_repair",
  "roofiversary",
  "holiday_card",
  // Phase 20: renewal is retention (above the acquisition offer); winback last.
  "maintenance_renewal",
  "maintenance_offer",
  "maintenance_winback",
] as const;

export type TouchProgram = (typeof TOUCH_PRIORITY)[number] | "referral" | "custom";
export type TouchChannel = "text" | "postcard" | "letter" | "email";

export type TouchRequest = {
  program: string;
  channel: string;
  scheduledFor: Date;
};

export type ExistingTouch = {
  program: string;
  channel: string;
  scheduledFor: Date;
  sentAt: Date | null;
};

export type GovernorConfig = {
  capPerYear: number; // default 5 outside active jobs/claims
  optOuts: Partial<Record<string, boolean>>; // per channel
};

export type GovernorVerdict =
  | { admit: true; displace?: { program: string; scheduledFor: Date } }
  | { admit: false; reason: "opt_out" | "cap_exceeded" };

function priorityRank(program: string): number {
  const idx = (TOUCH_PRIORITY as readonly string[]).indexOf(program);
  return idx === -1 ? TOUCH_PRIORITY.length : idx; // unknown programs rank lowest
}

const ROLLING_YEAR_MS = 365.25 * 86_400_000;

/**
 * Pure admission decision. The rolling-year window counts SENT touches and
 * SCHEDULED-future touches; at the cap, a higher-priority request displaces the
 * lowest-priority scheduled (never sent — history is history) touch below it.
 * When nothing is displaceable, the two highest-priority programs (storm_check,
 * credit_checkin — the reasons the program exists) admit over cap; the rest refuse.
 */
export function governTouchRequest(
  request: TouchRequest,
  existing: ExistingTouch[],
  config: GovernorConfig,
  now: Date,
): GovernorVerdict {
  if (config.optOuts[request.channel]) return { admit: false, reason: "opt_out" };

  const windowStart = new Date(now.getTime() - ROLLING_YEAR_MS);
  const inWindow = existing.filter((t) => {
    const at = t.sentAt ?? t.scheduledFor;
    return at >= windowStart;
  });
  if (inWindow.length < config.capPerYear) return { admit: true };

  // At the cap: find the lowest-priority SCHEDULED (unsent) touch strictly
  // below the request's priority.
  const reqRank = priorityRank(request.program);
  const displaceable = inWindow
    .filter((t) => !t.sentAt && priorityRank(t.program) > reqRank)
    .sort((a, b) => priorityRank(b.program) - priorityRank(a.program))[0];
  if (displaceable) {
    return { admit: true, displace: { program: displaceable.program, scheduledFor: displaceable.scheduledFor } };
  }

  // Safety-critical programs never bounce off the cap.
  if (request.program === "storm_check" || request.program === "credit_checkin") {
    return { admit: true };
  }
  return { admit: false, reason: "cap_exceeded" };
}
