import { describe, it, expect } from "vitest";
import { governTouchRequest, TOUCH_PRIORITY, type TouchRequest, type ExistingTouch } from "./touch-governor";

const NOW = new Date("2026-07-14T18:00:00Z");

function touch(program: string, monthsAgo: number, status: "sent" | "scheduled" = "sent"): ExistingTouch {
  const at = new Date(NOW.getTime() - monthsAgo * 30.44 * 86_400_000);
  return { program, channel: "text", scheduledFor: at, sentAt: status === "sent" ? at : null };
}

const req = (program: string, channel = "text"): TouchRequest => ({
  program, channel, scheduledFor: new Date(NOW.getTime() + 86_400_000),
});

describe("the touch governor — a customer is a relationship, not a mailing list", () => {
  it("admits touches under the rolling-year cap", () => {
    const verdict = governTouchRequest(req("roofiversary"), [touch("holiday_card", 6), touch("credit_checkin", 3)], { capPerYear: 5, optOuts: {} }, NOW);
    expect(verdict).toEqual({ admit: true });
  });

  it("RED PATH: the 6th touch in a rolling year is refused with a logged reason", () => {
    const existing = [1, 3, 5, 7, 9].map((m) => touch("holiday_card", m));
    const verdict = governTouchRequest(req("maintenance_offer"), existing, { capPerYear: 5, optOuts: {} }, NOW);
    expect(verdict).toMatchObject({ admit: false, reason: "cap_exceeded" });
  });

  it("touches older than a year fall out of the cap window", () => {
    const existing = [13, 14, 15, 16, 17].map((m) => touch("holiday_card", m));
    const verdict = governTouchRequest(req("roofiversary"), existing, { capPerYear: 5, optOuts: {} }, NOW);
    expect(verdict).toEqual({ admit: true });
  });

  it("PRIORITY: a storm_check at the cap displaces the lowest-priority SCHEDULED touch", () => {
    const existing = [
      ...[1, 3, 5, 7].map((m) => touch("credit_checkin", m)),
      touch("holiday_card", -0.5, "scheduled"), // scheduled 2 weeks out
    ];
    const verdict = governTouchRequest(req("storm_check"), existing, { capPerYear: 5, optOuts: {} }, NOW);
    expect(verdict).toMatchObject({ admit: true, displace: { program: "holiday_card" } });
  });

  it("PRIORITY holds in both directions: a holiday_card never displaces anything", () => {
    const existing = [
      ...[1, 3, 5, 7].map((m) => touch("credit_checkin", m)),
      touch("storm_check", -0.5, "scheduled"),
    ];
    const verdict = governTouchRequest(req("holiday_card"), existing, { capPerYear: 5, optOuts: {} }, NOW);
    expect(verdict).toMatchObject({ admit: false, reason: "cap_exceeded" });
  });

  it("SENT touches are history — displacement only ever touches the schedule", () => {
    const existing = [1, 2, 3, 4, 5].map((m) => touch("holiday_card", m, "sent"));
    const verdict = governTouchRequest(req("storm_check"), existing, { capPerYear: 5, optOuts: {} }, NOW);
    // Nothing scheduled to displace — the high-priority touch still admits OVER cap
    // (storm checks are the reason the program exists).
    expect(verdict).toEqual({ admit: true });
  });

  it("channel opt-out is global and instant across programs", () => {
    const verdict = governTouchRequest(req("roofiversary", "postcard"), [], { capPerYear: 5, optOuts: { postcard: true } }, NOW);
    expect(verdict).toMatchObject({ admit: false, reason: "opt_out" });
  });

  it("the priority ladder matches the owner's order", () => {
    // CFL's six keep their relative order; Phase 26 S5 slots the fill plays
    // between move_play and the standing cadence.
    expect([...TOUCH_PRIORITY]).toEqual([
      "storm_check", "credit_checkin", "move_play",
      "fill_discount", "fill_repair",
      "roofiversary", "holiday_card",
      "maintenance_renewal", "maintenance_offer", "maintenance_winback",
    ]);
  });
});

describe("Phase 26 S5 — fill plays ride the governor as first-class programs", () => {
  it("ranks fill plays below the safety programs and above the standing cadence", () => {
    const order = TOUCH_PRIORITY as readonly string[];
    expect(order.indexOf("fill_discount")).toBeGreaterThan(order.indexOf("move_play"));
    expect(order.indexOf("fill_repair")).toBeGreaterThan(order.indexOf("fill_discount"));
    expect(order.indexOf("fill_repair")).toBeLessThan(order.indexOf("roofiversary"));
  });

  it("a fill play at cap displaces a scheduled lower-priority standing touch", () => {
    const existing = [
      touch("roofiversary", 1), touch("holiday_card", 3), touch("credit_checkin", 5), touch("storm_check", 7),
      touch("maintenance_offer", 0, "scheduled"),
    ];
    const verdict = governTouchRequest(req("fill_discount"), existing, { capPerYear: 5, optOuts: {} }, NOW);
    expect(verdict).toMatchObject({ admit: true, displace: { program: "maintenance_offer" } });
  });

  it("a fill play at cap with nothing displaceable refuses — it is not safety-critical", () => {
    const existing = [
      touch("roofiversary", 1), touch("holiday_card", 3), touch("credit_checkin", 5),
      touch("storm_check", 7), touch("maintenance_offer", 9),
    ];
    const verdict = governTouchRequest(req("fill_discount"), existing, { capPerYear: 5, optOuts: {} }, NOW);
    expect(verdict.admit).toBe(false);
  });
});
