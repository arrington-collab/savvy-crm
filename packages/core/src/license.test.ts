import { describe, it, expect } from "vitest";
import { resolveActiveLicense, licenseRenewalStatus, type LicenseLike } from "./license";

const NOW = new Date("2026-07-05T00:00:00Z");
const lic = (o: Partial<LicenseLike>): LicenseLike => ({
  state: "AZ", city: null, status: "active", expiresAt: null, ...o,
});

describe("resolveActiveLicense", () => {
  it("state-level license (city null) permits any city in that state", () => {
    const licenses = [lic({ state: "AZ", city: null })];
    expect(resolveActiveLicense(licenses, { state: "AZ", city: "Mesa" }, NOW)).not.toBeNull();
  });

  it("city-specific license permits only that city", () => {
    const licenses = [lic({ state: "CO", city: "Denver" })];
    expect(resolveActiveLicense(licenses, { state: "CO", city: "Denver" }, NOW)).not.toBeNull();
    expect(resolveActiveLicense(licenses, { state: "CO", city: "Aurora" }, NOW)).toBeNull();
  });

  it("excludes expired, suspended, and pending licenses", () => {
    const past = new Date("2026-01-01T00:00:00Z");
    expect(resolveActiveLicense([lic({ expiresAt: past })], { state: "AZ", city: "Mesa" }, NOW)).toBeNull();
    expect(resolveActiveLicense([lic({ status: "suspended" })], { state: "AZ", city: "Mesa" }, NOW)).toBeNull();
    expect(resolveActiveLicense([lic({ status: "pending" })], { state: "AZ", city: "Mesa" }, NOW)).toBeNull();
  });

  it("returns null when no license matches the state", () => {
    expect(resolveActiveLicense([lic({ state: "AZ" })], { state: "CO", city: "Denver" }, NOW)).toBeNull();
  });

  it("returns null for a blank/undefined state (caller owns escape-valve policy)", () => {
    expect(resolveActiveLicense([lic({ state: "AZ" })], { state: null, city: null }, NOW)).toBeNull();
  });

  it("is case/whitespace insensitive on state and city", () => {
    const licenses = [lic({ state: "co", city: "denver " })];
    expect(resolveActiveLicense(licenses, { state: " CO", city: "Denver" }, NOW)).not.toBeNull();
  });
});

describe("licenseRenewalStatus", () => {
  it("ok when no expiry", () => {
    expect(licenseRenewalStatus({ expiresAt: null }, NOW)).toBe("ok");
  });
  it("expired when past expiry", () => {
    expect(licenseRenewalStatus({ expiresAt: new Date("2026-07-04T00:00:00Z") }, NOW)).toBe("expired");
  });
  it("expiring_soon within 60 days", () => {
    expect(licenseRenewalStatus({ expiresAt: new Date("2026-08-01T00:00:00Z") }, NOW)).toBe("expiring_soon");
  });
  it("ok beyond 60 days", () => {
    expect(licenseRenewalStatus({ expiresAt: new Date("2026-12-01T00:00:00Z") }, NOW)).toBe("ok");
  });
});
