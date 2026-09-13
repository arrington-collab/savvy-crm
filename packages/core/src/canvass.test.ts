import { describe, expect, it } from "vitest";
import { allowedCanvassOrigin, canvassContractObject, canvassKnockObject, canvassLoginObject, canvassRepCreateObject, canvassHaversineMeters as haversineMeters, CANVASS_GPS_FLAG_METERS } from "./canvass";

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
  const origin = "https://canvass.example";

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

  // Wildcard subdomains: onboarding a customer must not require an env edit
  // plus a production redeploy of the whole CRM.
  describe("wildcard subdomains", () => {
    const list = "https://*.knockjockey.com";
    it("matches any subdomain of the wildcard zone", () => {
      expect(allowedCanvassOrigin("https://pestkee.knockjockey.com", list)).toBe("https://pestkee.knockjockey.com");
      expect(allowedCanvassOrigin("https://acme-pest.knockjockey.com", list)).toBe("https://acme-pest.knockjockey.com");
      expect(allowedCanvassOrigin("https://a.b.knockjockey.com", list)).toBe("https://a.b.knockjockey.com");
    });
    it("rejects lookalike hosts that a naive endsWith would allow", () => {
      expect(allowedCanvassOrigin("https://knockjockey.com.evil.com", list)).toBeNull();
      expect(allowedCanvassOrigin("https://evilknockjockey.com", list)).toBeNull();
      expect(allowedCanvassOrigin("https://evil.com#.knockjockey.com", list)).toBeNull();
      expect(allowedCanvassOrigin("https://evil.com/.knockjockey.com", list)).toBeNull();
      expect(allowedCanvassOrigin("https://user@evil.com", list)).toBeNull();
    });
    it("rejects the apex, wrong scheme, and ports", () => {
      expect(allowedCanvassOrigin("https://knockjockey.com", list)).toBeNull();
      expect(allowedCanvassOrigin("http://pestkee.knockjockey.com", list)).toBeNull();
      expect(allowedCanvassOrigin("https://pestkee.knockjockey.com:8443", list)).toBeNull();
    });
    it("still honours exact entries alongside a wildcard", () => {
      const mixed = "https://app.example.com, https://*.knockjockey.com";
      expect(allowedCanvassOrigin("https://app.example.com", mixed)).toBe("https://app.example.com");
      expect(allowedCanvassOrigin("https://x.knockjockey.com", mixed)).toBe("https://x.knockjockey.com");
      expect(allowedCanvassOrigin("https://nope.com", mixed)).toBeNull();
    });
  });
});

describe("canvass rep auth schemas", () => {
  it("accepts a valid rep-create payload", () => {
    const p = canvassRepCreateObject.parse({ name: "Alex R", pin: "4821" });
    expect(p.name).toBe("Alex R");
  });

  it("accepts an optional photo data-URL on create", () => {
    const r = canvassRepCreateObject.safeParse({ name: "Josh W", pin: "123456", photoUrl: "data:image/png;base64,iVBOR" });
    expect(r.success).toBe(true);
  });

  it("rejects PINs that are not 4–6 digits", () => {
    for (const pin of ["123", "1234567", "12a4", ""]) {
      expect(canvassLoginObject.safeParse({ name: "Alex R", pin }).success).toBe(false);
    }
  });

  it("accepts a valid login payload", () => {
    expect(canvassLoginObject.safeParse({ name: "Alex R", pin: "0000" }).success).toBe(true);
  });
});

describe("haversineMeters + knock schema", () => {
  it("is 0 for the same point", () => {
    expect(haversineMeters(33.4, -111.8, 33.4, -111.8)).toBe(0);
  });

  it("computes ~111 m for 0.001° of latitude", () => {
    const d = haversineMeters(33.4, -111.8, 33.401, -111.8);
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(120);
  });

  it("flags a door marked far from the rep", () => {
    const d = haversineMeters(33.4, -111.8, 33.42, -111.8); // ~2.2 km
    expect(d).toBeGreaterThan(CANVASS_GPS_FLAG_METERS);
  });

  it("accepts a valid knock and rejects a bad outcome", () => {
    expect(canvassKnockObject.safeParse({ clientId: "k1", lat: 33.4, lng: -111.8, outcome: "sale", amount: 5000 }).success).toBe(true);
    expect(canvassKnockObject.safeParse({ clientId: "k1", lat: 33.4, lng: -111.8, outcome: "nope" }).success).toBe(false);
  });
});
