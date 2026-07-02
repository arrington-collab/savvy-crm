import type { TaskException } from "./task-exception";

/**
 * The batched owner notification. Human attention arrives batched: exceptions
 * queue into scheduled digest sessions, and only break-glass severity interrupts
 * the day. Pure — the message is unit-tested; delivery (SMS/email) is separate.
 */
export interface DigestMessage {
  subject: string;
  body: string;
  count: number;
  totalMinutes: number;
}

export function buildDigestMessage(exceptions: TaskException[]): DigestMessage | null {
  if (exceptions.length === 0) return null; // never send an empty digest
  const count = exceptions.length;
  const totalMinutes = Math.round(exceptions.reduce((sum, e) => sum + e.estFounderMinutes, 0));
  const top = exceptions[0]!; // already ranked: highest-priority first
  const noun = count === 1 ? "task needs" : "tasks need";
  return {
    subject: `Savvy: ${count} ${noun} attention`,
    body: `${count} ${noun} attention (~${totalMinutes} min). Top: ${top.title} — ${top.detail}.`,
    count,
    totalMinutes,
  };
}

/**
 * The break-glass page — the ONLY exception that interrupts the day instead of
 * waiting for a digest. Fired for exceptions whose dollar impact clears the
 * tenant's break-glass threshold. Pure: the message is unit-tested; delivery
 * (immediate SMS/email) is separate. Ranks by dollar impact so the biggest-money
 * problem leads.
 */
export interface BreakGlassItem {
  taskId: number;
  title: string;
  dollarImpactCents: number;
}

export interface BreakGlassMessage {
  subject: string;
  body: string;
  count: number;
  totalDollars: number;
}

export function buildBreakGlassMessage(items: BreakGlassItem[]): BreakGlassMessage | null {
  if (items.length === 0) return null; // never page an empty alert
  const count = items.length;
  const totalDollars = Math.round(items.reduce((sum, i) => sum + i.dollarImpactCents, 0) / 100);
  const top = [...items].sort((a, b) => b.dollarImpactCents - a.dollarImpactCents)[0]!;
  const topDollars = Math.round(top.dollarImpactCents / 100);
  const noun = count === 1 ? "issue needs" : "issues need";
  const dollars = (n: number) => `$${n.toLocaleString("en-US")}`;
  return {
    subject: `🚨 Savvy break-glass: ${count} ${count === 1 ? "issue" : "issues"} (${dollars(totalDollars)})`,
    body: `🚨 ${count} break-glass ${noun} you now (~${dollars(totalDollars)} at risk). Top: ${top.title} — ${dollars(topDollars)}.`,
    count,
    totalDollars,
  };
}
