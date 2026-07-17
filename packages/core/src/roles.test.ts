import { describe, expect, it } from "vitest";
import { canApproveMoney, canManageSettings, visibleExceptionsFor, OWNER_TIER_KINDS } from "./roles";
import type { ExceptionItem } from "./exception-queue";

function item(kind: string): ExceptionItem {
  return { kind: kind as ExceptionItem["kind"], severity: "high", title: kind, detail: "", href: "/x", occurredAt: null };
}

describe("role capabilities (approved matrix, Phase 26 S6)", () => {
  it("money approvals are owner/admin only", () => {
    expect(canApproveMoney("owner")).toBe(true);
    expect(canApproveMoney("admin")).toBe(true);
    expect(canApproveMoney("office")).toBe(false);
    expect(canApproveMoney("rep")).toBe(false);
    expect(canApproveMoney("crew")).toBe(false);
  });

  it("settings are owner/admin only (Savvy role, not Clerk)", () => {
    expect(canManageSettings("owner")).toBe(true);
    expect(canManageSettings("admin")).toBe(true);
    expect(canManageSettings("office")).toBe(false);
    expect(canManageSettings("rep")).toBe(false);
  });
});

describe("SPEC RED PATH: owner-tier cards never render for office", () => {
  const mixed = [
    item("appointment_missed"),           // office duty: scheduling
    item("invoice_overdue"),              // office duty: collections call
    item("task_needs_approval"),          // owner-tier: money approval
    item("margin_outlier"),               // owner-tier: money
    item("supplier_credit_review"),       // owner-tier: ledger
    item("stage_evidence"),               // any: document chasing
  ];

  it("office sees coordination cards only — zero owner-tier kinds survive", () => {
    const seen = visibleExceptionsFor("office", mixed);
    expect(seen.map((i) => i.kind)).toEqual(["appointment_missed", "invoice_overdue", "stage_evidence"]);
    expect(seen.some((i) => OWNER_TIER_KINDS.has(i.kind))).toBe(false);
  });

  it("owner, admin, and rep see everything (additive-only: nobody loses access)", () => {
    for (const role of ["owner", "admin", "rep"]) {
      expect(visibleExceptionsFor(role, mixed)).toHaveLength(mixed.length);
    }
  });

  it("a NEW card kind defaults to office-visible (deny-by-flag, not allow-by-list)", () => {
    const seen = visibleExceptionsFor("office", [item("some_future_kind")]);
    expect(seen).toHaveLength(1);
  });
});

describe("Owner's Room S3 — valuation cards are owner-tier", () => {
  it("office never sees valuation cards", () => {
    const seen = visibleExceptionsFor("office", [item("valuation_move"), item("valuation_input_degraded"), item("appointment_missed")]);
    expect(seen.map((i) => i.kind)).toEqual(["appointment_missed"]);
  });
});
