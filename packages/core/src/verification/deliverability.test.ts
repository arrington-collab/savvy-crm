import { describe, it, expect } from "vitest";
import { makeDeliverabilityCheck, DELIVERY_RATE_FLOOR, SPAM_ERROR_CODE } from "./deliverability";

// Minimal EvidenceCtx stub — only the fields the check uses.
const ctx = (rows: Record<string, unknown>[]) =>
  ({
    tenantId: "t",
    window: { start: new Date(0), end: new Date() },
    db: { query: async () => ({ rows }) },
  }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("comms.deliverability", () => {
  it("fails when not A2P-registered", async () => {
    const check = makeDeliverabilityCheck(async () => ({ registered: false }));
    const r = await check(ctx([]));
    expect(r.status).toBe("fail");
    expect(r.details).toMatch(/not registered/i);
  });

  it("skips when registered but no terminal rows in window", async () => {
    const check = makeDeliverabilityCheck(async () => ({ registered: true }));
    const r = await check(ctx([{ delivered: 0, failed: 0, undelivered: 0, spam: 0 }]));
    expect(r.status).toBe("skip");
  });

  it("passes when delivery rate is above the floor and no spam", async () => {
    const check = makeDeliverabilityCheck(async () => ({ registered: true }));
    const r = await check(ctx([{ delivered: 98, failed: 1, undelivered: 1, spam: 0 }]));
    expect(r.status).toBe("pass");
    expect(r.details).toMatch(/delivery rate/i);
  });

  it("fails when delivery rate is below the floor", async () => {
    const check = makeDeliverabilityCheck(async () => ({ registered: true }));
    // 50/(50+30+20) = 50% < 90%
    const r = await check(ctx([{ delivered: 50, failed: 30, undelivered: 20, spam: 0 }]));
    expect(r.status).toBe("fail");
    expect(r.details).toMatch(/delivery rate/i);
    expect(r.details).toMatch(new RegExp(`${DELIVERY_RATE_FLOOR * 100}`));
  });

  it("fails on a spam error-code even with a high delivery rate", async () => {
    const check = makeDeliverabilityCheck(async () => ({ registered: true }));
    // 99/(99+1+0) = 99%, but 3 spam messages → fail regardless
    const r = await check(ctx([{ delivered: 99, failed: 1, undelivered: 0, spam: 3 }]));
    expect(r.status).toBe("fail");
    expect(r.details).toMatch(new RegExp(SPAM_ERROR_CODE));
  });

  it("exports DELIVERY_RATE_FLOOR = 0.9 and SPAM_ERROR_CODE = '30007'", () => {
    expect(DELIVERY_RATE_FLOOR).toBe(0.9);
    expect(SPAM_ERROR_CODE).toBe("30007");
  });
});
