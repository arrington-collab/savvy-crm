import { describe, it, expect } from "vitest";
import { parseInboxToken, deriveInboxAddress, selectJobCost } from "./supplier-invoice";

describe("selectJobCost", () => {
  it("uses supplier-invoice actuals when present", () => {
    expect(selectJobCost({ actualsCents: 812300, estimateCents: 790000 })).toBe(812300);
  });
  it("falls back to the material-order estimate when no actuals", () => {
    expect(selectJobCost({ actualsCents: null, estimateCents: 790000 })).toBe(790000);
    expect(selectJobCost({ actualsCents: 0, estimateCents: 790000 })).toBe(790000);
  });
});

describe("deriveInboxAddress", () => {
  it("builds the address from a token + default domain", () => {
    expect(deriveInboxAddress("abc123")).toBe("inv-abc123@inbox.getsavvy.com");
  });
  it("round-trips with parseInboxToken", () => {
    expect(parseInboxToken(deriveInboxAddress("Tok9Z"))).toBe("Tok9Z");
  });
});

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
