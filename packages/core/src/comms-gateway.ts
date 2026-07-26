import { shouldSendChannel } from "./lead-followup";
import { isWithinQuietHours, nextAllowedSendTime, type QuietHours } from "./quiet-hours";

export type GuardVerdict =
  | { status: "allow" }
  | { status: "deferred"; untilIso: string }
  | { status: "blocked"; reason: "suppressed" | "no_consent" | "a2p_unapproved" | "cap_exceeded" };

export interface GuardInput {
  channel: "sms" | "email";
  suppressed: boolean;
  consent: { smsOptOut: boolean; emailOptOut: boolean; smsConsentAt: Date | null };
  a2pApproved: boolean;
  quiet: { tz: string; now: Date; qh: QuietHours } | null;
  cap: { verdict: "admit" | "cap_exceeded" | "opt_out" };
}

// Pure compliance gate for outbound comms. No I/O — callers resolve suppression,
// consent, A2P approval, and cap verdicts, then this enforces fail-closed order:
// suppressed -> no_consent -> a2p_unapproved (sms only) -> quiet-hours (deferred) -> cap_exceeded -> allow.
export function evaluateGuard(i: GuardInput): GuardVerdict {
  if (i.suppressed) return { status: "blocked", reason: "suppressed" };
  if (!shouldSendChannel(i.channel, i.consent)) return { status: "blocked", reason: "no_consent" };
  if (i.channel === "sms" && !i.a2pApproved) return { status: "blocked", reason: "a2p_unapproved" };
  if (i.quiet && isWithinQuietHours(i.quiet.now, i.quiet.tz, i.quiet.qh)) {
    return { status: "deferred", untilIso: nextAllowedSendTime(i.quiet.now, i.quiet.tz, i.quiet.qh).toISOString() };
  }
  if (i.cap.verdict !== "admit") return { status: "blocked", reason: "cap_exceeded" };
  return { status: "allow" };
}
