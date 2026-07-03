import { describe, it, expect } from "vitest";
import { parseHomeownerConfig, homeownerStageCopy, buildHomeownerJourney, buildCrewDayTouches, buildDeliveryEveTouch } from "./homeowner";
import { hourInTimeZone } from "./tz";

describe("parseHomeownerConfig", () => {
  it("defaults", () => {
    const c = parseHomeownerConfig(undefined);
    expect(c.enabled).toBe(true);
    expect(c.notifyStages).toEqual(["approved", "production", "complete"]);
    expect(c.quietHours).toEqual({ startHour: 21, endHour: 8 });
    expect(c.crewJourney.eveBeforeHour).toBe(18);
    expect(c.crewJourney.dayOfHour).toBe(7);
    expect(c.crewJourney.midDayHour).toBe(12);
    expect(c.crewJourney.deliveryEveHour).toBe(18);
    expect(c.crewJourney.eveBeforeCopy.length).toBeGreaterThan(0);
    expect(c.crewJourney.dayOfCopy.length).toBeGreaterThan(0);
    expect(c.crewJourney.midDayCopy.length).toBeGreaterThan(0);
    expect(c.crewJourney.deliveryEveCopy.length).toBeGreaterThan(0);
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
    expect(touches.map((t) => t.key)).toEqual(["eve_before", "day_of", "mid_day"]);
    // eve_before fires at 18:00 local the day before (not in quiet hours).
    expect(hourInTimeZone(touches[0]!.fireAt, tz)).toBe(18);
    // day_of default hour 7 is inside quiet hours (21→8) → pushed to 08:00 local.
    expect(hourInTimeZone(touches[1]!.fireAt, tz)).toBe(8);
    // mid_day fires at 12:00 local on install day.
    expect(hourInTimeZone(touches[2]!.fireAt, tz)).toBe(12);
    // ordered soonest-first
    expect(touches[0]!.fireAt.getTime()).toBeLessThan(touches[1]!.fireAt.getTime());
    expect(touches[1]!.fireAt.getTime()).toBeLessThan(touches[2]!.fireAt.getTime());
    // prep instructions in the evening-before copy
    expect(touches[0]!.body.toLowerCase()).toContain("attic");
    expect(touches[0]!.body.toLowerCase()).toContain("pets");
  });

  it("drops touches whose fire time has already passed", () => {
    const cfg = parseHomeownerConfig(undefined);
    // now is after the eve_before (2026-07-20T01:00Z) but before day_of (2026-07-20T15:00Z)
    const touches = buildCrewDayTouches(install, tz, cfg, new Date("2026-07-20T05:00:00Z"));
    expect(touches.map((t) => t.key)).toEqual(["day_of", "mid_day"]);
  });
});

describe("buildDeliveryEveTouch", () => {
  const tz = "America/Phoenix";
  const delivery = new Date("2026-07-20T15:00:00Z"); // delivery target, 08:00 Phoenix on the 20th

  it("schedules an evening-before-delivery text at the local evening hour", () => {
    const cfg = parseHomeownerConfig(undefined);
    const t = buildDeliveryEveTouch(delivery, tz, cfg, new Date("2026-07-01T00:00:00Z"));
    expect(t).not.toBeNull();
    expect(hourInTimeZone(t!.fireAt, tz)).toBe(18); // 18:00 local the evening before
    expect(t!.body.toLowerCase()).toContain("material");
  });

  it("returns null when the evening-before time has already passed", () => {
    const cfg = parseHomeownerConfig(undefined);
    // eve-before is 2026-07-20T01:00Z; now is after it.
    const t = buildDeliveryEveTouch(delivery, tz, cfg, new Date("2026-07-20T05:00:00Z"));
    expect(t).toBeNull();
  });

  it("returns null when there is no delivery date", () => {
    const cfg = parseHomeownerConfig(undefined);
    expect(buildDeliveryEveTouch(null, tz, cfg, new Date("2026-07-01T00:00:00Z"))).toBeNull();
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
