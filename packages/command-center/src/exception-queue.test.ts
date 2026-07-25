import { it, expect } from "vitest";
import { ExceptionQueue } from "./exception-queue";
import type { EscalationRecord } from "@savvy/orchestrator";

const T = "11111111-1111-1111-1111-111111111111";
function esc(over: Partial<EscalationRecord> = {}): EscalationRecord {
  return { tenantId: T, correlationId: "c", eventId: "e1", eventType: "estimate.approved",
    ruleId: "low-margin", severity: "high", reason: "18% margin", notify: ["arrington", "sales-manager"], ...over } as EscalationRecord;
}

it("intake is idempotent on (escalationId, idempotencyKey)", () => {
  const q = new ExceptionQueue();
  const e = { ...esc(), id: "esc1", idempotencyKey: "k1" } as never;
  q.intake(e, "2026-07-01T18:00:00Z");
  q.intake(e, "2026-07-01T18:00:00Z");
  expect(q.all()).toHaveLength(1);
});

it("routes assignee from notify[0] and surfaces arrington items in needsYou", () => {
  const q = new ExceptionQueue();
  q.intake({ ...esc(), id: "esc1", idempotencyKey: "k1" } as never, "2026-07-01T18:00:00Z");
  const mine = q.needsYou("arrington", new Date("2026-07-01T19:00:00Z"));
  expect(mine).toHaveLength(1);
  expect(mine[0]!.assignee).toBe("arrington");
});

it("acknowledge leaves open but keeps the record; resolve never deletes", () => {
  const q = new ExceptionQueue();
  const item = q.intake({ ...esc(), id: "esc1", idempotencyKey: "k1" } as never, "2026-07-01T18:00:00Z");
  q.acknowledge(item.key, "arrington", "2026-07-01T18:05:00Z");
  expect(q.needsYou("arrington", new Date("2026-07-01T19:00:00Z"))).toHaveLength(0); // acknowledged leaves open
  q.resolve(item.key, "fixed pricing", "2026-07-01T18:10:00Z");
  const all = q.all();
  expect(all).toHaveLength(1); // not deleted
  expect(all[0]!.state).toBe("resolved");
  expect(all[0]!.resolutionNote).toBe("fixed pricing");
});

it("snooze drops it off needsYou until snoozeUntil passes", () => {
  const q = new ExceptionQueue();
  const item = q.intake({ ...esc(), id: "esc1", idempotencyKey: "k1" } as never, "2026-07-01T18:00:00Z");
  q.snooze(item.key, "2026-07-02T18:00:00Z", "2026-07-01T18:05:00Z");
  expect(q.needsYou("arrington", new Date("2026-07-01T20:00:00Z"))).toHaveLength(0); // snoozed
  expect(q.needsYou("arrington", new Date("2026-07-03T00:00:00Z"))).toHaveLength(1); // snooze elapsed
  expect(q.all()).toHaveLength(1); // never deleted
});

it("openCount groups by severity", () => {
  const q = new ExceptionQueue();
  q.intake({ ...esc(), id: "a", idempotencyKey: "1", severity: "high" } as never, "2026-07-01T18:00:00Z");
  q.intake({ ...esc(), id: "b", idempotencyKey: "2", severity: "medium", notify: ["claims"] } as never, "2026-07-01T18:00:00Z");
  const c = q.openCount(new Date("2026-07-01T19:00:00Z"));
  expect(c.total).toBe(2);
  expect(c.bySeverity).toEqual({ high: 1, medium: 1 });
});
