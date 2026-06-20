import { describe, expect, it } from "vitest";
import { toCivilDate, addDays, addWeeks, addMonths, weekDays, buildWeekView, buildMonthView, buildCrewView, minutesFromOffset, type ScheduleAppt } from "./schedule-view.js";

const TZ = "America/Phoenix"; // UTC-7, no DST

function appt(p: Partial<ScheduleAppt> & { id: string; startsAt: string; endsAt: string }): ScheduleAppt {
  return { type: "inspection", status: "scheduled", assigneeUserId: null, assigneeName: null, customerName: "C", address: "A", jobId: "j", jobType: "retail", city: "Mesa", ...p };
}

describe("toCivilDate", () => {
  it("converts a UTC instant to the civil date in the tz", () => {
    expect(toCivilDate("2026-06-19T03:00:00Z", TZ)).toBe("2026-06-18");
  });
});

describe("civil date nav", () => {
  it("addDays crosses month boundary", () => expect(addDays("2026-06-30", 1)).toBe("2026-07-01"));
  it("addWeeks", () => expect(addWeeks("2026-06-19", 1)).toBe("2026-06-26"));
  it("addMonths normalizes", () => expect(addMonths("2026-01-31", 1)).toBe("2026-03-03"));
});

describe("weekDays", () => {
  it("returns 7 Sunday-start dates for any anchor in the week", () => {
    expect(weekDays("2026-06-19")).toEqual([
      "2026-06-14","2026-06-15","2026-06-16","2026-06-17","2026-06-18","2026-06-19","2026-06-20",
    ]);
  });
});

describe("buildWeekView", () => {
  it("buckets an appt to its civil day and positions it within 6a-8p", () => {
    const v = buildWeekView([appt({ id: "x", startsAt: "2026-06-17T16:00:00Z", endsAt: "2026-06-17T17:00:00Z" })], "2026-06-19", TZ);
    const wed = v.days.find((d) => d.date === "2026-06-17")!;
    expect(wed.blocks).toHaveLength(1);
    const b = wed.blocks[0]!;
    expect(b.topPct).toBeCloseTo(21.4, 0);
    expect(b.heightPct).toBeCloseTo(7.1, 0);
    expect(b.tone).toBeTruthy();
  });
  it("clamps an appt that starts before 6am to the top", () => {
    const v = buildWeekView([appt({ id: "y", startsAt: "2026-06-17T11:00:00Z", endsAt: "2026-06-17T14:00:00Z" })], "2026-06-19", TZ);
    expect(v.days.find((d) => d.date === "2026-06-17")!.blocks[0]!.topPct).toBe(0);
  });
  it("splits two overlapping appts into lanes", () => {
    const v = buildWeekView([
      appt({ id: "a", startsAt: "2026-06-17T16:00:00Z", endsAt: "2026-06-17T18:00:00Z" }),
      appt({ id: "b", startsAt: "2026-06-17T17:00:00Z", endsAt: "2026-06-17T19:00:00Z" }),
    ], "2026-06-19", TZ);
    const blocks = v.days.find((d) => d.date === "2026-06-17")!.blocks;
    expect(blocks).toHaveLength(2);
    expect(Math.max(...blocks.map((b) => b.lanes))).toBe(2);
    expect(new Set(blocks.map((b) => b.lane)).size).toBe(2);
  });
});

describe("buildMonthView", () => {
  it("returns a 6x7 grid covering the anchor month with outside-month flags", () => {
    const v = buildMonthView([], "2026-06-15", TZ);
    expect(v.weeks).toHaveLength(6);
    expect(v.weeks[0]).toHaveLength(7);
    const firstOfJune = v.weeks.flat().find((c) => c.date === "2026-06-01")!;
    expect(firstOfJune.outside).toBe(false);
    expect(v.weeks[0]![0]!.date).toBe("2026-05-31");
    expect(v.weeks[0]![0]!.outside).toBe(true);
  });
  it("places an appointment chip on its civil day", () => {
    const a = appt({ id: "m", startsAt: "2026-06-17T16:00:00Z", endsAt: "2026-06-17T17:00:00Z" });
    const v = buildMonthView([a], "2026-06-15", TZ);
    expect(v.weeks.flat().find((c) => c.date === "2026-06-17")!.chips.map((x) => x.id)).toContain("m");
  });
});

