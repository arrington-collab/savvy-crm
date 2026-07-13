import { describe, it, expect } from "vitest";
import { isHotSignal, raceAllowed, raceMetrics, type RaceEvent } from "./estimate-race";

const ev = (kind: string, minsAgo: number, sessionId = "s1"): RaceEvent => ({
  kind,
  sessionId,
  createdAt: new Date(Date.now() - minsAgo * 60_000),
});

describe("isHotSignal", () => {
  it("first open is hot", () => {
    expect(isHotSignal([], "s1")).toBe(true);
  });
  it("a re-open in the same browsing session is NOT hot", () => {
    expect(isHotSignal([ev("open", 5, "s1")], "s1")).toBe(false);
  });
  it("a return visit (new session after 30+ minutes) is hot", () => {
    expect(isHotSignal([ev("open", 45, "s1")], "s2")).toBe(true);
  });
  it("rapid-fire opens from a different tab (new session, <30min) are NOT hot", () => {
    expect(isHotSignal([ev("open", 3, "s1")], "s2")).toBe(false);
  });
});

describe("raceAllowed", () => {
  it("allows the first race, blocks a second in the same session", () => {
    expect(raceAllowed([], "s1")).toBe(true);
    expect(raceAllowed([ev("race_rep_notified", 2, "s1")], "s1")).toBe(false);
  });
  it("blocks more than one race per customer per day, across sessions", () => {
    expect(raceAllowed([ev("race_rep_notified", 120, "s1")], "s2")).toBe(false);
  });
  it("allows again the next day", () => {
    expect(raceAllowed([ev("race_rep_notified", 26 * 60, "s1")], "s2")).toBe(true);
  });
});

describe("raceMetrics", () => {
  it("computes 60s rep response rate and splits close rate by who answered", () => {
    const estimates = [
      // rep acked in 40s, estimate accepted
      { events: [ev("race_rep_notified", 100), { ...ev("race_rep_ack", 100), createdAt: new Date(ev("race_rep_notified", 100).createdAt.getTime() + 40_000) }], accepted: true },
      // rep missed → nova text, not accepted
      { events: [ev("race_rep_notified", 90), ev("race_nova_text", 88)], accepted: false },
      // rep missed → nova text, accepted anyway
      { events: [ev("race_rep_notified", 80), ev("race_nova_text", 78)], accepted: true },
    ];
    const m = raceMetrics(estimates);
    expect(m.races).toBe(3);
    expect(m.repAcked).toBe(1);
    expect(m.repAckRateBps).toBe(3333);
    expect(m.repAckedCloseRateBps).toBe(10_000); // 1/1
    expect(m.novaTextedCloseRateBps).toBe(5000); // 1/2
  });
});
