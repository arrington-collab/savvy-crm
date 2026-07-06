import { describe, expect, it } from "vitest";
import {
  ENDORSEMENT_STATUS,
  businessDaysBetween,
  endorsementNeeded,
  isEndorsementIdle,
} from "./endorsement";

const d = (iso: string) => new Date(iso);

describe("businessDaysBetween", () => {
  it("counts weekdays in (from, to], skipping the weekend", () => {
    // Mon 2026-07-06 → Mon 2026-07-13 = Tue,Wed,Thu,Fri,Mon = 5
    expect(businessDaysBetween(d("2026-07-06T12:00:00Z"), d("2026-07-13T12:00:00Z"))).toBe(5);
    // Fri → following Mon = just Mon = 1 (Sat/Sun skipped)
    expect(businessDaysBetween(d("2026-07-10T12:00:00Z"), d("2026-07-13T12:00:00Z"))).toBe(1);
  });

  it("is 0 for same-day or reversed ranges", () => {
    expect(businessDaysBetween(d("2026-07-06T09:00:00Z"), d("2026-07-06T18:00:00Z"))).toBe(0);
    expect(businessDaysBetween(d("2026-07-13T00:00:00Z"), d("2026-07-06T00:00:00Z"))).toBe(0);
  });
});

describe("endorsementNeeded (lender co-payee detection)", () => {
  it("is true when a lender co-payee name is present", () => {
    expect(endorsementNeeded({ lenderName: "Wells Fargo Home Mortgage" })).toBe(true);
  });
  it("is false with no lender", () => {
    expect(endorsementNeeded({ lenderName: null })).toBe(false);
    expect(endorsementNeeded({ lenderName: "  " })).toBe(false);
    expect(endorsementNeeded({})).toBe(false);
  });
});

describe("isEndorsementIdle (5-business-day no-idle invariant)", () => {
  const now = d("2026-07-13T12:00:00Z"); // Monday

  it("flags an open endorsement idle beyond 5 business days", () => {
    // last action Fri 2026-07-03 → Mon 07-13: Mon06..Fri10(5)+Mon13(1)=6 > 5
    expect(isEndorsementIdle("requested", d("2026-07-03T12:00:00Z"), now)).toBe(true);
  });

  it("does not flag within 5 business days", () => {
    // last action Mon 2026-07-06 → Mon 07-13 = exactly 5, not > 5
    expect(isEndorsementIdle("needed", d("2026-07-06T12:00:00Z"), now)).toBe(false);
  });

  it("only applies to open endorsement states (needed/requested)", () => {
    expect(isEndorsementIdle("received", d("2000-01-01T00:00:00Z"), now)).toBe(false);
    expect(isEndorsementIdle("none", d("2000-01-01T00:00:00Z"), now)).toBe(false);
    expect(isEndorsementIdle("not_applicable", d("2000-01-01T00:00:00Z"), now)).toBe(false);
  });

  it("treats a never-touched open endorsement (null lastActionAt) as idle from `fallback`", () => {
    expect(isEndorsementIdle("needed", null, now, 5, d("2026-07-03T12:00:00Z"))).toBe(true);
    expect(ENDORSEMENT_STATUS).toContain("needed");
  });
});
