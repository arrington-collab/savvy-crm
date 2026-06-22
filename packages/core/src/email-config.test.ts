import { describe, it, expect } from "vitest";
import { parseEmailConfig } from "./email-config";

describe("parseEmailConfig", () => {
  it("defaults to an empty config", () => {
    expect(parseEmailConfig(undefined)).toEqual({});
    expect(parseEmailConfig({})).toEqual({});
    expect(parseEmailConfig(null)).toEqual({});
  });
  it("reads gmailConnectionId when present", () => {
    expect(parseEmailConfig({ gmailConnectionId: "conn_123" })).toEqual({ gmailConnectionId: "conn_123" });
  });
  it("ignores unknown keys and wrong types", () => {
    expect(parseEmailConfig({ gmailConnectionId: 42, other: "x" })).toEqual({});
  });
});
