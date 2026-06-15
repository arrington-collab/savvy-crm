import { describe, it, expect, test } from "vitest";
import { isStopKeyword, signUnsubToken, verifyUnsubToken, isCancelKeyword, signPayloadToken, verifyPayloadToken } from "./comms";

describe("isStopKeyword", () => {
  it("matches STOP/UNSUBSCRIBE case-insensitively, trimmed (cancel removed in Phase 4)", () => {
    for (const w of ["STOP", "stop", " Stop ", "UNSUBSCRIBE"]) {
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

test("cancel is no longer an opt-out keyword", () => {
  expect(isStopKeyword("STOP")).toBe(true);
  expect(isStopKeyword("unsubscribe")).toBe(true);
  expect(isStopKeyword("cancel")).toBe(false);
});

test("isCancelKeyword matches CANCEL only", () => {
  expect(isCancelKeyword("CANCEL")).toBe(true);
  expect(isCancelKeyword(" cancel ")).toBe(true);
  expect(isCancelKeyword("stop")).toBe(false);
});

test("payload token round-trips and rejects tampering", () => {
  const secret = "s3cret";
  const tok = signPayloadToken({ appointmentId: "a1", tenantId: "t1", type: "inspection" }, secret);
  expect(verifyPayloadToken(tok, secret)).toEqual({ appointmentId: "a1", tenantId: "t1", type: "inspection" });
  expect(verifyPayloadToken(tok, "wrong")).toBeNull();
  expect(verifyPayloadToken("garbage", secret)).toBeNull();
});
