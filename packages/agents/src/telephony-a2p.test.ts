import { it, expect } from "vitest";
import { resolveA2pApproved } from "./telephony";

// This helper's real logic was previously untested (the gateway tests inject
// a2pApproved directly), which let a demo-only check ship that blocked every
// non-demo tenant's SMS in dev/CI/mock-prod. These pin the intended behavior.

it("allows the demo/mock sender (from === 'mock')", () => {
  expect(resolveA2pApproved("t1", "mock", {})).toBe(true);
  // even with real Twilio configured, the mock sender never hits a carrier
  expect(resolveA2pApproved("t1", "mock", { TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "x" })).toBe(true);
});

it("allows a platform send when NO real Twilio is configured (dev/CI/mock-prod)", () => {
  expect(resolveA2pApproved("t1", "+15555550000", {})).toBe(true);
  expect(resolveA2pApproved("t1", "+15555550000", { TWILIO_ACCOUNT_SID: "AC" })).toBe(true); // token missing
  expect(resolveA2pApproved("t1", "+15555550000", { TWILIO_AUTH_TOKEN: "x" })).toBe(true); // sid missing
});

it("fails closed for a real platform Twilio send until the A2P field lands", () => {
  expect(resolveA2pApproved("t1", "+15551234567", { TWILIO_ACCOUNT_SID: "ACxxxx", TWILIO_AUTH_TOKEN: "secret" })).toBe(false);
});
