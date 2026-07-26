import { describe, it, expect, vi } from "vitest";
import { InMemoryStore } from "@savvy/orchestrator";
import { draftMessage, bridgeDripStep } from "./drip";

const ctx = { name: "Jane Homeowner", firstName: "Jane" };
const T = "22222222-2222-2222-2222-222222222222";

describe("draftMessage", () => {
  it("template step: renders body, aiHandled=false, no AI call", async () => {
    const ai = { complete: vi.fn() };
    const res = await draftMessage(
      { step: { stepNum: 1, delayHours: 0, channel: "sms", templateKey: "welcome" }, templateBody: "Hi {{firstName}}!", ctx },
      ai as never,
    );
    expect(res.body).toBe("Hi Jane!");
    expect(res.aiHandled).toBe(false);
    expect(ai.complete).not.toHaveBeenCalled();
  });

  it("AI step: calls the gateway with the step prompt, aiHandled=true", async () => {
    const ai = { complete: vi.fn().mockResolvedValue({ text: "Drafted hello", model: "gemini-flash" }) };
    const res = await draftMessage(
      { step: { stepNum: 2, delayHours: 0, channel: "email", aiPrompt: "Write a friendly nudge" }, ctx },
      ai as never,
    );
    expect(res.body).toBe("Drafted hello");
    expect(res.aiHandled).toBe(true);
    expect(res.model).toBe("gemini-flash");
    expect(ai.complete).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "workhorse" }),
    );
  });

  it("AI step honors an explicit aiCapability", async () => {
    const ai = { complete: vi.fn().mockResolvedValue({ text: "x", model: "claude-sonnet" }) };
    await draftMessage(
      { step: { stepNum: 3, delayHours: 0, channel: "sms", aiPrompt: "nuanced", aiCapability: "reason" }, ctx },
      ai as never,
    );
    expect(ai.complete).toHaveBeenCalledWith(expect.objectContaining({ capability: "reason" }));
  });
});

describe("bridgeDripStep", () => {
  it("publishes drip.step.sent on a sent verdict, no escalation", async () => {
    const store = new InMemoryStore();
    const r = await bridgeDripStep(store, {
      tenantId: T, customerId: "c1", leadId: "l1", step: 2, channel: "sms",
      result: { status: "sent", sid: "SM1" },
    });
    const audit = store.audits.find((x) => x.event.idempotencyKey === "drip.step.sent:c1:2");
    expect(audit).toBeTruthy();
    expect(audit?.event.payload).toMatchObject({ customerId: "c1", leadId: "l1", step: 2, channel: "sms" });
    expect(r.complianceBlock).toBeUndefined();
  });

  it("is idempotent on a sent verdict — a duplicate call does not double-publish", async () => {
    const store = new InMemoryStore();
    const a = { tenantId: T, customerId: "c2", step: 1, channel: "sms" as const, result: { status: "sent" as const, sid: "SM2" } };
    await bridgeDripStep(store, a);
    const before = store.audits.length;
    await bridgeDripStep(store, a);
    expect(store.audits.length).toBe(before);
  });

  it("records exactly one compliance-block escalation on a blocked verdict", async () => {
    const store = new InMemoryStore();
    const r = await bridgeDripStep(store, {
      tenantId: T, customerId: "c3", step: 1, channel: "sms",
      result: { status: "blocked", reason: "a2p_unapproved" },
    });
    expect(r.complianceBlock?.ruleId).toBe("compliance-block");
    expect(store.escalations.filter((e) => e.ruleId === "compliance-block" && e.correlationId === "c3").length).toBe(1);
  });

  it("is idempotent on a blocked verdict — a duplicate call does not double-record the escalation", async () => {
    const store = new InMemoryStore();
    const a = { tenantId: T, customerId: "c4", step: 3, channel: "sms" as const, result: { status: "blocked" as const, reason: "suppressed" as const } };
    const first = await bridgeDripStep(store, a);
    expect(first.complianceBlock?.ruleId).toBe("compliance-block");
    await bridgeDripStep(store, a);
    expect(store.escalations.filter((e) => e.ruleId === "compliance-block").length).toBe(1);
  });

  it("raises no event and no escalation on a deferred verdict", async () => {
    const store = new InMemoryStore();
    const r = await bridgeDripStep(store, {
      tenantId: T, customerId: "c5", step: 1, channel: "sms",
      result: { status: "deferred", untilIso: "2026-07-27T09:00:00.000Z" },
    });
    expect(store.audits.some((x) => x.event.idempotencyKey === "drip.step.sent:c5:1")).toBe(false);
    expect(store.escalations.length).toBe(0);
    expect(r.complianceBlock).toBeUndefined();
  });
});
