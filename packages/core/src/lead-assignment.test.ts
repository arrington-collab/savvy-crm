import { describe, it, test, expect } from "vitest";
import { parseAssignmentConfig, assignmentConfigSchema } from "./lead-assignment";

describe("parseAssignmentConfig", () => {
  it("defaults to territory for null/garbage", () => {
    expect(parseAssignmentConfig(null).strategy).toBe("territory");
    expect(parseAssignmentConfig({ strategy: "nonsense" }).strategy).toBe("territory");
    expect(parseAssignmentConfig(undefined).strategy).toBe("territory");
  });
  it("accepts a valid territory config", () => {
    const c = parseAssignmentConfig({ strategy: "territory", territoryRules: [{ state: "AZ", city: "Mesa", userId: "u1" }] });
    expect(c.strategy).toBe("territory");
    expect(c.territoryRules?.[0]?.userId).toBe("u1");
  });
  it("accepts a valid score config", () => {
    const c = parseAssignmentConfig({ strategy: "score", scoreTiers: [{ minScore: 80, userIds: ["u1", "u2"] }] });
    expect(c.scoreTiers?.[0]?.minScore).toBe(80);
  });
});

describe("assignmentConfigSchema", () => {
  it("rejects an out-of-range minScore", () => {
    expect(assignmentConfigSchema.safeParse({ strategy: "score", scoreTiers: [{ minScore: 200, userIds: ["u1"] }] }).success).toBe(false);
  });
});

test("defaults to territory strategy (zip→round-robin live booking)", () => {
  expect(parseAssignmentConfig(undefined).strategy).toBe("territory");
  expect(parseAssignmentConfig({ bogus: true }).strategy).toBe("territory");
});
