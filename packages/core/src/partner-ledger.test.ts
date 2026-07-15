import { describe, it, expect } from "vitest";
import {
  PARTNER_LEDGER_KINDS,
  parsePartnerLedgerConfig,
  buildPartnerExpenseLine,
  INSPECTION_STANDARD_METHODOLOGY,
} from "./partner-ledger";

describe("parsePartnerLedgerConfig", () => {
  it("defaults the inspection standard cost to $200", () => {
    expect(parsePartnerLedgerConfig(undefined).inspectionStandardCostCents).toBe(20000);
    expect(parsePartnerLedgerConfig(null).inspectionStandardCostCents).toBe(20000);
    expect(parsePartnerLedgerConfig({}).inspectionStandardCostCents).toBe(20000);
  });

  it("honors a tenant override and rejects garbage", () => {
    expect(parsePartnerLedgerConfig({ inspectionStandardCostCents: 15000 }).inspectionStandardCostCents).toBe(15000);
    expect(parsePartnerLedgerConfig({ inspectionStandardCostCents: -5 }).inspectionStandardCostCents).toBe(20000);
    expect(parsePartnerLedgerConfig({ inspectionStandardCostCents: "cheap" }).inspectionStandardCostCents).toBe(20000);
  });

  it("documents the loaded-hours methodology (tooltip copy)", () => {
    expect(INSPECTION_STANDARD_METHODOLOGY).toMatch(/loaded hours/i);
  });
});

describe("partner ledger kinds", () => {
  it("covers the slice-2 accrual kinds (+ cert_cost reserved for slice 4)", () => {
    expect(PARTNER_LEDGER_KINDS).toEqual(["inspection_standard", "free_repair", "referral_fee", "cert_cost", "expense"]);
  });
});

describe("buildPartnerExpenseLine", () => {
  it("is silent when there is nothing to say", () => {
    expect(buildPartnerExpenseLine(0)).toBeNull();
    expect(buildPartnerExpenseLine(-100)).toBeNull();
  });

  it("summarizes the weekly partner-expense sum", () => {
    expect(buildPartnerExpenseLine(12550)).toBe("Partner expenses this week: $125.50");
    expect(buildPartnerExpenseLine(20000)).toBe("Partner expenses this week: $200.00");
  });
});
