import { describe, expect, it } from "vitest";
import { findUnresolvedConfigFields, provisionTenant, type TenantProvisionConfig } from "./provision-runbook";

const placeholder: TenantProvisionConfig = {
  name: "Alta Roofing",
  clerkOrgId: "org_REPLACE_WITH_ALTA_CLERK_ORG_ID",
  owner: { clerkUserId: "usr_REPLACE_WITH_OWNER", name: "Alta Owner", email: "owner@REPLACE.example" },
  licenses: [{ state: "CO", authority: "CO SoS", licenseNumber: "REPLACE-CO-STATE" }],
  twilio: { fromNumber: "+1303REPLACE" },
};

const ready: TenantProvisionConfig = {
  name: "Alta Roofing",
  clerkOrgId: "org_2abcAlta",
  owner: { clerkUserId: "usr_2abc", name: "Jane Alta", email: "jane@altaroofing.com" },
  licenses: [{ state: "CO", authority: "CO SoS", licenseNumber: "CO-12345" }],
};

describe("findUnresolvedConfigFields", () => {
  it("flags every field still carrying a REPLACE placeholder", () => {
    const issues = findUnresolvedConfigFields(placeholder);
    expect(issues.some((i) => i.includes("clerkOrgId"))).toBe(true);
    expect(issues.some((i) => i.includes("owner.clerkUserId"))).toBe(true);
    expect(issues.some((i) => i.includes("owner.email"))).toBe(true);
    expect(issues.some((i) => i.includes("licenses[0].licenseNumber"))).toBe(true);
    expect(issues.some((i) => i.includes("twilio.fromNumber"))).toBe(true);
  });

  it("returns no issues for a fully-filled config", () => {
    expect(findUnresolvedConfigFields(ready)).toEqual([]);
  });

  it("catches empty required fields and a malformed owner email", () => {
    const issues = findUnresolvedConfigFields({ ...ready, clerkOrgId: "", owner: { ...ready.owner, email: "not-an-email" }, licenses: [] });
    expect(issues.some((i) => i.includes("clerkOrgId"))).toBe(true);
    expect(issues.some((i) => i.includes("owner.email"))).toBe(true);
    expect(issues.some((i) => i.includes("licenses"))).toBe(true);
  });
});

describe("provisionTenant preflight", () => {
  it("dry-run surfaces placeholders as warnings and writes nothing (never throws)", async () => {
    const res = await provisionTenant(placeholder, {}, { dryRun: true });
    expect(res.dryRun).toBe(true);
    expect((res.warnings ?? []).length).toBeGreaterThan(0);
  });

  it("REFUSES to commit a config with unresolved placeholders (throws before any DB write)", async () => {
    await expect(provisionTenant(placeholder, {}, { dryRun: false })).rejects.toThrow(/unresolved|REPLACE|refus/i);
  });
});
