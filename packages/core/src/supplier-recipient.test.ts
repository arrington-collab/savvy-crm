import { describe, it, expect } from "vitest";
import { resolveSupplierRecipient, SUPPLIER_SELF_DOMAINS } from "./supplier-recipient";

const opts = { selfDomains: SUPPLIER_SELF_DOMAINS };

describe("resolveSupplierRecipient", () => {
  it("returns a plain valid external address", () => {
    expect(resolveSupplierRecipient("ar@abcsupply.com", opts)).toBe("ar@abcsupply.com");
  });
  it("extracts the bracketed address from a display-name form", () => {
    expect(resolveSupplierRecipient('"ABC Supply AR" <ar@abcsupply.com>', opts)).toBe("ar@abcsupply.com");
  });
  it("trims surrounding whitespace", () => {
    expect(resolveSupplierRecipient("  ar@abcsupply.com  ", opts)).toBe("ar@abcsupply.com");
  });
  it("returns null for a self domain and its subdomains (case-insensitive)", () => {
    expect(resolveSupplierRecipient("billing@getsavvy.com", opts)).toBeNull();
    expect(resolveSupplierRecipient("inv-abc@inbox.getsavvy.com", opts)).toBeNull();
    expect(resolveSupplierRecipient("X@INBOX.GETSAVVY.COM", opts)).toBeNull();
  });
  it("returns null for empty / missing input", () => {
    expect(resolveSupplierRecipient("", opts)).toBeNull();
    expect(resolveSupplierRecipient(null, opts)).toBeNull();
    expect(resolveSupplierRecipient(undefined, opts)).toBeNull();
    expect(resolveSupplierRecipient("   ", opts)).toBeNull();
  });
  it("returns null for malformed addresses", () => {
    expect(resolveSupplierRecipient("abc", opts)).toBeNull();       // no @
    expect(resolveSupplierRecipient("a@b", opts)).toBeNull();       // no dot in domain
    expect(resolveSupplierRecipient("a@b@c.com", opts)).toBeNull(); // two @
    expect(resolveSupplierRecipient("a @b.com", opts)).toBeNull();  // space in local
  });
});
