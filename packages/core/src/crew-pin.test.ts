import { describe, it, expect } from "vitest";
import { hashPin, verifyPin } from "./crew-pin.js";

describe("crew-pin", () => {
  it("verifies a correct pin and rejects a wrong one", () => {
    const stored = hashPin("4821");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(verifyPin("4821", stored)).toBe(true);
    expect(verifyPin("0000", stored)).toBe(false);
  });
  it("rejects null/garbage stored values", () => {
    expect(verifyPin("4821", null)).toBe(false);
    expect(verifyPin("4821", "garbage")).toBe(false);
    expect(verifyPin("4821", "scrypt$abc")).toBe(false);
  });
  it("produces a different salt each call", () => {
    expect(hashPin("4821")).not.toBe(hashPin("4821"));
  });
});
