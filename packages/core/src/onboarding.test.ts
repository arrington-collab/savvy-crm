import { describe, it, expect } from "vitest";
import {
  parseOnboardingState,
  deriveOnboardingSteps,
  isOnboardingComplete,
  needsOnboarding,
} from "./onboarding.js";

describe("parseOnboardingState", () => {
  it("defaults empty/undefined to not-started, not-dismissed", () => {
    expect(parseOnboardingState(undefined)).toEqual({ requiredCompletedAt: null, dismissed: false });
    expect(parseOnboardingState({})).toEqual({ requiredCompletedAt: null, dismissed: false });
  });
  it("reads a partial object", () => {
    expect(parseOnboardingState({ dismissed: true })).toEqual({ requiredCompletedAt: null, dismissed: true });
  });
  it("reads a full object", () => {
    const iso = "2026-06-18T00:00:00.000Z";
    expect(parseOnboardingState({ requiredCompletedAt: iso, dismissed: false }))
      .toEqual({ requiredCompletedAt: iso, dismissed: false });
  });
  it("ignores unrelated keys", () => {
    expect(parseOnboardingState({ scheduling: { foo: 1 } }))
      .toEqual({ requiredCompletedAt: null, dismissed: false });
  });
});

describe("deriveOnboardingSteps", () => {
  const base = {
    requiredCompletedAt: null,
    revenueBand: null,
    activeUserCount: 1,
    connections: { stripe: false, qbo: false, companycam: false },
  };
  it("all incomplete by default", () => {
    expect(deriveOnboardingSteps(base)).toEqual({ company: false, band: false, team: false, integrations: false });
  });
  it("company true once requiredCompletedAt set", () => {
    expect(deriveOnboardingSteps({ ...base, requiredCompletedAt: "x" }).company).toBe(true);
  });
  it("band true once revenueBand set", () => {
    expect(deriveOnboardingSteps({ ...base, revenueBand: "starter" }).band).toBe(true);
  });
  it("team true once more than one active user", () => {
    expect(deriveOnboardingSteps({ ...base, activeUserCount: 2 }).team).toBe(true);
  });
  it("integrations true if any connection present", () => {
    expect(deriveOnboardingSteps({ ...base, connections: { stripe: true, qbo: false, companycam: false } }).integrations).toBe(true);
    expect(deriveOnboardingSteps({ ...base, connections: { stripe: false, qbo: true, companycam: false } }).integrations).toBe(true);
  });
});

describe("isOnboardingComplete", () => {
  it("true only when all four steps done", () => {
    expect(isOnboardingComplete({ company: true, band: true, team: true, integrations: true })).toBe(true);
    expect(isOnboardingComplete({ company: true, band: true, team: true, integrations: false })).toBe(false);
  });
});

// The (app) layout gate decision behind the 2026-07-06 P0 lockout. Both directions:
// a completed/backfilled tenant renders the app; an un-onboarded tenant is gated.
describe("needsOnboarding (app layout gate)", () => {
  it("does NOT gate a tenant that completed required onboarding", () => {
    expect(needsOnboarding({ requiredCompletedAt: "2026-07-06T00:00:00.000Z" })).toBe(false);
  });

  it("gates a tenant whose required onboarding is not complete", () => {
    expect(needsOnboarding({ requiredCompletedAt: null })).toBe(true);
  });
});
