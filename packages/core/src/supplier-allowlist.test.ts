import { describe, it, expect } from "vitest";
import { isRecipientAllowed } from "./supplier-allowlist";

describe("isRecipientAllowed", () => {
  it("allows any recipient when the list is empty (opt-in restriction)", () => {
    expect(isRecipientAllowed("ar@abcsupply.com", [])).toBe(true);
  });
  it("allows a recipient whose domain is in the list (case-insensitive)", () => {
    expect(isRecipientAllowed("ar@abcsupply.com", ["abcsupply.com"])).toBe(true);
    expect(isRecipientAllowed("AR@ABCSupply.com", ["abcsupply.com"])).toBe(true);
    expect(isRecipientAllowed("ar@abcsupply.com", ["ABCSUPPLY.COM"])).toBe(true);
  });
  it("blocks a recipient whose domain is not in a non-empty list", () => {
    expect(isRecipientAllowed("ar@evil.com", ["abcsupply.com"])).toBe(false);
    expect(isRecipientAllowed("ar@srs.com", ["abcsupply.com", "beacon.com"])).toBe(false);
  });
  it("blocks a malformed recipient against a non-empty list", () => {
    expect(isRecipientAllowed("not-an-email", ["abcsupply.com"])).toBe(false);
    expect(isRecipientAllowed("", ["abcsupply.com"])).toBe(false);
  });
});
