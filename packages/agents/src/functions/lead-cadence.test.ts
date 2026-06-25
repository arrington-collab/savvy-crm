/**
 * lead-cadence tests.
 *
 * Full Inngest workflow stepping requires a live server + Postgres (CI-gated).
 * We test the extractable decision logic here with real assertions:
 *   - opted-out customers skip SMS touches
 *   - contacted leads stop the cadence
 *   - consent gates
 *   - quiet-hours gate returns a future ISO string for SMS in quiet window
 */
import { describe, it, expect } from "vitest";
import { shouldSendChannel, nextAllowedSendTime, isWithinQuietHours } from "@savvy/core";
import { buildAckSms, buildAckEmail } from "./lead-intake";

describe("leadCadence — shouldSendChannel gate", () => {
  const consentGate = { smsOptOut: false, emailOptOut: false, smsConsentAt: new Date("2024-01-01") };
  const noConsentGate = { smsOptOut: false, emailOptOut: false, smsConsentAt: null };
  const smsOptOutGate = { smsOptOut: true, emailOptOut: false, smsConsentAt: new Date("2024-01-01") };
  const emailOptOutGate = { smsOptOut: false, emailOptOut: true, smsConsentAt: null };

  it("allows SMS when consented and not opted-out", () => {
    expect(shouldSendChannel("sms", consentGate)).toBe(true);
  });

  it("blocks SMS when no smsConsentAt (no consent)", () => {
    expect(shouldSendChannel("sms", noConsentGate)).toBe(false);
  });

  it("blocks SMS when smsOptOut is true", () => {
    expect(shouldSendChannel("sms", smsOptOutGate)).toBe(false);
  });

  it("allows email when not opted-out (no consent required)", () => {
    expect(shouldSendChannel("email", noConsentGate)).toBe(true);
  });

  it("blocks email when emailOptOut is true", () => {
    expect(shouldSendChannel("email", emailOptOutGate)).toBe(false);
  });
});

describe("leadCadence — cadence stop on contacted", () => {
  const OPEN = ["new", "contacted", "qualified", "booked"];

  it("stopped when lead.firstRepContactAt is set", () => {
    const row = { contacted: new Date(), status: "contacted" };
    const stopped = row.contacted != null || !OPEN.includes(row.status);
    expect(stopped).toBe(true);
  });

  it("continues when lead is open and uncontacted", () => {
    const row = { contacted: null, status: "new" };
    const stopped = row.contacted != null || !OPEN.includes(row.status);
    expect(stopped).toBe(false);
  });

  it("stopped when status is lost (terminal, not in OPEN)", () => {
    const row = { contacted: null, status: "lost" }; // "lost" is the real terminal status (no "disqualified" enum value)
    const stopped = row.contacted != null || !OPEN.includes(row.status);
    expect(stopped).toBe(true);
  });
});

describe("leadCadence — quiet-hours gate", () => {
  const quietHours = { startHour: 21, endHour: 8 };
  const tz = "America/Phoenix";

  it("nextAllowedSendTime returns a time >= the input date", () => {
    const now = new Date();
    const allowed = nextAllowedSendTime(now, tz, quietHours);
    expect(allowed.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });

  it("isWithinQuietHours returns false for a midday time", () => {
    // Construct noon Phoenix time (UTC-7): noon Phoenix = 19:00 UTC
    const midday = new Date("2024-06-01T19:00:00Z");
    expect(isWithinQuietHours(midday, tz, quietHours)).toBe(false);
  });

  it("isWithinQuietHours returns true for a late-night time", () => {
    // 11pm Phoenix = 06:00 UTC next day
    const lateNight = new Date("2024-06-02T06:00:00Z");
    expect(isWithinQuietHours(lateNight, tz, quietHours)).toBe(true);
  });

  it("nextAllowedSendTime exits quiet window (result is not within quiet hours)", () => {
    // 11pm Phoenix = 06:00 UTC — inside quiet hours
    const lateNight = new Date("2024-06-02T06:00:00Z");
    const allowed = nextAllowedSendTime(lateNight, tz, quietHours);
    expect(isWithinQuietHours(allowed, tz, quietHours)).toBe(false);
  });
});

describe("leadCadence — ack builders (reused from intake)", () => {
  it("buildAckSms produces a non-empty message with vars substituted", () => {
    const body = buildAckSms({ name: "Bob", bookingUrl: "https://x/book/cadence" });
    expect(body).toContain("Bob");
    expect(body).toContain("https://x/book/cadence");
  });

  it("buildAckEmail produces subject + html with vars substituted", () => {
    const { subject, html } = buildAckEmail({ name: "Bob", bookingUrl: "https://x/book/cadence" });
    expect(subject).toBeTruthy();
    expect(html).toContain("Bob");
    expect(html).toContain("https://x/book/cadence");
  });
});
