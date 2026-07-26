import type { EscalationRecord } from "@savvy/orchestrator";
import type { QueueItem } from "./exception-queue";

// Pure projector: turns an orchestrator EscalationRecord into an open
// QueueItem, mirroring ExceptionQueue.intake's field construction exactly so
// the DB-backed path (@savvy/db recordException) and the in-memory path
// (ExceptionQueue.intake) always agree on shape.
export function escalationToQueueItem(esc: EscalationRecord, at: string): QueueItem {
  return {
    key: `${esc.ruleId}:${esc.eventId}`,
    ruleId: esc.ruleId,
    eventId: esc.eventId,
    severity: esc.severity,
    reason: esc.reason,
    notify: esc.notify,
    assignee: esc.notify[0] ?? "unassigned",
    state: "open",
    acknowledgedAt: null,
    resolvedAt: null,
    resolutionNote: null,
    snoozeUntil: null,
    createdAt: at,
  };
}
