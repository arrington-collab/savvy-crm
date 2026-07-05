import { describe, expect, it } from "vitest";
import { allowedCanvassOrigin, canvassContractObject } from "./canvass";

const valid = {
  customer: { name: "Jane Homeowner", phone: "480-555-0100", address: "12 Elm St, Mesa AZ" },
  contract: {
    kind: "insurance",
    document: "Insurance Proposal Contract",
    fields: { "Claim #": "CLM-1", "Deductible ($)": "2500" },
    scopeItems: ["Final inspection"],
    rep: "Marcus R.",
    signedAt: "2026-07-04T20:00:00.000Z",
    consentElectronic: true,
    integrityHash: "a".repeat(64),
    signaturePng: "data:image/png;base64,iVBORw0KGgo=",
  },
} as const;

describe("canvassContractObject", () => {
  it("accepts a valid payload and normalizes the phone", () => {
    const p = canvassContractObject.parse(valid);
    expect(p.customer.phone).toBe("+14805550100");
    expect(p.contract.kind).toBe("insurance");
    expect(p.contract.fields["Claim #"]).toBe("CLM-1");
  });

  it("rejects a payload without e-records consent", () => {
    const r = canvassContractObject.safeParse({
      ...valid,
      contract: { ...valid.contract, consentElectronic: false },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-PNG signature", () => {
    const r = canvassContractObject.safeParse({
      ...valid,
      contract: { ...valid.contract, signaturePng: "data:image/jpeg;base64,x" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown contract kinds", () => {
    const r = canvassContractObject.safeParse({
      ...valid,
      contract: { ...valid.contract, kind: "commercial" },
    });
    expect(r.success).toBe(false);
  });

  it("defaults fields and scopeItems when omitted", () => {
    const { fields: _f, scopeItems: _s, ...rest } = valid.contract;
    const p = canvassContractObject.parse({ ...valid, contract: rest });
    expect(p.contract.fields).toEqual({});
    expect(p.contract.scopeItems).toEqual([]);
  });

  it("rejects a malformed integrity hash", () => {
    const r = canvassContractObject.safeParse({
      ...valid,
      contract: { ...valid.contract, integrityHash: "not-a-hash" },
    });
    expect(r.success).toBe(false);
  });
});

describe("allowedCanvassOrigin", () => {
  const origin = "https://canvass.alta.example";

  it("echoes any origin when the allowlist is unset", () => {
    expect(allowedCanvassOrigin(origin, undefined)).toBe(origin);
    expect(allowedCanvassOrigin(null, undefined)).toBe("*");
  });

  it("echoes any origin when the allowlist contains a wildcard", () => {
    expect(allowedCanvassOrigin(origin, "https://a.com, *")).toBe(origin);
  });

  it("echoes an origin that is on the allowlist", () => {
    expect(allowedCanvassOrigin(origin, `https://other.com, ${origin}`)).toBe(origin);
  });

  it("denies an origin that is not on the allowlist", () => {
    expect(allowedCanvassOrigin("https://evil.example", "https://other.com")).toBeNull();
    expect(allowedCanvassOrigin(null, "https://other.com")).toBeNull();
  });
});
