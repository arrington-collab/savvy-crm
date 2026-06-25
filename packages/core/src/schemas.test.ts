import { describe, it, expect } from "vitest";
import { leadIntakeSchema, leadIntakeObject } from "./schemas";

describe("leadIntakeSchema", () => {
  const base = { name: "Jane", address: "1 Main St, Mesa AZ" };
  const withPhone = { ...base, phone: "(480) 555-1234" };

  it("normalizes phone to E.164 on parse", () => {
    const r = leadIntakeSchema.parse(withPhone);
    expect(r.phone).toBe("+14805551234");
  });
  it("rejects an unparseable phone", () => {
    expect(leadIntakeSchema.safeParse({ ...withPhone, phone: "555" }).success).toBe(false);
  });
  it("defaults source to web and leaves optional fields undefined", () => {
    const r = leadIntakeSchema.parse(withPhone);
    expect(r.source).toBe("web");
    expect(r.city).toBeUndefined();
    expect(r.roofType).toBeUndefined();
  });
  it("accepts the structured optional fields", () => {
    const r = leadIntakeSchema.parse({
      ...withPhone, city: "Mesa", state: "AZ", zip: "85201", county: "Maricopa",
      lat: 33.4, lng: -111.8, roofType: "tile", yearBuilt: 2004,
    });
    expect(r.state).toBe("AZ");
    expect(r.roofType).toBe("tile");
    expect(r.yearBuilt).toBe(2004);
  });
  it("rejects an out-of-range yearBuilt", () => {
    expect(leadIntakeSchema.safeParse({ ...withPhone, yearBuilt: 1500 }).success).toBe(false);
  });

  // --- email-on-leads ---
  it("accepts a phone-only lead", () => {
    expect(leadIntakeSchema.safeParse(withPhone).success).toBe(true);
  });
  it("accepts an email-only lead (no phone)", () => {
    const r = leadIntakeSchema.parse({ ...base, email: "jane@example.com" });
    expect(r.email).toBe("jane@example.com");
    expect(r.phone).toBeUndefined();
  });
  it("rejects a lead with neither phone nor email", () => {
    const res = leadIntakeSchema.safeParse(base);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues[0]?.message).toBe("Add a phone or email");
  });
  it("rejects a malformed email", () => {
    expect(leadIntakeSchema.safeParse({ ...base, email: "not-an-email" }).success).toBe(false);
  });
  it("lowercases and trims the email", () => {
    const r = leadIntakeSchema.parse({ ...base, email: "  Jane@Example.COM  " });
    expect(r.email).toBe("jane@example.com");
  });
  it("treats a blank email as omitted (not a validation error) when phone is present", () => {
    const r = leadIntakeSchema.parse({ ...withPhone, email: "   " });
    expect(r.email).toBeUndefined();
  });
  it("exposes an extendable object schema (for /api/leads composition)", () => {
    expect(typeof (leadIntakeObject as { extend?: unknown }).extend).toBe("function");
  });
});
