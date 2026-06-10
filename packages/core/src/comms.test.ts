import { describe, it, expect } from "vitest";
import { isStopKeyword, signUnsubToken, verifyUnsubToken } from "./comms";

describe("isStopKeyword", () => {
  it("matches STOP/UNSUBSCRIBE/CANCEL case-insensitively, trimmed", () => {
    for (const w of ["STOP", "stop", " Stop ", "UNSUBSCRIBE", "cancel"]) {
      expect(isStopKeyword(w)).toBe(true);
    }
  });
  it("does not match ordinary replies", () => {
    expect(isStopKeyword("Yes please book me")).toBe(false);
    expect(isStopKeyword("stopwatch")).toBe(false);
  });
});

describe("unsubscribe token", () => {
  const secret = "test-secret";
  it("round-trips a customerId", () => {
    const tok = signUnsubToken("cust-123", secret);
    expect(verifyUnsubToken(tok, secret)).toBe("cust-123");
  });
  it("rejects a tampered token", () => {
    const tok = signUnsubToken("cust-123", secret);
    expect(verifyUnsubToken(tok + "x", secret)).toBeNull();
    expect(verifyUnsubToken(tok, "wrong-secret")).toBeNull();
  });
});
