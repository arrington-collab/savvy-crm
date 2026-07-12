import { describe, it, expect } from "vitest";
import { usdCents, requiresConfirm, confirmPrompt } from "./confirm";
import type { SageDigestItem } from "./types";

const estimate = (over: Partial<SageDigestItem> = {}): SageDigestItem => ({
  kind: "estimate_approval",
  entityId: "est1",
  jobId: "job1",
  title: "Kowalski",
  detail: "estimate",
  action: "approve_estimate",
  confirmAmountCents: 3275000,
  ...over,
});

describe("usdCents", () => {
  it("formats cents as rounded USD with thousands separators", () => {
    expect(usdCents(3275000)).toBe("$32,750");
    expect(usdCents(840000)).toBe("$8,400");
    expect(usdCents(0)).toBe("$0");
  });
});

describe("requiresConfirm", () => {
  it("requires confirm for a money action above the threshold", () => {
    expect(requiresConfirm(estimate(), { approvalThresholdCents: 2500000 })).toBe(true);
  });

  it("does not require confirm when the amount is at or below the threshold", () => {
    expect(requiresConfirm(estimate(), { approvalThresholdCents: 5000000 })).toBe(false);
  });

  it("does not require confirm when the tenant set no threshold", () => {
    expect(requiresConfirm(estimate(), { approvalThresholdCents: null })).toBe(false);
  });

  it("never requires confirm for non-money actions", () => {
    const task = estimate({ action: "complete_task", confirmAmountCents: null });
    const credit = estimate({ action: "send_credit", confirmAmountCents: 900000 });
    expect(requiresConfirm(task, { approvalThresholdCents: 1 })).toBe(false);
    expect(requiresConfirm(credit, { approvalThresholdCents: 1 })).toBe(false);
  });

  it("requires confirm for an overdue invoice above the threshold", () => {
    const inv = estimate({ action: "send_invoice", title: "Yates", confirmAmountCents: 840000 });
    expect(requiresConfirm(inv, { approvalThresholdCents: 500000 })).toBe(true);
  });
});

describe("confirmPrompt", () => {
  it("names the amount, noun, and customer for an estimate", () => {
    expect(confirmPrompt(estimate())).toBe("Reply YES to approve $32,750 estimate to Kowalski");
  });

  it("names the amount, noun, and customer for an invoice", () => {
    const inv = estimate({ action: "send_invoice", title: "Yates", confirmAmountCents: 840000 });
    expect(confirmPrompt(inv)).toBe("Reply YES to send $8,400 invoice to Yates");
  });
});
