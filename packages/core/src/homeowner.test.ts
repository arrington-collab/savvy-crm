import { describe, it, expect } from "vitest";
import { parseHomeownerConfig, homeownerStageCopy, buildHomeownerJourney, buildCrewDayTouches } from "./homeowner";
import { hourInTimeZone } from "./tz";

describe("parseHomeownerConfig", () => {
  it("defaults", () => {
    const c = parseHomeownerConfig(undefined);
    expect(c.enabled).toBe(true);
    expect(c.notifyStages).toEqual(["approved", "production", "complete"]);
    expect(c.quietHours).toEqual({ startHour: 21, endHour: 8 });
    expect(c.crewJourney.eveBeforeHour).toBe(18);
    expect(c.crewJourney.dayOfHour).toBe(7);
    expect(c.crewJourney.eveBeforeCopy.length).toBeGreaterThan(0);
    expect(c.crewJourney.dayOfCopy.length).toBeGreaterThan(0);
  });
  it("filters invalid stages + merges + accepts overrides", () => {
    const c = parseHomeownerConfig({
      notifyStages: ["production", "nonsense", "complete"],
      enabled: false,
      quietHours: { startHour: 22, endHour: 7 },
      crewJourney: { eveBeforeHour: 17, eveBeforeCopy: "custom eve" },
    });
    expect(c.enabled).toBe(false);
    expect(c.notifyStages).toEqual(["production", "complete"]);
    expect(c.quietHours).toEqual({ startHour: 22, endHour: 7 });
    expect(c.crewJourney.eveBeforeHour).toBe(17);
    expect(c.crewJourney.eveBeforeCopy).toBe("custom eve");
    expect(c.crewJourney.dayOfHour).toBe(7); // unspecified → default
  });
});

describe("buildCrewDayTouches", () => {
  const tz = "America/Phoenix"; // UTC-7, no DST
  // Install at 08:00 Phoenix on 2026-07-20.
  const install = new Date("2026-07-20T15:00:00Z");

  it("returns the evening-before-prep and day-of-morning touches, quiet-hours-safe", () => {
    const cfg = parseHomeownerConfig(undefined);
    const touches = buildCrewDayTouches(install, tz, cfg, new Date("2026-07-01T00:00:00Z"));
    expect(touches.map((t) => t.key)).toEqual(["eve_before", "day_of"]);
    // eve_before fires at 18:00 local the day before (not in quiet hours).
    expect(hourInTimeZone(touches[0]!.fireAt, tz)).toBe(18);
    // day_of default hour 7 is inside quiet hours (21→8) → pushed to 08:00 local.
    expect(hourInTimeZone(touches[1]!.fireAt, tz)).toBe(8);
    // ordered soonest-first
    expect(touches[0]!.fireAt.getTime()).toBeLessThan(touches[1]!.fireAt.getTime());
    // prep instructions in the evening-before copy
    expect(touches[0]!.body.toLowerCase()).toContain("attic");
    expect(touches[0]!.body.toLowerCase()).toContain("pets");
  });

  it("drops touches whose fire time has already passed", () => {
    const cfg = parseHomeownerConfig(undefined);
    // now is after the eve_before (2026-07-20T01:00Z) but before day_of (2026-07-20T15:00Z)
    const touches = buildCrewDayTouches(install, tz, cfg, new Date("2026-07-20T05:00:00Z"));
    expect(touches.map((t) => t.key)).toEqual(["day_of"]);
  });
});

describe("homeownerStageCopy", () => {
  it("has headline+body for every stage", () => {
    for (const s of ["lead","inspected","estimate","approved","production","closeout","billing","complete","lost"] as const) {
      const c = homeownerStageCopy(s);
      expect(c.headline.length).toBeGreaterThan(0);
      expect(c.body.length).toBeGreaterThan(0);
    }
    expect(homeownerStageCopy("approved").headline).toContain("approved");
  });
});

describe("buildHomeownerJourney", () => {
  it("marks done/current/upcoming by stage position", () => {
    const j = buildHomeownerJourney("approved");
    const by = Object.fromEntries(j.map((m) => [m.key, m.status]));
    expect(by.inspected).toBe("done");
    expect(by.estimate).toBe("done");
    expect(by.approved).toBe("current");
    expect(by.production).toBe("upcoming");
    expect(by.complete).toBe("upcoming");
    expect(j.map((m) => m.key)).toEqual(["inspected","estimate","approved","production","closeout","complete"]);
  });
});
