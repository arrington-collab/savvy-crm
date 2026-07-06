import { describe, expect, it } from "vitest";
import {
  requiredClausesFor,
  isJurisdictionGated,
  isTemplateCompliant,
  resolveCompliantTemplate,
  resolveOrThrowContractTemplate,
  ContractTemplateRequiredError,
  REQUIRED_CLAUSES,
  type TemplateLike,
} from "./contract-compliance";

const CO_CLAUSES = ["right_to_rescind", "no_deductible_waiver", "ten_day"];

const tpl = (over: Partial<TemplateLike> & { id?: string } = {}): TemplateLike & { id: string } => ({
  id: "t1",
  state: "CO",
  version: 1,
  clauses: [...CO_CLAUSES],
  status: "active",
  ...over,
});

describe("requiredClausesFor / isJurisdictionGated", () => {
  it("CO requires the three SB38 clauses", () => {
    expect(requiredClausesFor("CO")).toEqual(CO_CLAUSES);
    expect(isJurisdictionGated("CO")).toBe(true);
  });

  it("normalizes case and whitespace", () => {
    expect(isJurisdictionGated(" co ")).toBe(true);
    expect(requiredClausesFor("co").length).toBe(3);
  });

  it("un-gated states (AZ) and blank/null jurisdictions require nothing", () => {
    expect(requiredClausesFor("AZ")).toEqual([]);
    expect(isJurisdictionGated("AZ")).toBe(false);
    expect(isJurisdictionGated("")).toBe(false);
    expect(isJurisdictionGated(null)).toBe(false);
    expect(isJurisdictionGated(undefined)).toBe(false);
  });

  it("no-deductible-waiver (C.R.S. 6-22-105) and ten_day are part of the CO set", () => {
    expect(REQUIRED_CLAUSES.CO).toContain("no_deductible_waiver");
    expect(REQUIRED_CLAUSES.CO).toContain("ten_day");
  });
});

describe("isTemplateCompliant", () => {
  it("active CO template with all three clauses is compliant", () => {
    expect(isTemplateCompliant(tpl(), "CO")).toBe(true);
  });

  it("missing any required clause is non-compliant", () => {
    expect(isTemplateCompliant(tpl({ clauses: ["right_to_rescind", "ten_day"] }), "CO")).toBe(false);
  });

  it("draft or retired is non-compliant even with all clauses", () => {
    expect(isTemplateCompliant(tpl({ status: "draft" }), "CO")).toBe(false);
    expect(isTemplateCompliant(tpl({ status: "retired" }), "CO")).toBe(false);
  });
});

describe("resolveCompliantTemplate", () => {
  it("returns the highest-version compliant template for the state", () => {
    const templates = [tpl({ id: "v1", version: 1 }), tpl({ id: "v3", version: 3 }), tpl({ id: "v2", version: 2 })];
    expect(resolveCompliantTemplate(templates, "CO")?.id).toBe("v3");
  });

  it("ignores non-compliant higher versions and other states", () => {
    const templates = [
      tpl({ id: "v1", version: 1 }),
      tpl({ id: "v2-bad", version: 2, status: "retired" }),
      tpl({ id: "az", version: 9, state: "AZ" }),
    ];
    expect(resolveCompliantTemplate(templates, "CO")?.id).toBe("v1");
  });

  it("returns null when no compliant template exists", () => {
    expect(resolveCompliantTemplate([tpl({ status: "draft" })], "CO")).toBeNull();
    expect(resolveCompliantTemplate([], "CO")).toBeNull();
  });
});

describe("resolveOrThrowContractTemplate (the gate decision)", () => {
  it("returns null for an un-gated jurisdiction (no gate, no stamp)", () => {
    expect(resolveOrThrowContractTemplate([], "AZ")).toBeNull();
    expect(resolveOrThrowContractTemplate([], null)).toBeNull();
    expect(resolveOrThrowContractTemplate([], "")).toBeNull();
  });

  it("returns the compliant template id to stamp for a gated jurisdiction", () => {
    expect(resolveOrThrowContractTemplate([tpl({ id: "co-v1" })], "CO")).toBe("co-v1");
  });

  it("throws ContractTemplateRequiredError when gated but no compliant template", () => {
    expect(() => resolveOrThrowContractTemplate([tpl({ status: "draft" })], "CO")).toThrow(
      ContractTemplateRequiredError,
    );
    expect(() => resolveOrThrowContractTemplate([], "CO")).toThrow(/CO/);
  });
});
