import { describe, it, expect } from "vitest";
import { MESSAGE_CHANNEL, DRIP_STATUS, DRIP_STOP_REASON, AI_DRAFT_CAPABILITY } from "./enums";

describe("phase 3 enums", () => {
  it("message channel is sms|email only (no call)", () => {
    expect(MESSAGE_CHANNEL).toEqual(["sms", "email"]);
  });
  it("drip status + stop reasons", () => {
    expect(DRIP_STATUS).toEqual(["active", "stopped", "completed"]);
    expect(DRIP_STOP_REASON).toEqual(["reply", "converted", "opted_out", "manual"]);
  });
  it("ai draft capabilities", () => {
    expect(AI_DRAFT_CAPABILITY).toEqual(["reason", "summarize"]);
  });
});
