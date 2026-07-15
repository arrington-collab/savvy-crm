import { describe, it, expect } from "vitest";
import {
  normalizePartnerName,
  partnerKey,
  isPartnerSource,
  partnerClassForSource,
  PARTNER_CLASS_VALUES,
  PARTNER_SOURCE_VALUES,
} from "./partner";
import { leadIntakeSchema } from "./schemas";

describe("normalizePartnerName", () => {
  it("folds case and collapses whitespace", () => {
    expect(normalizePartnerName("  Jane   SMITH ")).toBe("jane smith");
  });

  it("folds punctuation and separators so brand spellings match", () => {
    expect(normalizePartnerName("RE/MAX")).toBe(normalizePartnerName("RE-MAX"));
    expect(normalizePartnerName("RE/MAX")).toBe(normalizePartnerName("Re Max"));
  });

  it("strips trailing org suffixes", () => {
    expect(normalizePartnerName("Acme Insurance LLC")).toBe("acme insurance");
    expect(normalizePartnerName("Acme Insurance, Inc.")).toBe("acme insurance");
    expect(normalizePartnerName("Acme Insurance Co")).toBe("acme insurance");
  });

  it("does not strip suffix-like words mid-name", () => {
    expect(normalizePartnerName("Incline Village Homes")).toBe("incline village homes");
    expect(normalizePartnerName("Coop Realty Group")).toBe("coop realty group");
  });

  it("returns empty string for blank input", () => {
    expect(normalizePartnerName("   ")).toBe("");
  });
});

describe("partnerKey", () => {
  it("is stable across case/whitespace/suffix variants of name + org", () => {
    expect(partnerKey("Jane Smith", "RE/MAX")).toBe(partnerKey("jane  smith", "RE-MAX"));
    expect(partnerKey("Acme Insurance LLC", null)).toBe(partnerKey("acme insurance", undefined));
  });

  it("distinguishes same name at different orgs (never fold distinct humans)", () => {
    expect(partnerKey("Jane Smith", "RE/MAX")).not.toBe(partnerKey("Jane Smith", "Keller Williams"));
  });
});

describe("partner source classification", () => {
  it("partner-class sources require attribution", () => {
    expect(PARTNER_SOURCE_VALUES).toEqual(["realtor", "insurance_agent", "partner"]);
    expect(isPartnerSource("realtor")).toBe(true);
    expect(isPartnerSource("insurance_agent")).toBe(true);
    expect(isPartnerSource("partner")).toBe(true);
  });

  it("non-partner sources are exempt", () => {
    expect(isPartnerSource("referral")).toBe(false);
    expect(isPartnerSource("web")).toBe(false);
    expect(isPartnerSource("ads")).toBe(false);
  });

  it("maps lead source to a partner class", () => {
    expect(partnerClassForSource("realtor")).toBe("realtor");
    expect(partnerClassForSource("insurance_agent")).toBe("insurance_agent");
    expect(partnerClassForSource("partner")).toBe("other");
    expect(PARTNER_CLASS_VALUES).toEqual(["realtor", "insurance_agent", "property_manager", "other"]);
  });
});

describe("leadIntakeSchema partner attribution (red path)", () => {
  const base = { name: "Homeowner", phone: "602-555-0100", address: "123 Main St, Phoenix AZ" };

  it("REJECTS a partner-class source with free-text detail only (no partner ref)", () => {
    const r = leadIntakeSchema.safeParse({ ...base, source: "realtor", sourceDetail: { name: "Jane Smith" } });
    expect(r.success).toBe(false);
  });

  it("REJECTS a partner-class source with no partner info at all", () => {
    const r = leadIntakeSchema.safeParse({ ...base, source: "insurance_agent" });
    expect(r.success).toBe(false);
  });

  it("accepts a partner-class source with a partnerId (typeahead pick)", () => {
    const r = leadIntakeSchema.safeParse({
      ...base,
      source: "realtor",
      partnerId: "018f6d2e-0000-7000-8000-000000000000",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a partner-class source with an inline create-once partner", () => {
    const r = leadIntakeSchema.safeParse({
      ...base,
      source: "realtor",
      partner: { name: "Jane Smith", org: "RE/MAX" },
    });
    expect(r.success).toBe(true);
  });

  it("leaves referral and machine sources untouched", () => {
    expect(
      leadIntakeSchema.safeParse({ ...base, source: "referral", sourceDetail: { referrer_name: "Uncle Bob" } }).success,
    ).toBe(true);
    expect(leadIntakeSchema.safeParse({ ...base, source: "web" }).success).toBe(true);
  });
});
