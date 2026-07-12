import { describe, it, expect } from "vitest";
import { heartbeatState, mergeLastTouch } from "./heartbeat";

const now = new Date("2026-07-11T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000);

describe("heartbeatState", () => {
  it("never touched, created recently → 'no activity yet', not cold", () => {
    expect(heartbeatState(null, daysAgo(2), now, 7)).toEqual({ hasActivity: false, label: "no activity yet", cold: false });
  });

  it("never touched, created long ago → 'no activity yet', COLD", () => {
    expect(heartbeatState(null, daysAgo(9), now, 7)).toEqual({ hasActivity: false, label: "no activity yet", cold: true });
  });

  it("recently touched → relative label, not cold", () => {
    expect(heartbeatState(hoursAgo(3), daysAgo(30), now, 7)).toEqual({ hasActivity: true, label: "3h ago", cold: false });
  });

  it("touched long ago → relative label in days, COLD", () => {
    expect(heartbeatState(daysAgo(8), daysAgo(30), now, 7)).toEqual({ hasActivity: true, label: "8d ago", cold: true });
  });

  it("just touched → 'just now'", () => {
    expect(heartbeatState(now, daysAgo(1), now, 7).label).toBe("just now");
  });

  it("minutes granularity", () => {
    expect(heartbeatState(new Date(now.getTime() - 5 * 60000), now, now, 7).label).toBe("5m ago");
  });

  it("cold boundary is strict (> coldDays, not >=)", () => {
    expect(heartbeatState(daysAgo(7), now, now, 7).cold).toBe(false); // exactly 7d → not cold
    expect(heartbeatState(new Date(now.getTime() - (7 * 86_400_000 + 1)), now, now, 7).cold).toBe(true);
  });
});

describe("mergeLastTouch", () => {
  it("takes the max ts per id across sources, ignores empties", () => {
    const m = mergeLastTouch([
      [{ id: "a", ts: daysAgo(5) }, { id: "b", ts: daysAgo(1) }],
      [{ id: "a", ts: daysAgo(2) }], // newer for a
      [],
    ]);
    expect(m.get("a")).toEqual(daysAgo(2));
    expect(m.get("b")).toEqual(daysAgo(1));
    expect(m.size).toBe(2);
  });
});
