import { describe, it, expect } from "vitest";
import { buildSpokenQueue, voiceActionVerb } from "./voice";

describe("voiceActionVerb", () => {
  it("maps actions to spoken phrases", () => {
    expect(voiceActionVerb("approve_estimate")).toBe("approve the estimate");
    expect(voiceActionVerb("send_invoice")).toBe("send the invoice");
    expect(voiceActionVerb(null)).toBe("review");
  });
});

describe("buildSpokenQueue", () => {
  it("reads an all-clear line when there is nothing to do", () => {
    expect(buildSpokenQueue([])).toBe("You're all clear — nothing needs you right now.");
  });

  it("numbers each item with a spoken action and a closing instruction", () => {
    const spoken = buildSpokenQueue([
      { title: "Kowalski", action: "approve_estimate" },
      { title: "Yates", action: "send_invoice" },
    ]);
    expect(spoken).toContain("You have 2 items.");
    expect(spoken).toContain("1: approve the estimate for Kowalski.");
    expect(spoken).toContain("2: send the invoice for Yates.");
    expect(spoken).toContain('say "detail" and a number');
  });

  it("uses the singular for one item", () => {
    expect(buildSpokenQueue([{ title: "Kowalski", action: "approve_estimate" }])).toContain("You have 1 item.");
  });
});
