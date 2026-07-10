import { describe, it, expect } from "vitest";
import { leadIntakeSchema } from "./schemas";

const base = { name: "Jo", phone: "4805551234", address: "1 Test St, Mesa AZ" };

describe("leadIntakeSchema — structured source", () => {
  it("rejects a missing source (no longer defaults to web)", () => {
    expect(leadIntakeSchema.safeParse({ ...base }).success).toBe(false);
  });
  it("rejects an unknown source", () => {
    expect(leadIntakeSchema.safeParse({ ...base, source: "tiktok" }).success).toBe(false);
  });
  it("accepts a referral with matching detail", () => {
    expect(leadIntakeSchema.safeParse({ ...base, source: "referral", sourceDetail: { referrer_name: "Sue", referral_fee_cents: 10000 } }).success).toBe(true);
  });
  it("rejects a referral whose detail is missing referrer_name", () => {
    expect(leadIntakeSchema.safeParse({ ...base, source: "referral", sourceDetail: {} }).success).toBe(false);
  });
  it("accepts a machine source with no detail", () => {
    expect(leadIntakeSchema.safeParse({ ...base, source: "web" }).success).toBe(true);
  });
});
