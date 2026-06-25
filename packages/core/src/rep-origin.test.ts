import { describe, it, expect } from "vitest";
import { resolveRepOrigin, type RepAppt } from "./rep-origin";

const base = { lat: 33.3, lng: -111.8 };
const office = { lat: 33.4, lng: -111.9 };
const apptA: RepAppt = { startsAt: new Date("2026-07-01T15:00:00Z"), endsAt: new Date("2026-07-01T16:00:00Z"), lat: 33.5, lng: -111.7 };
const apptB: RepAppt = { startsAt: new Date("2026-07-01T17:00:00Z"), endsAt: new Date("2026-07-01T18:00:00Z"), lat: 33.6, lng: -111.6 };

describe("resolveRepOrigin", () => {
  const ref = new Date("2026-07-01T18:30:00Z");

  it("uses the latest same-day appointment that ends before the reference time", () => {
    expect(resolveRepOrigin({ sameDayAppts: [apptA, apptB], reference: ref, repBase: base, tenantOffice: office }))
      .toEqual({ lat: 33.6, lng: -111.6 });
  });
  it("ignores appointments that end after the reference time", () => {
    const early = new Date("2026-07-01T16:30:00Z"); // only apptA has ended
    expect(resolveRepOrigin({ sameDayAppts: [apptA, apptB], reference: early, repBase: base, tenantOffice: office }))
      .toEqual({ lat: 33.5, lng: -111.7 });
  });
  it("falls back to the rep base when no appointment has ended", () => {
    const dawn = new Date("2026-07-01T14:00:00Z");
    expect(resolveRepOrigin({ sameDayAppts: [apptA, apptB], reference: dawn, repBase: base, tenantOffice: office }))
      .toEqual(base);
  });
  it("falls back to the tenant office when there is no base", () => {
    expect(resolveRepOrigin({ sameDayAppts: [], reference: ref, repBase: null, tenantOffice: office }))
      .toEqual(office);
  });
  it("returns null when nothing is resolvable", () => {
    expect(resolveRepOrigin({ sameDayAppts: [], reference: ref, repBase: null, tenantOffice: null }))
      .toBeNull();
  });
});
