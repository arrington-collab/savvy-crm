import { describe, it, expect } from "vitest";
import { formatShortDate, buildWeatherMoveHomeownerBody, buildWeatherMoveCrewBody } from "./weather-notify";

describe("weather-notify", () => {
  it("formats a civil date as 'Wkd M/D'", () => {
    expect(formatShortDate("2026-07-08")).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) 7\/8$/);
  });

  it("builds a homeowner move body with both dates and the reason", () => {
    const body = buildWeatherMoveHomeownerBody({ originalLabel: "Mon 7/6", targetLabel: "Wed 7/8", reason: "Rain 90%" });
    expect(body).toContain("Mon 7/6");
    expect(body).toContain("Wed 7/8");
    expect(body).toContain("Rain 90%");
  });

  it("builds a crew move body with address and target date", () => {
    const body = buildWeatherMoveCrewBody({ address: "123 Main St", originalLabel: "Mon 7/6", targetLabel: "Wed 7/8", reason: "Rain 90%" });
    expect(body).toContain("123 Main St");
    expect(body).toContain("Wed 7/8");
  });
});
