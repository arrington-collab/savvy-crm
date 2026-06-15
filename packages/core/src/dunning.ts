export type DunningTone = "gentle" | "firmer" | "firm" | "final";

export interface DunningStep {
  stepNum: number;
  dayOffset: number;
  channel: "email" | "sms";
  tone: DunningTone;
  flipsOverdue: boolean;
}

export function dunningSchedule(opts: { smsEscalationDay: number }): DunningStep[] {
  return [
    { stepNum: 1, dayOffset: 3, channel: "email", tone: "gentle", flipsOverdue: false },
    { stepNum: 2, dayOffset: 7, channel: "email", tone: "firmer", flipsOverdue: false },
    { stepNum: 3, dayOffset: 14, channel: "email", tone: "firm", flipsOverdue: false },
    { stepNum: 4, dayOffset: opts.smsEscalationDay, channel: "sms", tone: "final", flipsOverdue: true },
  ];
}

function dollars(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

const TONE_LEAD: Record<DunningTone, string> = {
  gentle: "Just a friendly reminder that",
  firmer: "We wanted to follow up — ",
  firm: "Our records show that",
  final: "FINAL NOTICE: ",
};

export interface DunningEmailOpts {
  tone: DunningTone;
  number: string;
  payUrl: string;
  amountCents: number;
}

export interface DunningEmailResult {
  subject: string;
  html: string;
}

export function dunningEmail(o: DunningEmailOpts): DunningEmailResult {
  const subjectByTone: Record<DunningTone, string> = {
    gentle: `Reminder: invoice ${o.number}`,
    firmer: `Following up on invoice ${o.number}`,
    firm: `Past due: invoice ${o.number}`,
    final: `Final notice: invoice ${o.number} is overdue`,
  };
  const html =
    `<p>${TONE_LEAD[o.tone]} invoice <strong>${o.number}</strong> for ${dollars(o.amountCents)} ` +
    `is awaiting payment.</p><p><a href="${o.payUrl}">Pay now</a></p>`;
  return { subject: subjectByTone[o.tone], html };
}

export interface DunningSmsOpts {
  number: string;
  payUrl: string;
}

export function dunningSms(o: DunningSmsOpts): string {
  return `Invoice ${o.number} is overdue. Pay here: ${o.payUrl}. Reply STOP to opt out.`;
}
