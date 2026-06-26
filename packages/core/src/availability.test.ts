import { describe, it, expect } from "vitest";
import { repsFreeAt } from "./availability";

describe("repsFreeAt", () => {
  const requested = { startsAt: new Date("2026-06-25T23:00:00Z"), endsAt: new Date("2026-06-26T00:00:00Z") }; // "today 4pm" local

  it("returns reps with no overlapping busy interval", () => {
    const free = repsFreeAt({
      requested,
      reps: [
        { userId: "a", busy: [{ startsAt: new Date("2026-06-25T23:30:00Z"), endsAt: new Date("2026-06-26T00:30:00Z") }] }, // overlaps
        { userId: "b", busy: [{ startsAt: new Date("2026-06-25T20:00:00Z"), endsAt: new Date("2026-06-25T21:00:00Z") }] }, // clear
        { userId: "c", busy: [] }, // wide open
      ],
    });
    expect(free).toEqual(["b", "c"]);
  });

  it("treats edge-touching intervals as free (end == start)", () => {
    const free = repsFreeAt({
      requested,
      reps: [{ userId: "a", busy: [{ startsAt: new Date("2026-06-25T22:00:00Z"), endsAt: new Date("2026-06-25T23:00:00Z") }] }],
    });
    expect(free).toEqual(["a"]);
  });
});