describe("buildCrewView", () => {
  it("groups the week's appts into one column per crew member + Unassigned", () => {
    const crew = [{ id: "u1", name: "Mike" }, { id: "u2", name: "Sara" }];
    const v = buildCrewView([
      appt({ id: "p", assigneeUserId: "u1", startsAt: "2026-06-17T16:00:00Z", endsAt: "2026-06-17T17:00:00Z" }),
      appt({ id: "q", assigneeUserId: null, startsAt: "2026-06-18T16:00:00Z", endsAt: "2026-06-18T17:00:00Z" }),
    ], "2026-06-19", TZ, crew);
    const mike = v.columns.find((c) => c.userId === "u1")!;
    expect(mike.appts.map((a) => a.id)).toContain("p");
    const unassigned = v.columns.find((c) => c.userId === null)!;
    expect(unassigned.appts.map((a) => a.id)).toContain("q");
  });
});

import { zonedTimeToUtc, applyDragToWeek, applyDragToMonth } from "./schedule-view.js";

describe("zonedTimeToUtc", () => {
  it("round-trips a Phoenix wall time", () => {
    const iso = zonedTimeToUtc("2026-06-17", 540, TZ); // 09:00 Phoenix
    expect(iso).toBe("2026-06-17T16:00:00.000Z");
    expect(toCivilDate(iso, TZ)).toBe("2026-06-17");
  });
  it("round-trips a New York (DST) wall time", () => {
    const ny = "America/New_York"; // UTC-4 in June
    const iso = zonedTimeToUtc("2026-06-17", 540, ny); // 09:00 EDT
    expect(iso).toBe("2026-06-17T13:00:00.000Z");
    expect(toCivilDate(iso, ny)).toBe("2026-06-17");
  });
});

describe("applyDragToWeek", () => {
  const base = { startsAt: "2026-06-17T16:00:00Z", endsAt: "2026-06-17T17:00:00Z" }; // 09:00-10:00 Phoenix, 1h
  it("shifts time by the vertical delta (snapped), same day, keeps duration", () => {
    // 80px / 560px * 840min = 120min -> 09:00 + 2h = 11:00 Phoenix = 18:00Z
    const r = applyDragToWeek(base, 80, 560, "2026-06-17", TZ);
    expect(r.startsAt).toBe("2026-06-17T18:00:00.000Z");
    expect(r.endsAt).toBe("2026-06-17T19:00:00.000Z");
  });
  it("moves to a new day when dropped on another column (delta 0)", () => {
    const r = applyDragToWeek(base, 0, 560, "2026-06-19", TZ);
    expect(toCivilDate(r.startsAt, TZ)).toBe("2026-06-19");
    expect(r.startsAt).toBe("2026-06-19T16:00:00.000Z"); // still 09:00 Phoenix
  });
  it("clamps above the 6am window edge", () => {
    const r = applyDragToWeek(base, -1000, 560, "2026-06-17", TZ); // drag far up
    expect(r.startsAt).toBe("2026-06-17T13:00:00.000Z"); // 06:00 Phoenix
  });
});

describe("applyDragToMonth", () => {
  it("changes the day, keeps the time-of-day", () => {
    const r = applyDragToMonth({ startsAt: "2026-06-17T16:00:00Z", endsAt: "2026-06-17T17:00:00Z" }, "2026-06-20", TZ);
    expect(r.startsAt).toBe("2026-06-20T16:00:00.000Z");
    expect(r.endsAt).toBe("2026-06-20T17:00:00.000Z");
  });
});

describe("minutesFromOffset", () => {
  // 6a–8p window = 360..1200 min over a 560px column.
  it("maps the very top to 6:00 (360)", () => {
    expect(minutesFromOffset(0, 560)).toBe(360);
  });
  it("snaps to the nearest 30 minutes", () => {
    // 280/560 = 50% → 360 + 0.5*840 = 780 (1:00pm), already a multiple of 30
    expect(minutesFromOffset(280, 560)).toBe(780);
    // a hair above the 11:00 line should snap back to 11:00 (660)
    expect(minutesFromOffset(205, 560)).toBe(660);
  });
  it("clamps the bottom so a 30-min appt still fits (max 19:30 = 1170)", () => {
    expect(minutesFromOffset(560, 560)).toBe(1170);
    expect(minutesFromOffset(99999, 560)).toBe(1170);
  });
  it("clamps negative offsets to the top", () => {
    expect(minutesFromOffset(-50, 560)).toBe(360);
  });
});
