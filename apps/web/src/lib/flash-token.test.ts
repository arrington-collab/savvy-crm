import { it, expect, vi, afterEach } from "vitest";
import { signPayloadToken } from "@savvy/core";
import { signFlashToken, verifyFlashToken } from "./flash-token";

afterEach(() => {
  vi.useRealTimers();
});

it("round-trips a freshly signed token", () => {
  const token = signFlashToken("tenant-1", "2026-07-25");
  expect(verifyFlashToken(token)).toEqual({ tenantId: "tenant-1", businessDate: "2026-07-25" });
});

it("rejects a tampered token", () => {
  const token = signFlashToken("tenant-1", "2026-07-25");
  const tampered = token.slice(0, -2) + (token.at(-2) === "a" ? "b" : "a") + token.at(-1);
  expect(verifyFlashToken(tampered)).toBeNull();
});

it("rejects an expired token", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const token = signFlashToken("tenant-1", "2026-01-01");
  vi.setSystemTime(new Date("2026-03-01T00:00:00Z")); // > 30-day TTL past signing
  expect(verifyFlashToken(token)).toBeNull();
});

it("rejects a well-signed token of a different kind", () => {
  // Same secret family (UNSUBSCRIBE_SECRET, dev fallback), different purpose —
  // must not be accepted by the flash verifier just because the fields overlap.
  const secret = "dev-unsubscribe-secret";
  const otherKindToken = signPayloadToken(
    { tenantId: "tenant-1", businessDate: "2026-07-25", kind: "not-flash", exp: String(Date.now() + 1000) },
    secret,
  );
  expect(verifyFlashToken(otherKindToken)).toBeNull();
});
