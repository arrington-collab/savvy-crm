import { describe, it, expect } from "vitest";
import { buildDeliveryTouches } from "./delivery-touches";
import { parseHomeownerConfig } from "./homeowner";

const TZ = "America/Phoenix";
const cfg = parseHomeownerConfig({});

describe("buildDeliveryTouches — delivery day is NOT build day, twice", () => {
  it("emits the 3-day-out and eve-before touches, both carrying the delivery≠build language", () => {
    const now = new Date("2026-07-14T15:00:00Z");
    const deliveryAt = new Date("2026-07-20T16:00:00Z");
    const buildStartsAt = new Date("2026-07-22T14:00:00Z");
    const touches = buildDeliveryTouches(deliveryAt, buildStartsAt, TZ, cfg, now);

    expect(touches.map((t) => t.kind)).toEqual(["delivery_3day", "delivery_eve"]);
    for (const t of touches) {
      expect(t.body.toLowerCase()).toContain("just the delivery");
      expect(t.body.toLowerCase()).toContain("crew starts");
      expect(t.body.toLowerCase()).toMatch(/driveway|place it somewhere/);
      expect(t.fireAt.getTime()).toBeGreaterThan(now.getTime());
    }
    expect(touches[0]!.fireAt.getTime()).toBeLessThan(touches[1]!.fireAt.getTime());
    // build date merged in plain words
    expect(touches[0]!.body).toMatch(/Jul|July/);
  });

  it("inside 3 days: only the eve-before touch remains", () => {
    const now = new Date("2026-07-19T15:00:00Z");
    const deliveryAt = new Date("2026-07-20T16:00:00Z");
    const touches = buildDeliveryTouches(deliveryAt, null, TZ, cfg, now);
    expect(touches.map((t) => t.kind)).toEqual(["delivery_eve"]);
    // no build date known → honest phrasing, still delivery≠build
    expect(touches[0]!.body.toLowerCase()).toContain("just the delivery");
    expect(touches[0]!.body.toLowerCase()).toContain("we'll confirm your build date");
  });

  it("past deliveries emit nothing", () => {
    const now = new Date("2026-07-21T15:00:00Z");
    expect(buildDeliveryTouches(new Date("2026-07-20T16:00:00Z"), null, TZ, cfg, now)).toEqual([]);
  });
});
