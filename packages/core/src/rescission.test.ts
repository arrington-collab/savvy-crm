import { describe, expect, it } from "vitest";
import { rescissionDaysFor, rescissionReleaseAt, isRescissionHeld } from "./rescission";

describe("rescissionDaysFor", () => {
  it("statutory defaults + fallback + tenant override", () => {
    expect(rescissionDaysFor("CO")).toBe(10);
    expect(rescissionDaysFor("AZ")).toBe(3);
    expect(rescissionDaysFor("TX")).toBe(3); // fallback
    expect(rescissionDaysFor(null)).toBe(3); // fallback
    expect(rescissionDaysFor("AZ", { AZ: 5 })).toBe(5); // override wins
  });
});

describe("rescissionReleaseAt (00:00 in tenant tz on signingDate + N days)", () => {
  const tz = "America/Phoenix"; // UTC-7, no DST
  it("AZ 3 days from a Phoenix-afternoon signing", () => {
    const signedAt = new Date("2026-07-04T21:00:00.000Z"); // 2026-07-04 14:00 Phoenix
    expect(rescissionReleaseAt({ state: "AZ", signedAt, timezone: tz }).toISOString()).toBe("2026-07-07T07:00:00.000Z");
  });
  it("CO 10 days", () => {
    const signedAt = new Date("2026-07-04T21:00:00.000Z");
    expect(rescissionReleaseAt({ state: "CO", signedAt, timezone: tz }).toISOString()).toBe("2026-07-14T07:00:00.000Z");
  });
  it("tenant override changes N", () => {
    const signedAt = new Date("2026-07-04T21:00:00.000Z");
    expect(rescissionReleaseAt({ state: "AZ", signedAt, timezone: tz, config: { AZ: 1 } }).toISOString()).toBe("2026-07-05T07:00:00.000Z");
  });
});

describe("isRescissionHeld (auto-release)", () => {
  const hold = new Date("2026-07-07T07:00:00.000Z");
  it("null hold → never held", () => expect(isRescissionHeld(null, new Date())).toBe(false));
  it("now before hold → held", () => expect(isRescissionHeld(hold, new Date("2026-07-06T00:00:00Z"))).toBe(true));
  it("now at/after hold → released", () => {
    expect(isRescissionHeld(hold, hold)).toBe(false);
    expect(isRescissionHeld(hold, new Date("2026-07-08T00:00:00Z"))).toBe(false);
  });
});
