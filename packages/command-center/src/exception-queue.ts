import type { EscalationRecord } from "@savvy/orchestrator";

export type QueueState = "open" | "acknowledged" | "resolved" | "snoozed";

export interface QueueItem {
  key: string; // `${escalationId}:${idempotencyKey}`
  escalationId: string;
  idempotencyKey: string;
  ruleId: string;
  severity: string;
  reason: string;
  notify: string[];
  assignee: string;
  state: QueueState;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  snoozeUntil: string | null;
  createdAt: string;
}

// EscalationRecord as delivered to the queue also carries the source escalation's
// own id + the triggering event's idempotencyKey (added by the intake caller).
type IntakeRecord = EscalationRecord & { id: string; idempotencyKey: string };

export class ExceptionQueue {
  private items = new Map<string, QueueItem>();

  intake(esc: IntakeRecord, at: string): QueueItem {
    const key = `${esc.id}:${esc.idempotencyKey}`;
    const existing = this.items.get(key);
    if (existing) return existing; // idempotent
    const item: QueueItem = {
      key, escalationId: esc.id, idempotencyKey: esc.idempotencyKey, ruleId: esc.ruleId,
      severity: esc.severity, reason: esc.reason, notify: esc.notify,
      assignee: esc.notify[0] ?? "unassigned",
      state: "open", acknowledgedAt: null, resolvedAt: null, resolutionNote: null, snoozeUntil: null, createdAt: at,
    };
    this.items.set(key, item);
    return item;
  }

  acknowledge(key: string, assignee: string, at: string): void {
    const it = this.items.get(key); if (!it) return;
    it.state = "acknowledged"; it.assignee = assignee; it.acknowledgedAt = at;
  }

  resolve(key: string, note: string, at: string): void {
    const it = this.items.get(key); if (!it) return;
    it.state = "resolved"; it.resolutionNote = note; it.resolvedAt = at;
  }

  snooze(key: string, until: string, at: string): void {
    const it = this.items.get(key); if (!it) return;
    it.state = "snoozed"; it.snoozeUntil = until; it.acknowledgedAt = at;
  }

  /** Items needing THIS assignee's attention now: open, or snoozed past their snoozeUntil. */
  needsYou(assignee: string, now: Date): QueueItem[] {
    return [...this.items.values()].filter((it) => it.assignee === assignee && this.isActive(it, now));
  }

  openCount(now: Date): { total: number; bySeverity: Record<string, number> } {
    const active = [...this.items.values()].filter((it) => this.isActive(it, now));
    const bySeverity: Record<string, number> = {};
    for (const it of active) bySeverity[it.severity] = (bySeverity[it.severity] ?? 0) + 1;
    return { total: active.length, bySeverity };
  }

  all(): QueueItem[] { return [...this.items.values()]; }

  // "Active" = needs attention: strictly open, or a snooze whose time has passed.
  // acknowledged/resolved are not active. A snooze still in the future is not active.
  private isActive(it: QueueItem, now: Date): boolean {
    if (it.state === "open") return true;
    if (it.state === "snoozed" && it.snoozeUntil && new Date(it.snoozeUntil) <= now) return true;
    return false;
  }
}
