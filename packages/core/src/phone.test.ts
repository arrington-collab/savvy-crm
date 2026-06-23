import { describe, it, expect } from "vitest";
import { normalizePhone, formatPhoneDisplay } from "./phone";

describe("normalizePhone", () => {
  it("normalizes a 10-digit US number", () => {
    expect(normalizePhone("4805551234")).toBe("+14805551234");
  });
  it("strips formatting characters", () => {
    expect(normalizePhone("(480) 555-1234")).toBe("+14805551234");
    expect(normalizePhone("480.555.1234")).toBe("+14805551234");
    expect(normalizePhone(" 480 555 1234 ")).toBe("+14805551234");
  });
  it("handles 11-digit numbers starting with 1", () => {
    expect(normalizePhone("14805551234")).toBe("+14805551234");
    expect(normalizePhone("1 (480) 555-1234")).toBe("+14805551234");
  });
  it("passes through valid E.164", () => {
    expect(normalizePhone("+14805551234")).toBe("+14805551234");
    expect(normalizePhone("+447911123456")).toBe("+447911123456");
  });
  it("rejects garbage / too-short / too-long", () => {
    expect(normalizePhone("555")).toBeNull();
    expect(normalizePhone("abc")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("123456789012345678")).toBeNull();
  });
});

describe("formatPhoneDisplay", () => {
  it("formats US E.164 to (xxx) xxx-xxxx", () => {
    expect(formatPhoneDisplay("+14805551234")).toBe("(480) 555-1234");
  });
  it("returns non-US E.164 unchanged", () => {
    expect(formatPhoneDisplay("+447911123456")).toBe("+447911123456");
  });
  it("returns empty string for empty input", () => {
    expect(formatPhoneDisplay("")).toBe("");
  });
});
