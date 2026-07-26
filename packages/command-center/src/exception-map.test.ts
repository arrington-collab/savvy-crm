import { it, expect } from "vitest";
import { escalationToQueueItem } from "./exception-map";

const esc = { ruleId: "compliance-block", severity: "high" as const, reason: "SMS blocked: a2p_unapproved", notify: ["ops"], tenantId: "t", correlationId: "l1", eventId: "e1", eventType: "lead.first_touch" };

it("maps an escalation record to an open queue item with a stable key", () => {
  const it0 = escalationToQueueItem(esc, "2026-07-26T10:00:00.000Z");
  expect(it0.key).toBe("compliance-block:e1");
  expect(it0.state).toBe("open");
  expect(it0.assignee).toBe("ops");
  expect(it0.severity).toBe("high");
});

it("defaults assignee to unassigned when notify is empty", () => {
  expect(escalationToQueueItem({ ...esc, notify: [] }, "2026-07-26T10:00:00.000Z").assignee).toBe("unassigned");
});
