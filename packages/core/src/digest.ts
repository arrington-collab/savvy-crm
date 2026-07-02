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
