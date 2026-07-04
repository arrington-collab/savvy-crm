import { describe, it, expect } from "vitest";
import { parseInboxToken } from "./supplier-invoice";

describe("parseInboxToken", () => {
  it("extracts the token from a well-formed inbox address", () => {
    expect(parseInboxToken("inv-abc123XYZ@inbox.getsavvy.com")).toBe("abc123XYZ");
  });
  it("is case-insensitive on the local-part prefix and domain", () => {
    expect(parseInboxToken("INV-abc123@INBOX.GetSavvy.com")).toBe("abc123");
  });
  it("tolerates display-name / angle-bracket forms", () => {
    expect(parseInboxToken('"ABC Supply" <inv-tok9@inbox.getsavvy.com>')).toBe("tok9");
  });
  it("returns null for a non-inbox address", () => {
    expect(parseInboxToken("sales@abcsupply.com")).toBeNull();
    expect(parseInboxToken("inv-@inbox.getsavvy.com")).toBeNull(); // empty token
    expect(parseInboxToken("")).toBeNull();
  });
});
