import { describe, it, expect } from "vitest";
import { leadIntakeSchema } from "./schemas";

describe("leadIntakeSchema", () => {
  const base = { name: "Jane", phone: "(480) 555-1234", address: "1 Main St, Mesa AZ" };

  it("normalizes phone to E.164 on parse", () => {
    const r = leadIntakeSchema.parse(base);
    expect(r.phone).toBe("+14805551234");
  });
  it("rejects an unparseable phone", () => {
    expect(leadIntakeSchema.safeParse({ ...base, phone: "555" }).success).toBe(false);
  });
  it("defaults source to web and leaves optional fields undefined", () => {
    const r = leadIntakeSchema.parse(base);
    expect(r.source).toBe("web");
    expect(r.city).toBeUndefined();
    expect(r.roofType).toBeUndefined();
  });
  it("accepts the structured optional fields", () => {
    const r = leadIntakeSchema.parse({
      ...base, city: "Mesa", state: "AZ", zip: "85201", county: "Maricopa",
      lat: 33.4, lng: -111.8, roofType: "tile", yearBuilt: 2004,
    });
    expect(r.state).toBe("AZ");
    expect(r.roofType).toBe("tile");
    expect(r.yearBuilt).toBe(2004);
  });
  it("rejects an out-of-range yearBuilt", () => {
    expect(leadIntakeSchema.safeParse({ ...base, yearBuilt: 1500 }).success).toBe(false);
  });
});
