import { describe, it, expect } from "vitest";
import { InMemoryStore } from "@savvy/orchestrator";
import { bridgeFirstTouch, bridgeAssignment } from "./lead-intake";

const T = "11111111-1111-1111-1111-111111111111";

describe("bridgeFirstTouch", () => {
  it("publishes lead.first_touch and queues a compliance-block on a blocked send", async () => {
    const store = new InMemoryStore();
    const r = await bridgeFirstTouch(store, {
      tenantId: T, leadId: "l1", latencySeconds: 12,
      occurredAtLeadCreated: "2026-07-26T10:00:00.000Z",
      result: { status: "blocked", reason: "a2p_unapproved" },
    });
    expect(store.audits.some((x) => x.event.idempotencyKey === "lead.first_touch:l1")).toBe(true);
    expect(r.complianceBlock?.ruleId).toBe("compliance-block");
    expect(store.escalations.some((e) => e.ruleId === "compliance-block" && e.correlationId === "l1")).toBe(true);
  });

  it("marks quietHoursDeferred when the send was deferred, and raises no compliance-block", async () => {
    const store = new InMemoryStore();
    const r = await bridgeFirstTouch(store, {
      tenantId: T, leadId: "l2", latencySeconds: 3,
      occurredAtLeadCreated: "2026-07-26T10:00:00.000Z",
      result: { status: "deferred", untilIso: "2026-07-26T15:00:00.000Z" },
    });
    const audit = store.audits.find((x) => x.event.idempotencyKey === "lead.first_touch:l2");
    expect(audit).toBeTruthy();
    expect(audit?.event.payload).toMatchObject({ quietHoursDeferred: true, latencySeconds: 3, slaLatencySeconds: 3 });
    expect(r.complianceBlock).toBeUndefined();
  });

  it("publishes with quietHoursDeferred=false on a normal sent ack", async () => {
    const store = new InMemoryStore();
    const r = await bridgeFirstTouch(store, {
      tenantId: T, leadId: "l3", latencySeconds: 45,
      occurredAtLeadCreated: "2026-07-26T10:00:00.000Z",
      result: { status: "sent", sid: "SM123" },
    });
    const audit = store.audits.find((x) => x.event.idempotencyKey === "lead.first_touch:l3");
    expect(audit?.event.payload).toMatchObject({ quietHoursDeferred: false });
    expect(r.complianceBlock).toBeUndefined();
  });

  it("is idempotent — a second call with the same leadId does not double-publish", async () => {
    const store = new InMemoryStore();
    await bridgeFirstTouch(store, { tenantId: T, leadId: "l4", latencySeconds: 1, occurredAtLeadCreated: "2026-07-26T10:00:00.000Z", result: { status: "sent", sid: "SM1" } });
    const before = store.audits.length;
    await bridgeFirstTouch(store, { tenantId: T, leadId: "l4", latencySeconds: 1, occurredAtLeadCreated: "2026-07-26T10:00:00.000Z", result: { status: "sent", sid: "SM1" } });
    expect(store.audits.length).toBe(before);
  });
});

describe("bridgeAssignment", () => {
  it("publishes lead.assigned when a rep was assigned", async () => {
    const store = new InMemoryStore();
    const r = await bridgeAssignment(store, { tenantId: T, leadId: "l1", result: { assigned: "rep-1", reason: "assigned" } });
    const audit = store.audits.find((x) => x.event.idempotencyKey === "lead.assigned:l1");
    expect(audit).toBeTruthy();
    expect(audit?.event.payload).toMatchObject({ leadId: "l1", userId: "rep-1" });
    expect(r.assignmentFailed).toBeUndefined();
  });

  it("publishes lead.assignment_failed and returns the assignment-failure escalation on no-candidate", async () => {
    const store = new InMemoryStore();
    const r = await bridgeAssignment(store, { tenantId: T, leadId: "l2", result: { assigned: null, reason: "no-candidate" } });
    const audit = store.audits.find((x) => x.event.idempotencyKey === "lead.assignment_failed:l2");
    expect(audit).toBeTruthy();
    expect(r.assignmentFailed?.ruleId).toBe("assignment-failure");
    expect(store.escalations.some((e) => e.ruleId === "assignment-failure" && e.correlationId === "l2")).toBe(true);
  });

  it("does NOT treat an intentionally disabled assignment strategy as a failure", async () => {
    const store = new InMemoryStore();
    const r = await bridgeAssignment(store, { tenantId: T, leadId: "l3", result: { assigned: null, reason: "off" } });
    expect(store.audits.some((x) => x.event.idempotencyKey.startsWith("lead.assignment_failed"))).toBe(false);
    expect(r.assignmentFailed).toBeUndefined();
  });

  it("does NOT treat an already-assigned lead as a failure", async () => {
    const store = new InMemoryStore();
    const r = await bridgeAssignment(store, { tenantId: T, leadId: "l4", result: { assigned: null, reason: "already-assigned" } });
    expect(store.audits.some((x) => x.event.idempotencyKey.startsWith("lead.assignment_failed"))).toBe(false);
    expect(r.assignmentFailed).toBeUndefined();
  });
});
