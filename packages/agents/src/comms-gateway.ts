import { evaluateGuard, type GuardVerdict, type QuietHours } from "@savvy/core";
import type { SmsSender } from "@savvy/integrations";

export type GuardedSmsResult =
  | { status: "sent"; sid: string }
  | { status: "deferred"; untilIso: string }
  | { status: "blocked"; reason: "suppressed" | "no_consent" | "a2p_unapproved" | "cap_exceeded" };

export interface GuardedSmsDeps {
  isSuppressed: (a: {
    tenantId: string;
    contactId?: string;
    phoneE164?: string;
    channel: "sms";
  }) => Promise<boolean>;
  sms: SmsSender;
  smsFrom: () => string;
}

export interface GuardedSmsArgs {
  tenantId: string;
  channel: "sms";
  to: string;
  from?: string;
  body: string;
  consent: { smsOptOut: boolean; emailOptOut: boolean; smsConsentAt: Date | null };
  a2pApproved: boolean;
  quiet?: { tz: string; qh: QuietHours };
  now?: Date;
  capVerdict?: "admit" | "cap_exceeded" | "opt_out";
  contactId?: string;
}

// The single wired chokepoint for outbound SMS: resolves suppression, runs the
// pure compliance guard (@savvy/core evaluateGuard), and ONLY sends through the
// injected SmsSender on an "allow" verdict. `new Date()` as the default `now`
// is fine here (unlike the pure Day-1/Day-2 logic) because this runs inside an
// Inngest step at actual send time; tests inject `now` for determinism.
export async function guardedSms(deps: GuardedSmsDeps, a: GuardedSmsArgs): Promise<GuardedSmsResult> {
  const suppressed = await deps.isSuppressed({
    tenantId: a.tenantId,
    contactId: a.contactId,
    phoneE164: a.to,
    channel: "sms",
  });
  const verdict: GuardVerdict = evaluateGuard({
    channel: "sms",
    suppressed,
    consent: a.consent,
    a2pApproved: a.a2pApproved,
    quiet: a.quiet ? { tz: a.quiet.tz, now: a.now ?? new Date(), qh: a.quiet.qh } : null,
    cap: { verdict: a.capVerdict ?? "admit" },
  });
  if (verdict.status === "deferred") return verdict;
  if (verdict.status === "blocked") return verdict;
  const res = await deps.sms.sendSms({ to: a.to, from: a.from ?? deps.smsFrom(), body: a.body });
  return { status: "sent", sid: res.sid };
}
