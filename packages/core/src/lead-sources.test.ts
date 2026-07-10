import { describe, it, expect } from "vitest";
import { DEFAULT_LEAD_SOURCES, mergeLeadSources, LEAD_SOURCE_VALUES, MACHINE_LEAD_SOURCES, AD_PLATFORM_VALUES, isMachineSource, leadSourceDetailSchema } from "./lead-sources";

describe("lead sources", () => {
  it("ships a non-empty default list including referral", () => {
    expect(DEFAULT_LEAD_SOURCES.length).toBeGreaterThan(5);
    expect(DEFAULT_LEAD_SOURCES.some((s) => s.value === "referral")).toBe(true);
  });
  it("appends custom sources, skipping case-insensitive duplicates", () => {
    const merged = mergeLeadSources(["Home Show", "REFERRAL", "Home Show"]);
    const values = merged.map((s) => s.value);
    expect(values).toContain("Home Show");
    expect(values.filter((v) => v.toLowerCase() === "home show").length).toBe(1);
    expect(values.filter((v) => v.toLowerCase() === "referral").length).toBe(1);
  });
  it("handles null/undefined custom list", () => {
    expect(mergeLeadSources(null).length).toBe(DEFAULT_LEAD_SOURCES.length);
  });
});

describe("lead source taxonomy", () => {
  it("has the 6 human + 4 machine members", () => {
    expect(LEAD_SOURCE_VALUES).toEqual(["referral","insurance_agent","ads","realtor","partner","other","web","inbound_call","canvass","direct_mail"]);
    expect(MACHINE_LEAD_SOURCES).toEqual(["web","inbound_call","canvass","direct_mail"]);
    expect(AD_PLATFORM_VALUES).toContain("google_lsa");
  });
  it("classifies machine vs human sources", () => {
    expect(isMachineSource("web")).toBe(true);
    expect(isMachineSource("referral")).toBe(false);
  });
});

describe("leadSourceDetailSchema", () => {
  it("referral requires referrer_name; accepts optional fee cents", () => {
    expect(leadSourceDetailSchema("referral").safeParse({ referrer_name: "Jo", referral_fee_cents: 5000 }).success).toBe(true);
    expect(leadSourceDetailSchema("referral").safeParse({}).success).toBe(false);
  });
  it("ads requires a known platform", () => {
    expect(leadSourceDetailSchema("ads").safeParse({ platform: "meta" }).success).toBe(true);
    expect(leadSourceDetailSchema("ads").safeParse({ platform: "tiktok" }).success).toBe(false);
  });
  it("insurance_agent requires agency; realtor requires name; partner requires name", () => {
    expect(leadSourceDetailSchema("insurance_agent").safeParse({ agency: "Acme" }).success).toBe(true);
    expect(leadSourceDetailSchema("realtor").safeParse({ name: "Sue" }).success).toBe(true);
    expect(leadSourceDetailSchema("partner").safeParse({ name: "P" }).success).toBe(true);
  });
  it("other allows note/custom label and empty; machine sources take no detail (null ok)", () => {
    expect(leadSourceDetailSchema("other").safeParse({ note: "yard sign" }).success).toBe(true);
    expect(leadSourceDetailSchema("other").safeParse({ custom_label: "Home Show" }).success).toBe(true);
    expect(leadSourceDetailSchema("web").safeParse(null).success).toBe(true);
  });
});
