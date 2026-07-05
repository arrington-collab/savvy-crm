import { describe, it, expect } from "vitest";
import { isA2pRegistered } from "./a2p";

describe("isA2pRegistered", () => {
  it("false when connection inactive", () => {
    expect(isA2pRegistered({ brandStatus: "verified", campaignStatus: "verified", messagingServiceSid: "MG1" }, false)).toBe(false);
  });
  it("false when no messaging service", () => {
    expect(isA2pRegistered({ brandStatus: "verified", campaignStatus: "verified", messagingServiceSid: null }, true)).toBe(false);
  });
  it("false when campaign not in registered set", () => {
    expect(isA2pRegistered({ brandStatus: "verified", campaignStatus: "pending", messagingServiceSid: "MG1" }, true)).toBe(false);
  });
  it("true when active + messaging service + campaign registered", () => {
    expect(isA2pRegistered({ brandStatus: "verified", campaignStatus: "verified", messagingServiceSid: "MG1" }, true)).toBe(true);
  });
  it("false for null state", () => {
    expect(isA2pRegistered(null, true)).toBe(false);
  });
});
